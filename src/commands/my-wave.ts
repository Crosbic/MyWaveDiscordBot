import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  GuildMember,
  Message,
  TextChannel
} from 'discord.js'
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior,
  StreamType
} from '@discordjs/voice'
import axios from 'axios'
import { DatabaseService } from '../services/database.service.js'
import { IYandexTrackSequenceItem } from '../types/yandexTrack.js'

export const data = new SlashCommandBuilder()
  .setName('my-wave')
  .setDescription('Воспроизвести треки из "Моя волна" в Яндекс Музыке')

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id
  const db = DatabaseService.getInstance()

  // Проверка авторизации пользователя
  if (!db.hasUserToken(userId)) {
    await interaction.reply({
      content: 'Вы не авторизованы! Используйте команду `/login` для входа через Яндекс.',
      ephemeral: true
    })
    return
  }

  const userData = db.getUserData(userId)
  if (!userData) {
    await interaction.reply({
      content:
        'Не удалось получить данные вашего аккаунта. Попробуйте выйти и войти снова с помощью команд `/logout` и `/login`.',
      ephemeral: true
    })
    return
  }

  if (!interaction.guild) {
    await interaction.reply({
      content: 'Эта команда может быть использована только на сервере.',
      ephemeral: true
    })
    return
  }

  // Получаем объект GuildMember
  const member = interaction.member as GuildMember
  console.log(member.voice.channelId)

  if (!member.voice?.channel) {
    // Попытка обновить информацию о пользователе с сервера
    const updatedMember = await interaction.guild.members
      .fetch({
        user: interaction.user.id,
        force: true // Принудительно обновляем данные, игнорируя кэш
      })
      .catch(() => null)

    if (!updatedMember?.voice.channel) {
      await interaction.reply({
        content: 'Вы должны находиться в голосовом канале, чтобы использовать эту команду!',
        ephemeral: true
      })
      return
    }
  }

  // Используем правильный voiceChannel
  const voiceChannel: any =
    member.voice?.channel ||
    (
      await interaction.guild.members.fetch({
        user: interaction.user.id,
        force: true
      })
    ).voice.channel

  // Проверяем права бота в голосовом канале
  const permissions = voiceChannel.permissionsFor(interaction.client.user.id)
  if (!permissions?.has('Connect') || !permissions?.has('Speak')) {
    await interaction.reply({
      content: 'У меня нет прав для подключения или воспроизведения аудио в этом голосовом канале!',
      ephemeral: true
    })
    return
  }

  // Отправляем начальное сообщение
  await interaction.reply({
    content: `Подключаюсь к голосовому каналу "${voiceChannel.name}"...`,
    ephemeral: true
  })

  try {
    // Присоединяемся к голосовому каналу
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guild.id,
      adapterCreator: interaction.guild.voiceAdapterCreator
    })

    // Создаем аудио плеер
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play
      }
    })

    // Подписываем соединение на плеер
    connection.subscribe(player)

    // Ожидаем успешного подключения к каналу
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 5_000)
    } catch (connectionError) {
      connection.destroy()
      await interaction.followUp({
        content: 'Не удалось подключиться к голосовому каналу!',
        ephemeral: true
      })
      return
    }

    // Обработка ошибок соединения
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
        ])
        // Если мы дошли до этой точки, значит соединение пытается восстановиться
      } catch (error) {
        // Если мы дошли до этой точки, соединение не может быть восстановлено
        connection.destroy()
      }
    })

    // Создаем embed для отображения информации о треке
    const embed = new EmbedBuilder()
      .setColor('#FFCC00')
      .setTitle('🎵 Сейчас играет')
      .setDescription('Загрузка трека...')
      .setFooter({ text: 'Яндекс Музыка - Моя волна' })
      .setTimestamp()

    // Проверяем, что канал является текстовым каналом, который поддерживает отправку сообщений
    if (!interaction.channel || !('send' in interaction.channel)) {
      await interaction.followUp({
        content: 'Не удалось отправить информацию о треке в этот канал.',
        ephemeral: true
      })
      return
    }

    // Отправляем embed, который будем обновлять
    const embedMessage = await interaction.channel.send({
      embeds: [embed]
    })

    try {
      const { accessToken } = userData
      const stationId = 'user:onyourwave'

      // 1. Получение информации о станции "Моя волна"
      await getStationInfo(accessToken, stationId)

      // 2. Отправляем фидбэк о начале воспроизведения станции
      await sendStationStartedFeedback(accessToken, stationId)

      // 3. Получаем треки станции
      const tracks = await getStationTracks(accessToken, stationId)
      if (!tracks || tracks.length === 0) {
        connection.destroy()
        await interaction.followUp({
          content: 'Не удалось получить треки из "Моя волна".',
          ephemeral: true
        })
        return
      }

      // Берем первый трек из списка
      const firstTrack = tracks[0]
      const trackInfo = {
        id: firstTrack.id,
        title: firstTrack.title,
        artist: firstTrack.artists.map((artist: { name: string }) => artist.name).join(', '),
        album: firstTrack.albums[0]?.title || 'Неизвестный альбом',
        coverUrl: firstTrack.coverUri ? `https://${firstTrack.coverUri.replace('%%', '400x400')}` : null
      }

      // Отправляем фидбэк о начале воспроизведения трека
      await sendTrackStartedFeedback(accessToken, stationId, trackInfo.id)

      // Получаем URL для стриминга трека
      const streamUrl = await getStreamUrl(accessToken, trackInfo.id)
      if (!streamUrl) {
        connection.destroy()
        await interaction.followUp({
          content: 'Не удалось получить URL для стриминга трека.',
          ephemeral: true
        })
        return
      }

      // Создаем аудио ресурс напрямую из URL
      try {
        console.log('Получен URL для стриминга:', streamUrl)

        // Создаем ресурс напрямую из URL
        const resource = createAudioResource(streamUrl, {
          inputType: StreamType.Arbitrary
        })

        // Воспроизводим аудио
        player.play(resource)

        // Обработка событий плеера
        player.on(AudioPlayerStatus.Playing, () => {
          console.log('Начало воспроизведения трека')
        })

        // Создаем очередь для возможности добавления следующих треков
        const trackQueue = tracks.slice(1) // Исключаем первый трек, который уже играет

        // Обновляем embed с информацией о первом треке
        updateEmbed(embedMessage, trackInfo)

        // Удаляем все предыдущие обработчики события Idle, чтобы избежать дублирования
        player.removeAllListeners(AudioPlayerStatus.Idle)

        // Функция для загрузки новых треков
        const loadMoreTracks = async () => {
          try {
            console.log('Загружаем новые треки для очереди...')
            const newTracks = await getStationTracks(accessToken, stationId)
            if (newTracks && newTracks.length > 0) {
              trackQueue.push(...newTracks)
              console.log(`Добавлено ${newTracks.length} новых треков в очередь`)
              return true
            }
            return false
          } catch (error) {
            console.error('Ошибка при загрузке новых треков:', error)
            return false
          }
        }

        // Функция для обновления embed с информацией о треке
        function updateEmbed(message: Message | undefined, trackInfo: any) {
          if (!message) return

          const updatedEmbed = new EmbedBuilder()
            .setColor('#FFCC00')
            .setTitle('🎵 Сейчас играет')
            .setDescription(`**${trackInfo.title}**\nИсполнитель: ${trackInfo.artist}\nАльбом: ${trackInfo.album}`)
            .setFooter({ text: 'Яндекс Музыка - Моя волна' })
            .setTimestamp()

          if (trackInfo.coverUrl) {
            updatedEmbed.setThumbnail(trackInfo.coverUrl)
          }

          message.edit({ embeds: [updatedEmbed] }).catch((error: Error) => {
            console.error('Ошибка при обновлении embed:', error)
          })
        }

        // Обработчик для воспроизведения следующего трека
        player.on(AudioPlayerStatus.Idle, async () => {
          console.log('Трек закончился, проверяем очередь')
          console.log(`Треков в очереди: ${trackQueue.length}`)

          if (trackQueue.length > 0) {
            // Берем следующий трек из очереди
            const nextTrack = trackQueue.shift()
            if (nextTrack) {
              console.log(`Подготовка к воспроизведению следующего трека: ${nextTrack.title}`)
              const nextTrackInfo = {
                id: nextTrack.id,
                title: nextTrack.title,
                artist: nextTrack.artists.map((artist: { name: string }) => artist.name).join(', '),
                album: nextTrack.albums[0]?.title || 'Неизвестный альбом',
                coverUrl: nextTrack.coverUri ? `https://${nextTrack.coverUri.replace('%%', '400x400')}` : null
              }

              try {
                // Отправляем фидбэк о начале воспроизведения трека
                await sendTrackStartedFeedback(accessToken, stationId, nextTrackInfo.id)

                // Получаем URL для стриминга трека
                const nextStreamUrl = await getStreamUrl(accessToken, nextTrackInfo.id)
                if (nextStreamUrl) {
                  // Создаем ресурс напрямую из URL
                  const nextResource = createAudioResource(nextStreamUrl, {
                    inputType: StreamType.Arbitrary
                  })

                  // Воспроизводим аудио
                  player.play(nextResource)
                  console.log('Начато воспроизведение следующего трека')

                  // Обновляем embed с информацией о треке
                  updateEmbed(embedMessage, nextTrackInfo)
                } else {
                  console.log('Не удалось получить URL для следующего трека')
                  // Если не удалось получить URL, пробуем следующий трек
                  player.emit(AudioPlayerStatus.Idle)
                }
              } catch (nextTrackError) {
                console.error('Ошибка при воспроизведении следующего трека:', nextTrackError)
                // Если произошла ошибка, пробуем следующий трек
                player.emit(AudioPlayerStatus.Idle)
              }
            }
          } else {
            console.log('Очередь пуста, загружаем новые треки')
            const loaded = await loadMoreTracks()
            if (loaded) {
              // Если удалось загрузить новые треки, запускаем воспроизведение
              player.emit(AudioPlayerStatus.Idle)
            } else {
              console.log('Не удалось загрузить новые треки, завершаем воспроизведение')
              if (embedMessage) {
                const finalEmbed = new EmbedBuilder()
                  .setColor('#FF0000')
                  .setTitle('⚠️ Воспроизведение завершено')
                  .setDescription('Не удалось загрузить новые треки.')
                  .setFooter({ text: 'Яндекс Музыка - Моя волна' })
                  .setTimestamp()

                embedMessage.edit({ embeds: [finalEmbed] }).catch((error: Error) => {
                  console.error('Ошибка при обновлении embed:', error)
                })
              }
            }
          }
        })
      } catch (streamError) {
        console.error('Ошибка при создании аудио ресурса:', streamError)
        connection.destroy()
        await interaction.followUp({
          content: 'Произошла ошибка при воспроизведении трека.',
          ephemeral: true
        })
      }
    } catch (apiError: any) {
      console.error('Ошибка при работе с API Яндекс Музыки:', apiError)
      connection.destroy()
      await interaction.followUp({
        content: `Произошла ошибка при взаимодействии с API Яндекс Музыки: ${apiError.message || 'Неизвестная ошибка'}`,
        ephemeral: true
      })
    }
  } catch (connectionError: any) {
    console.error('Ошибка при подключении к голосовому каналу:', connectionError)
    await interaction.followUp({
      content: `Произошла ошибка при подключении к голосовому каналу: ${connectionError.message || 'Неизвестная ошибка'}`,
      ephemeral: true
    })
  }
}

