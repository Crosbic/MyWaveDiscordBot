import { ChatInputCommandInteraction, SlashCommandBuilder, GuildMember } from 'discord.js'

import { DatabaseService } from '../services/database.service.js'
import { PlayerService } from '../services/player.service.js'
import { YandexMusicService } from '../services/yandex-music.service.js'

export const data = new SlashCommandBuilder()
  .setName('my-wave')
  .setDescription('Воспроизвести треки из "Моя волна" в Яндекс Музыке')

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id
  const db = DatabaseService.getInstance()
  const playerService = PlayerService.getInstance()
  const yandexMusicService = YandexMusicService.getInstance()

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
    const { accessToken } = userData
    const stationId = 'user:onyourwave'

    // Проверяем, существует ли уже активный плеер для данного сервера
    const playerStatus = playerService.isPlayerActive(interaction.guild.id)
    if (playerStatus.active && playerStatus.discordUserId !== interaction.user.id) {
      await interaction.followUp({
        content:
          'В данный момент плеер уже используется другим пользователем. Дождитесь, пока он остановит воспроизведение.',
        ephemeral: true
      })
      return
    }

    // Создаем плеер
    const { player, connection, embedMessage } = await playerService.createPlayer({
      interaction,
      voiceChannel,
      accessToken,
      userId: userData.userInfo.id,
      stationId
    })

    try {
      // 1. Получение информации о станции "Моя волна"
      await yandexMusicService.getStationInfo(accessToken, stationId)

      // 2. Отправляем фидбэк о начале воспроизведения станции
      await yandexMusicService.sendStationStartedFeedback(accessToken, stationId)

      // 3. Получаем треки станции
      const tracks = await yandexMusicService.getStationTracks(accessToken, stationId)
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
      const trackInfo = yandexMusicService.trackToTrackInfo(firstTrack)

      // Воспроизводим первый трек
      const success = await playerService.playTrack(player, trackInfo, accessToken, stationId, embedMessage)
      if (!success) {
        connection.destroy()
        await interaction.followUp({
          content: 'Не удалось воспроизвести трек.',
          ephemeral: true
        })
        return
      }

      // Настраиваем бесконечное воспроизведение
      playerService.setupInfinitePlayback(player, accessToken, stationId, embedMessage, tracks.slice(1))
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
