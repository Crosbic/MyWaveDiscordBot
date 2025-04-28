// Устанавливаем OPUS_ENGINE в opusscript и добавляем логирование
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  ComponentType,
  EmbedBuilder,
  Message
} from 'discord.js'

import {
  AudioPlayer,
  AudioPlayerStatus,
  AudioResource,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnection,
  VoiceConnectionStatus
} from '@discordjs/voice'

import { ITrackInfo, YandexMusicService } from './yandex-music.service.js'
import { IYandexTrack } from '../types/yandexTrack.js'

// Устанавливаем OPUS_ENGINE в opusscript
process.env.OPUS_ENGINE = 'opusscript'

// Динамически импортируем opusscript
let opusscript: any = null
try {
  // Используем динамический импорт для ESM
  const opusModule = await import('opusscript')
  opusscript = new opusModule.default(48000, 2, 2048)
} catch (error) {
  console.error('Ошибка при загрузке opusscript:', error)
}

export interface PlayerOptions {
  interaction: ChatInputCommandInteraction
  voiceChannel: any
  accessToken: string
  userId: string
  stationId: string
}

export interface PlayerState {
  isPlaying: boolean
  currentTrack: ITrackInfo | null
  previousTracks: IYandexTrack[]
  trackQueue: IYandexTrack[]
  accessToken: string
  userId: string
  stationId: string
  embedMessage: Message | undefined
  trackStartTime: number | null
  retryCount: number
  lastTrackId: string | null
  skipRequested: boolean
}

export class PlayerService {
  private static instance: PlayerService
  private yandexMusicService: YandexMusicService
  private players: Map<string, AudioPlayer> = new Map()
  private connections: Map<string, VoiceConnection> = new Map()
  private playerStates: Map<string, PlayerState> = new Map()
  private currentResources: Map<string, AudioResource> = new Map()

  private constructor() {
    this.yandexMusicService = YandexMusicService.getInstance()
  }

  public static getInstance(): PlayerService {
    if (!PlayerService.instance) {
      PlayerService.instance = new PlayerService()
    }
    return PlayerService.instance
  }