async function getStationInfo(token: string, stationId: string) {
  try {
    const response = await axios.get(`https://api.music.yandex.net/rotor/station/${stationId}/info`, {
      headers: {
        Authorization: `OAuth ${token}`
      }
    })
    return response.data
  } catch (error: any) {
    console.error('Ошибка при получении информации о станции:', error)
    throw new Error('Не удалось получить информацию о станции')
  }
}

async function sendStationStartedFeedback(token: string, stationId: string) {
  try {
    const now = new Date().toISOString().replace('Z', '')
    const response = await axios.post(
      `https://api.music.yandex.net/rotor/station/${stationId}/feedback`,
      {
        type: 'radioStarted',
        timestamp: now,
        from: 'ym-player-bot',
        totalPlayedSeconds: 0
      },
      {
        headers: {
          Authorization: `OAuth ${token}`,
          'Content-Type': 'application/json'
        }
      }
    )
    return response.data
  } catch (error: any) {
    console.error('Ошибка при отправке фидбэка о начале воспроизведения станции:', error)
    throw new Error('Не удалось отправить фидбэк о начале воспроизведения станции')
  }
}

async function getStationTracks(token: string, stationId: string) {
  try {
    const response = await axios.get(`https://api.music.yandex.net/rotor/station/${stationId}/tracks?settings=2=true`, {
      headers: {
        Authorization: `OAuth ${token}`
      }
    })
    return response.data.result.sequence.map((track: IYandexTrackSequenceItem) => {
      return {
        id: track.track.id,
        title: track.track.title,
        artists: track.track.artists,
        albums: track.track.albums,
        coverUri: track.track.coverUri
      }
    })
  } catch (error: any) {
    console.error('Ошибка при получении треков станции:', error)
    throw new Error('Не удалось получить треки станции')
  }
}

async function sendTrackStartedFeedback(token: string, stationId: string, trackId: string) {
  try {
    const now = new Date().toISOString().replace('Z', '')
    const payload: any = {
      type: 'trackStarted',
      timestamp: now,
      from: 'ym-player-bot',
      totalPlayedSeconds: 0,
      trackId: trackId
    }
    const response = await axios.post(`https://api.music.yandex.net/rotor/station/${stationId}/feedback`, payload, {
      headers: {
        Authorization: `OAuth ${token}`,
        'Content-Type': 'application/json'
      }
    })
    return response.data
  } catch (error: any) {
    console.error('Ошибка при отправке фидбэка о начале воспроизведения трека:', error)
    throw new Error('Не удалось отправить фидбэк о начале воспроизведения трека')
  }
}

async function getStreamUrl(token: string, trackId: string): Promise<string | null> {
  try {
    // Получаем информацию о загрузке трека
    const downloadInfoResponse = await axios.get(`https://api.music.yandex.net/tracks/${trackId}/download-info`, {
      headers: {
        Authorization: `OAuth ${token}`
      }
    })
    if (
      !downloadInfoResponse.data ||
      !downloadInfoResponse.data.result ||
      downloadInfoResponse.data.result.length === 0
    ) {
      console.error('Не удалось получить информацию о загрузке трека')
      return null
    }
    // Берем первый доступный вариант загрузки (обычно высокого качества)
    const downloadInfo = downloadInfoResponse.data.result[0]
    // Получаем URL для загрузки
    const downloadUrlResponse = await axios.get(`${downloadInfo.downloadInfoUrl}&format=json`, {
      headers: {
        Authorization: `OAuth ${token}`
      }
    })
    if (
      !downloadUrlResponse.data ||
      !downloadUrlResponse.data.host ||
      !downloadUrlResponse.data.path ||
      !downloadUrlResponse.data.s
    ) {
      console.error('Не удалось получить URL для загрузки трека')
      return null
    }
    // Формируем итоговый URL для стриминга
    const streamUrl = `https://${downloadUrlResponse.data.host}/get-mp3/${downloadUrlResponse.data.s}/${downloadUrlResponse.data.ts}${downloadUrlResponse.data.path}`
    return streamUrl
  } catch (error: any) {
    console.error('Ошибка при получении URL для стриминга:', error)
    return null
  }
}