  /**
   * Создание и настройка плеера для воспроизведения треков
   */
  public async createPlayer(options: PlayerOptions): Promise<{
    player: AudioPlayer
    connection: VoiceConnection
    embedMessage: Message | undefined
  }> {
    const { interaction, voiceChannel, accessToken, userId, stationId } = options
    const guildId = interaction.guild!.id

    // Присоединяемся к голосовому каналу
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: interaction.guild!.voiceAdapterCreator
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
    } catch (error) {
      console.log(error)
      connection.destroy()
      throw new Error('Не удалось подключиться к голосовому каналу')
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
        console.log(error)
        connection.destroy()
        this.players.delete(guildId)
        this.connections.delete(guildId)
        this.playerStates.delete(guildId)
        this.currentResources.delete(guildId)
      }
    })

    // Создаем embed для отображения информации о треке
    const embed = new EmbedBuilder()
      .setColor('#FFCC00')
      .setTitle('🎵 Сейчас играет')
      .setDescription('Загрузка трека...')
      .setFooter({ text: 'Яндекс Музыка' })
      .setTimestamp()

    // Создаем кнопки управления
    const row = this.createControlButtons(true)

    // Проверяем, что канал является текстовым каналом, который поддерживает отправку сообщений
    let embedMessage: Message | undefined
    if (interaction.channel && 'send' in interaction.channel) {
      // Отправляем embed, который будем обновлять
      embedMessage = await interaction.channel.send({
        embeds: [embed],
        components: [row]
      })

      // Настраиваем обработчик кнопок
      this.setupButtonHandler(embedMessage, guildId)
    }

    // Сохраняем плеер и соединение
    this.players.set(guildId, player)
    this.connections.set(guildId, connection)

    // Инициализируем состояние плеера
    this.playerStates.set(guildId, {
      isPlaying: false,
      currentTrack: null,
      previousTracks: [],
      trackQueue: [],
      accessToken,
      userId,
      stationId,
      embedMessage,
      trackStartTime: null,
      retryCount: 0,
      lastTrackId: null,
      skipRequested: false // Инициализируем флаг пропуска трека
    })

    return { player, connection, embedMessage }
  }

  /**
   * Создание кнопок управления
   */
  private createControlButtons(isPlaying: boolean): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('like').setLabel('👍').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('previous').setLabel('⏮️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(isPlaying ? 'pause' : 'play')
        .setLabel(isPlaying ? '⏸️' : '▶️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('stop').setLabel('⏹️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('next').setLabel('⏭️').setStyle(ButtonStyle.Secondary)
    )
  }

  /**
   * Настройка обработчика кнопок
   */
  private setupButtonHandler(message: Message, guildId: string) {
    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 3600000 // 1 час
    })

    collector.on('collect', async (interaction: ButtonInteraction) => {
      // Проверяем, что плеер существует
      const player = this.players.get(guildId)
      const playerState = this.playerStates.get(guildId)

      if (!player || !playerState) {
        await interaction.reply({
          content: 'Плеер не найден или уже остановлен.',
          ephemeral: true
        })
        return
      }

      // Обрабатываем нажатие кнопки
      switch (interaction.customId) {
        case 'like':
          await this.handleLike(interaction, guildId)
          break
        case 'previous':
          await this.handlePrevious(interaction, guildId)
          break
        case 'pause':
          await this.handlePause(interaction, guildId)
          break
        case 'play':
          await this.handlePlay(interaction, guildId)
          break
        case 'stop':
          await this.handleStop(interaction, guildId)
          break
        case 'next':
          await this.handleNext(interaction, guildId)
          break
      }
    })

    collector.on('end', () => {
      // Удаляем кнопки после истечения времени коллектора
      if (message.editable) {
        message.edit({ components: [] }).catch(console.error)
      }
    })
  }

  /**
   * Обработка нажатия кнопки "Лайк"
   */
  private async handleLike(interaction: ButtonInteraction, guildId: string) {
    const playerState = this.playerStates.get(guildId)
    if (!playerState || !playerState.currentTrack) {
      try {
        await interaction.reply({
          content: 'Нет текущего трека для лайка.',
          ephemeral: true
        })
      } catch (error) {
        console.error('Ошибка при ответе на взаимодействие:', error)
        // Если взаимодействие истекло, просто логируем ошибку и продолжаем
      }
      return
    }

    try {
      // Отправляем запрос на добавление трека в список понравившихся
      const success = await this.yandexMusicService.likeTrack(
        playerState.accessToken,
        playerState.userId,
        playerState.currentTrack.id
      )

      try {
        if (success) {
          await interaction.reply({
            content: `Трек "${playerState.currentTrack.title}" добавлен в список понравившихся!`,
            ephemeral: true
          })
        } else {
          await interaction.reply({
            content: 'Не удалось добавить трек в список понравившихся.',
            ephemeral: true
          })
        }
      } catch (replyError) {
        console.error('Ошибка при ответе на взаимодействие:', replyError)
        // Если взаимодействие истекло, просто логируем ошибку
        // Основное действие (лайк трека) уже выполнено
      }
    } catch (error) {
      console.error('Ошибка при отправке лайка:', error)
      try {
        await interaction.reply({
          content: 'Произошла ошибка при отправке лайка.',
          ephemeral: true
        })
      } catch (replyError) {
        console.error('Ошибка при ответе на взаимодействие после ошибки лайка:', replyError)
        // Если взаимодействие истекло, просто логируем ошибку
      }
    }
  }

  /**
   * Обработка нажатия кнопки "Предыдущий трек"
   */
  private async handlePrevious(interaction: ButtonInteraction, guildId: string) {
    const playerState = this.playerStates.get(guildId)
    const player = this.players.get(guildId)

    if (!playerState || !player) {
      try {
        await interaction.reply({
          content: 'Плеер не найден или уже остановлен.',
          ephemeral: true
        })
      } catch (error) {
        console.error('Ошибка при ответе на взаимодействие:', error)
        // Если взаимодействие истекло, просто логируем ошибку и продолжаем
      }
      return
    }

    if (playerState.previousTracks.length === 0) {
      try {
        await interaction.reply({
          content: 'Нет предыдущих треков для воспроизведения.',
          ephemeral: true
        })
      } catch (error) {
        console.error('Ошибка при ответе на взаимодействие:', error)
        // Если взаимодействие истекло, просто логируем ошибку и продолжаем
      }
      return
    }

    try {
      // Берем последний трек из истории
      const previousTrack = playerState.previousTracks.pop()

      if (previousTrack) {
        // Если есть текущий трек, добавляем его в начало очереди
        if (playerState.currentTrack) {
          const currentTrackAsYandexTrack: IYandexTrack = {
            id: playerState.currentTrack.id,
            title: playerState.currentTrack.title,
            artists: [{ name: playerState.currentTrack.artist }],
            albums: [{ title: playerState.currentTrack.album }],
            coverUri: playerState.currentTrack.coverUrl?.replace('https://', '').replace('400x400', '%%') || ''
          }

          playerState.trackQueue.unshift(currentTrackAsYandexTrack)
        }

        // Воспроизводим предыдущий трек
        const trackInfo = this.yandexMusicService.trackToTrackInfo(previousTrack)
        await this.playTrack(
          player,
          trackInfo,
          playerState.accessToken,
          playerState.stationId,
          playerState.embedMessage
        )

        try {
          await interaction.reply({
            content: 'Воспроизведение предыдущего трека.',
            ephemeral: true
          })
        } catch (replyError) {
          console.error('Ошибка при ответе на взаимодействие:', replyError)
          // Если взаимодействие истекло, просто логируем ошибку
          // Основное действие (воспроизведение предыдущего трека) уже выполнено
        }
      }
    } catch (error) {
      console.error('Ошибка при воспроизведении предыдущего трека:', error)
      try {
        await interaction.reply({
          content: 'Произошла ошибка при воспроизведении предыдущего трека.',
          ephemeral: true
        })
      } catch (replyError) {
        console.error('Ошибка при ответе на взаимодействие после ошибки воспроизведения:', replyError)
        // Если взаимодействие истекло, просто логируем ошибку
      }
    }
  }

  /**
   * Обработка нажатия кнопки "Пауза"
   */
  private async handlePause(interaction: ButtonInteraction, guildId: string) {
    const player = this.players.get(guildId)
    const playerState = this.playerStates.get(guildId)

    if (!player || !playerState) {
      try {
        await interaction.reply({
          content: 'Плеер не найден или уже остановлен.',
          ephemeral: true
        })
      } catch (error) {
        console.error('Ошибка при ответе на взаимодействие:', error)
        // Если взаимодействие истекло, просто логируем ошибку и продолжаем
      }
      return
    }

    try {
      player.pause()
      playerState.isPlaying = false

      // Обновляем кнопки
      if (playerState.embedMessage && playerState.embedMessage.editable) {
        const row = this.createControlButtons(false)
        await playerState.embedMessage.edit({ components: [row] })
      }

      try {
        await interaction.reply({
          content: 'Воспроизведение приостановлено.',
          ephemeral: true
        })
      } catch (replyError) {
        console.error('Ошибка при ответе на взаимодействие:', replyError)
        // Если взаимодействие истекло, просто логируем ошибку
        // Основное действие (пауза) уже выполнено
      }
    } catch (error) {
      console.error('Ошибка при приостановке воспроизведения:', error)
      try {
        await interaction.reply({
          content: 'Произошла ошибка при приостановке воспроизведения.',
          ephemeral: true
        })
      } catch (replyError) {
        console.error('Ошибка при ответе на взаимодействие после ошибки паузы:', replyError)
        // Если взаимодействие истекло, просто логируем ошибку
      }
    }
  }

  /**
   * Обработка нажатия кнопки "Воспроизведение"
   */
  private async handlePlay(interaction: ButtonInteraction, guildId: string) {
    const player = this.players.get(guildId)
    const playerState = this.playerStates.get(guildId)

    if (!player || !playerState) {
      try {
        await interaction.reply({
          content: 'Плеер не найден или уже остановлен.',
          ephemeral: true
        })
      } catch (error) {
        console.error('Ошибка при ответе на взаимодействие:', error)
        // Если взаимодействие истекло, просто логируем ошибку и продолжаем
      }
      return
    }

    try {
      player.unpause()
      playerState.isPlaying = true

      // Обновляем кнопки
      if (playerState.embedMessage && playerState.embedMessage.editable) {
        const row = this.createControlButtons(true)
        await playerState.embedMessage.edit({ components: [row] })
      }

      try {
        await interaction.reply({
          content: 'Воспроизведение возобновлено.',
          ephemeral: true
        })
      } catch (replyError) {
        console.error('Ошибка при ответе на взаимодействие:', replyError)
        // Если взаимодействие истекло, просто логируем ошибку
        // Основное действие (возобновление воспроизведения) уже выполнено
      }
    } catch (error) {
      console.error('Ошибка при возобновлении воспроизведения:', error)
      try {
        await interaction.reply({
          content: 'Произошла ошибка при возобновлении воспроизведения.',
          ephemeral: true
        })
      } catch (replyError) {
        console.error('Ошибка при ответе на взаимодействие после ошибки возобновления:', replyError)
        // Если взаимодействие истекло, просто логируем ошибку
      }
    }
  }

  /**
   * Обработка нажатия кнопки "Стоп"
   */
  private async handleStop(interaction: ButtonInteraction, guildId: string) {
    const player = this.players.get(guildId)
    const connection = this.connections.get(guildId)
    const playerState = this.playerStates.get(guildId)

    if (!player || !connection || !playerState) {
      try {
        await interaction.reply({
          content: 'Плеер не найден или уже остановлен.',
          ephemeral: true
        })
      } catch (error) {
        console.error('Ошибка при ответе на взаимодействие:', error)
        // Если взаимодействие истекло, просто логируем ошибку и продолжаем
      }
      return
    }

    try {
      // Останавливаем воспроизведение и отключаемся от канала
      player.stop()
      connection.destroy()

      // Удаляем плеер и соединение из карт
      this.players.delete(guildId)
      this.connections.delete(guildId)
      this.playerStates.delete(guildId)
      this.currentResources.delete(guildId)

      // Обновляем сообщение
      if (playerState.embedMessage && playerState.embedMessage.editable) {
        const stoppedEmbed = new EmbedBuilder()
          .setColor('#FF0000')
          .setTitle('⏹️ Воспроизведение остановлено')
          .setDescription('Плеер был остановлен.')
          .setFooter({ text: 'Яндекс Музыка' })
          .setTimestamp()

        await playerState.embedMessage.edit({ embeds: [stoppedEmbed], components: [] })
      }

      try {
        await interaction.reply({
          content: 'Воспроизведение остановлено.',
          ephemeral: true
        })
      } catch (error) {
        console.error('Ошибка при ответе на взаимодействие:', error)
        // Если взаимодействие истекло, просто логируем ошибку
        // Основные действия по остановке плеера уже выполнены
      }
    } catch (error) {
      console.error('Ошибка при остановке воспроизведения:', error)
      try {
        await interaction.reply({
          content: 'Произошла ошибка при остановке воспроизведения.',
          ephemeral: true
        })
      } catch (replyError) {
        console.error('Ошибка при ответе на взаимодействие после ошибки остановки:', replyError)
        // Если взаимодействие истекло, просто логируем ошибку
      }
    }
  }

  /**
   * Обработка нажатия кнопки "Следующий трек"
   */
  private async handleNext(interaction: ButtonInteraction, guildId: string) {
    const player = this.players.get(guildId)
    const playerState = this.playerStates.get(guildId)

    if (!player || !playerState) {
      try {
        await interaction.reply({
          content: 'Плеер не найден или уже остановлен.',
          ephemeral: true
        })
      } catch (error) {
        console.error('Ошибка при ответе на взаимодействие:', error)
        // Если взаимодействие истекло, просто логируем ошибку и продолжаем
      }
      return
    }

    try {
      // Устанавливаем флаг, что пользователь запросил переход к следующему треку
      playerState.skipRequested = true
      console.log('Пользователь запросил переход к следующему треку')

      // Эмитируем событие Idle, чтобы запустить следующий трек
      player.emit(AudioPlayerStatus.Idle)

      try {
        await interaction.reply({
          content: 'Переход к следующему треку.',
          ephemeral: true
        })
      } catch (replyError) {
        console.error('Ошибка при ответе на взаимодействие:', replyError)
        // Если взаимодействие истекло, просто логируем ошибку
        // Основное действие (переход к следующему треку) уже выполнено
      }
    } catch (error) {
      console.error('Ошибка при переходе к следующему треку:', error)
      try {
        await interaction.reply({
          content: 'Произошла ошибка при переходе к следующему треку.',
          ephemeral: true
        })
      } catch (replyError) {
        console.error('Ошибка при ответе на взаимодействие после ошибки перехода:', replyError)
        // Если взаимодействие истекло, просто логируем ошибку
      }
    }
  }

  /**
   * Обновление embed с информацией о треке
   */
  public updateEmbed(message: Message | undefined, trackInfo: ITrackInfo) {
    if (!message) return

    const updatedEmbed = new EmbedBuilder()
      .setColor('#FFCC00')
      .setTitle('🎵 Сейчас играет')
      .setDescription(`**${trackInfo.title}**\nИсполнитель: ${trackInfo.artist}\nАльбом: ${trackInfo.album}`)
      .setFooter({ text: 'Яндекс Музыка' })
      .setTimestamp()

    if (trackInfo.coverUrl) {
      updatedEmbed.setThumbnail(trackInfo.coverUrl)
    }

    message.edit({ embeds: [updatedEmbed] }).catch((error: Error) => {
      console.error('Ошибка при обновлении embed:', error)
    })
  }

  /**
   * Обновление embed с сообщением об ошибке
   */
  public updateEmbedWithError(message: Message | undefined, errorMessage: string) {
    if (!message) return

    const errorEmbed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('⚠️ Ошибка')
      .setDescription(errorMessage)
      .setFooter({ text: 'Яндекс Музыка' })
      .setTimestamp()

    message.edit({ embeds: [errorEmbed] }).catch((error: Error) => {
      console.error('Ошибка при обновлении embed с ошибкой:', error)
    })
  }

  /**
   * Воспроизведение трека
   */
  public async playTrack(
    player: AudioPlayer,
    trackInfo: ITrackInfo,
    accessToken: string,
    stationId: string,
    embedMessage: Message | undefined
  ): Promise<boolean> {
    try {
      // Обновляем embed с информацией о загрузке трека
      if (embedMessage) {
        const loadingEmbed = new EmbedBuilder()
          .setColor('#FFCC00')
          .setTitle('🎵 Загрузка трека')
          .setDescription(
            `**${trackInfo.title}**\nИсполнитель: ${trackInfo.artist}\nАльбом: ${trackInfo.album}\n\nЗагрузка...`
          )
          .setFooter({ text: 'Яндекс Музыка' })
          .setTimestamp()

        if (trackInfo.coverUrl) {
          loadingEmbed.setThumbnail(trackInfo.coverUrl)
        }

        await embedMessage.edit({ embeds: [loadingEmbed] }).catch((error: Error) => {
          console.error('Ошибка при обновлении embed с информацией о загрузке:', error)
        })
      }

      // Отправляем фидбэк о начале воспроизведения трека
      await this.yandexMusicService.sendTrackStartedFeedback(accessToken, stationId, trackInfo.id)

      // Получаем URL для стриминга трека
      const streamUrl = await this.yandexMusicService.getStreamUrl(accessToken, trackInfo.id)
      if (!streamUrl) {
        console.log(`Не удалось получить URL для трека: ${trackInfo.title}`)
        if (embedMessage) {
          this.updateEmbedWithError(embedMessage, `Не удалось получить URL для трека: ${trackInfo.title}`)
        }
        return false
      }

      // Создаем ресурс напрямую из URL
      console.log(`Создание ресурса для трека: ${trackInfo.title}`)
      console.log(`Stream URL: ${streamUrl}`)

      // Проверяем, успешно ли инициализирован opusscript
      if (!opusscript) {
        console.warn('opusscript не был инициализирован, могут возникнуть проблемы с воспроизведением')
      }

      // Создаем ресурс с дополнительными настройками для стабильности
      const resource = createAudioResource(streamUrl, {
        inputType: StreamType.Arbitrary, // Используем Arbitrary для любого формата
        inlineVolume: true,
        silencePaddingFrames: 5 // Уменьшаем количество кадров тишины
      })

      // Устанавливаем громкость на 80% для предотвращения искажений
      if (resource.volume) {
        resource.volume.setVolume(0.8)
      }

      // Сохраняем ресурс и информацию о текущем треке
      const guildId = embedMessage?.guild?.id
      if (guildId) {
        this.currentResources.set(guildId, resource)

        const playerState = this.playerStates.get(guildId)
        if (playerState) {
          // Если есть текущий трек, добавляем его в историю
          if (playerState.currentTrack) {
            const currentTrackAsYandexTrack: IYandexTrack = {
              id: playerState.currentTrack.id,
              title: playerState.currentTrack.title,
              artists: [{ name: playerState.currentTrack.artist }],
              albums: [{ title: playerState.currentTrack.album }],
              coverUri: playerState.currentTrack.coverUrl?.replace('https://', '').replace('400x400', '%%') || ''
            }

            // Ограничиваем историю 10 треками
            if (playerState.previousTracks.length >= 10) {
              playerState.previousTracks.shift()
            }

            playerState.previousTracks.push(currentTrackAsYandexTrack)
          }

          // Обновляем текущий трек
          playerState.currentTrack = trackInfo
          playerState.isPlaying = true

          // Обновляем кнопки
          if (playerState.embedMessage && playerState.embedMessage.editable) {
            const row = this.createControlButtons(true)
            await playerState.embedMessage.edit({ components: [row] })
          }
        }
      }

      // Воспроизводим аудио с небольшой задержкой для стабильности
      console.log(`Начало воспроизведения трека: ${trackInfo.title}`)

      // Небольшая задержка перед воспроизведением для стабильности
      console.log('Ожидаем 2 секунды перед воспроизведением...')

      // Добавляем обработчик для отслеживания состояния ресурса
      resource.playStream.on('error', err => {
        console.error('Ошибка в потоке воспроизведения:', err)
      })

      setTimeout(() => {
        try {
          console.log('Запускаем воспроизведение...')
          player.play(resource)
          console.log(`Команда воспроизведения отправлена для трека: ${trackInfo.title}`)
        } catch (error) {
          // Приводим ошибку к типу Error для доступа к свойству message
          const playError = error instanceof Error ? error : new Error(String(error))
          console.error('Ошибка при запуске воспроизведения:', playError)
          if (embedMessage) {
            this.updateEmbedWithError(embedMessage, `Ошибка при запуске воспроизведения: ${playError.message}`)
          }
        }
      }, 2000) // Уменьшаем задержку до 2 секунд

      // Обновляем embed с информацией о треке
      this.updateEmbed(embedMessage, trackInfo)

      // Устанавливаем время начала воспроизведения трека
      const playerState = this.playerStates.get(guildId as any)
      if (playerState) {
        playerState.trackStartTime = Date.now()
        // Проверяем, что id не undefined и не null
        if (trackInfo.id) {
          playerState.lastTrackId = trackInfo.id
        } else {
          playerState.lastTrackId = null
        }
        playerState.retryCount = 0 // Сбрасываем счетчик повторных попыток
      }

      return true
    } catch (error) {
      console.error('Ошибка при воспроизведении трека:', error)
      if (embedMessage) {
        this.updateEmbedWithError(embedMessage, `Ошибка при воспроизведении трека: ${trackInfo.title}`)
      }
      return false
    }
  }

  /**
   * Настройка бесконечного воспроизведения треков
   */
  public setupInfinitePlayback(
    player: AudioPlayer,
    accessToken: string,
    stationId: string,
    embedMessage: Message | undefined,
    initialTracks: IYandexTrack[]
  ) {
    const guildId = embedMessage?.guild?.id
    if (!guildId) return

    // Обновляем очередь треков в состоянии плеера
    const playerState = this.playerStates.get(guildId)
    if (playerState) {
      playerState.trackQueue = [...initialTracks]
    }

    // Функция для загрузки новых треков
    const loadMoreTracks = async () => {
      try {
        console.log('Загружаем новые треки для очереди...')
        const newTracks = await this.yandexMusicService.getStationTracks(accessToken, stationId)

        const playerState = this.playerStates.get(guildId)
        if (playerState && newTracks && newTracks.length > 0) {
          // Добавляем все новые треки в очередь
          playerState.trackQueue.push(...newTracks)
          console.log(`Добавлено ${newTracks.length} новых треков в очередь`)
          return true
        }
        return false
      } catch (error) {
        console.error('Ошибка при загрузке новых треков:', error)
        return false
      }
    }

    // Удаляем все предыдущие обработчики событий, чтобы избежать дублирования
    player.removeAllListeners(AudioPlayerStatus.Idle)
    player.removeAllListeners('error')

    // Флаг для отслеживания, находимся ли мы в процессе загрузки трека
    let isLoadingTrack = false

    // Минимальное время воспроизведения трека в миллисекундах (10 секунд)
    // Если трек играл меньше этого времени, считаем что это было прерывание, а не завершение
    const MIN_PLAY_TIME = 10000

    // Максимальное количество повторных попыток воспроизведения трека
    const MAX_RETRY_COUNT = 5

    // Добавляем обработчик для отслеживания состояния плеера
    player.on(AudioPlayerStatus.Playing, () => {
      console.log('Плеер перешел в состояние Playing')

      // Получаем текущее состояние плеера
      const playerState = this.playerStates.get(guildId)
      if (playerState && playerState.currentTrack) {
        console.log(`Трек "${playerState.currentTrack.title}" успешно начал воспроизведение`)
      }
    })

    player.on(AudioPlayerStatus.Buffering, () => {
      console.log('Плеер перешел в состояние Buffering')
    })

    player.on(AudioPlayerStatus.AutoPaused, () => {
      console.log('Плеер перешел в состояние AutoPaused')
    })

    // Обработчик ошибок воспроизведения с улучшенным логированием
    player.on('error', error => {
      console.error('Ошибка воспроизведения:', error)
      console.error('Детали ошибки:', JSON.stringify(error, null, 2))

      // Логируем информацию о текущем состоянии аудио-движка
      console.log('Текущий OPUS_ENGINE при ошибке:', process.env.OPUS_ENGINE)

      // Проверяем, успешно ли инициализирован opusscript
      if (opusscript) {
        console.log('Используем инициализированный opusscript для обработки аудио при ошибке')
      } else {
        console.warn('opusscript не был инициализирован, могут возникнуть проблемы с воспроизведением')
      }

      const playerState = this.playerStates.get(guildId)
      if (!playerState || !playerState.currentTrack) {
        console.log('Не найдено состояние плеера или текущий трек при ошибке')
        return
      }

      // Обновляем embed с информацией об ошибке
      if (embedMessage) {
        const errorEmbed = new EmbedBuilder()
          .setColor('#FFA500') // Оранжевый цвет для временных ошибок
          .setTitle('⚠️ Проблема с воспроизведением')
          .setDescription(
            `Возникла проблема при воспроизведении трека "${playerState.currentTrack.title}". Пытаемся восстановить...`
          )
          .setFooter({ text: 'Яндекс Музыка - Моя волна' })
          .setTimestamp()

        embedMessage.edit({ embeds: [errorEmbed] }).catch((error: Error) => {
          console.error('Ошибка при обновлении embed с ошибкой:', error)
        })
      }

      // Пытаемся повторно воспроизвести текущий трек через 5 секунд
      setTimeout(() => {
        if (playerState.retryCount < MAX_RETRY_COUNT && playerState.currentTrack) {
          console.log(
            `Повторная попытка воспроизведения трека: ${playerState.currentTrack.title} (попытка ${playerState.retryCount + 1}/${MAX_RETRY_COUNT})`
          )
          playerState.retryCount++
          this.playTrack(player, playerState.currentTrack, accessToken, stationId, embedMessage)
        } else {
          // Если превышено максимальное количество попыток, переходим к следующему треку
          console.log('Превышено максимальное количество попыток, переходим к следующему треку')
          isLoadingTrack = false
          player.emit(AudioPlayerStatus.Idle)
        }
      }, 5000)
    })

    // Обработчик для воспроизведения следующего трека
    player.on(AudioPlayerStatus.Idle, async () => {
      const playerState = this.playerStates.get(guildId)
      if (!playerState) return

      // Если мы уже в процессе загрузки трека, игнорируем событие
      if (isLoadingTrack) {
        console.log('Уже идет загрузка трека, игнорируем событие Idle')
        return
      }

      // Проверяем, не было ли это кратковременное прерывание
      const currentTime = Date.now()
      const playTime = playerState.trackStartTime ? currentTime - playerState.trackStartTime : 0

      // Проверяем, был ли запрошен пропуск трека пользователем
      if (playerState.skipRequested) {
        console.log('Пользователь запросил переход к следующему треку, пропускаем проверку времени воспроизведения')
        // Сбрасываем флаг пропуска трека
        playerState.skipRequested = false
      }
      // Если трек играл меньше минимального времени и у нас есть текущий трек,
      // и это не первая попытка воспроизведения (чтобы избежать бесконечного цикла),
      // и пользователь не запросил пропуск трека,
      // пытаемся повторно воспроизвести его
      else if (
        playTime < MIN_PLAY_TIME &&
        playTime > 0 &&
        playerState.currentTrack &&
        playerState.retryCount < MAX_RETRY_COUNT
      ) {
        console.log(
          `Обнаружено прерывание воспроизведения трека: ${playerState.currentTrack.title} после ${playTime}ms`
        )
        console.log(`Повторная попытка воспроизведения (${playerState.retryCount + 1}/${MAX_RETRY_COUNT})`)

        // Увеличиваем счетчик повторных попыток
        playerState.retryCount++

        // Если это последняя попытка, просто переходим к следующему треку
        if (playerState.retryCount >= MAX_RETRY_COUNT) {
          console.log(
            `Достигнуто максимальное количество попыток для трека: ${playerState.currentTrack.title}, переходим к следующему треку`
          )

          // Сбрасываем флаг загрузки и переходим к следующему треку
          isLoadingTrack = false

          // Если в очереди есть треки, берем следующий
          if (playerState.trackQueue.length > 0) {
            const nextTrack = playerState.trackQueue.shift()
            if (nextTrack) {
              const nextTrackInfo = this.yandexMusicService.trackToTrackInfo(nextTrack)
              this.playTrack(player, nextTrackInfo, accessToken, stationId, embedMessage)
            }
          } else {
            // Если очередь пуста, пытаемся загрузить новые треки
            loadMoreTracks().then(loaded => {
              if (loaded && playerState.trackQueue.length > 0) {
                const nextTrack = playerState.trackQueue.shift()
                if (nextTrack) {
                  const nextTrackInfo = this.yandexMusicService.trackToTrackInfo(nextTrack)
                  this.playTrack(player, nextTrackInfo, accessToken, stationId, embedMessage)
                }
              }
            })
          }
          return
        }

        // Обновляем embed с информацией о повторной попытке
        if (embedMessage) {
          const reconnectEmbed = new EmbedBuilder()
            .setColor('#FFA500') // Оранжевый цвет для временных ошибок
            .setTitle('🔄 Восстановление соединения')
            .setDescription(`Восстанавливаем воспроизведение трека "${playerState.currentTrack.title}"...`)
            .setFooter({ text: 'Яндекс Музыка' })
            .setTimestamp()

          if (playerState.currentTrack.coverUrl) {
            reconnectEmbed.setThumbnail(playerState.currentTrack.coverUrl)
          }

          embedMessage.edit({ embeds: [reconnectEmbed] }).catch((error: Error) => {
            console.error('Ошибка при обновлении embed с информацией о восстановлении:', error)
          })
        }

        // Ждем 10 секунд перед повторной попыткой
        setTimeout(() => {
          if (playerState.currentTrack) {
            this.playTrack(player, playerState.currentTrack, accessToken, stationId, embedMessage)
          }
        }, 10000)

        return
      }

      // Если это не прерывание или превышено максимальное количество попыток,
      // переходим к следующему треку
      console.log('Трек закончился, проверяем очередь')
      console.log(`Треков в очереди: ${playerState.trackQueue.length}`)

      if (playerState.trackQueue.length > 0) {
        // Устанавливаем флаг загрузки
        isLoadingTrack = true

        try {
          // Берем следующий трек из очереди
          const nextTrack = playerState.trackQueue.shift()
          if (nextTrack) {
            console.log(`Подготовка к воспроизведению следующего трека: ${nextTrack.title}`)
            const nextTrackInfo = this.yandexMusicService.trackToTrackInfo(nextTrack)

            const success = await this.playTrack(player, nextTrackInfo, accessToken, stationId, embedMessage)
            if (!success) {
              console.log(`Не удалось воспроизвести трек: ${nextTrack.title}, ждем 3 секунды перед следующей попыткой`)

              // Если не удалось воспроизвести трек, ждем 3 секунды перед следующей попыткой
              setTimeout(() => {
                isLoadingTrack = false
                player.emit(AudioPlayerStatus.Idle)
              }, 3000)
            } else {
              // Если трек успешно воспроизведен, сбрасываем флаг загрузки
              isLoadingTrack = false
            }
          } else {
            isLoadingTrack = false
          }
        } catch (error) {
          console.error('Ошибка при воспроизведении следующего трека:', error)
          isLoadingTrack = false
        }
      } else {
        console.log('Очередь пуста, загружаем новые треки')

        // Устанавливаем флаг загрузки
        isLoadingTrack = true

        try {
          const loaded = await loadMoreTracks()
          if (loaded) {
            // Если удалось загрузить новые треки, запускаем воспроизведение через 1 секунду
            setTimeout(() => {
              isLoadingTrack = false
              player.emit(AudioPlayerStatus.Idle)
            }, 1000)
          } else {
            console.log('Не удалось загрузить новые треки, завершаем воспроизведение')
            if (embedMessage) {
              const finalEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('⚠️ Воспроизведение завершено')
                .setDescription('Не удалось загрузить новые треки.')
                .setFooter({ text: 'Яндекс Музыка' })
                .setTimestamp()

              embedMessage.edit({ embeds: [finalEmbed], components: [] }).catch((error: Error) => {
                console.error('Ошибка при обновлении embed:', error)
              })
            }
            isLoadingTrack = false
          }
        } catch (error) {
          console.error('Ошибка при загрузке новых треков:', error)
          isLoadingTrack = false
        }
      }
    })
  }
}
