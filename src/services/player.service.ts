import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
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

import { DatabaseService } from './database.service.js'
import { YandexMusicService } from './yandex-music.service.js'
import config from '../config.js'
import { YandexAuthError } from '../errors/yandexAuthError.js'
import { IPlayerOptions } from '../types/playerOptions.js'
import { IPlayerState } from '../types/playerState.js'
import { ITrackInfo } from '../types/trackInfo.js'
import { IYandexTrack } from '../types/yandexTrack.js'

process.env.OPUS_ENGINE = 'opusscript'

let opusscript: any = null
try {
  const opusModule = await import('opusscript')
  opusscript = new opusModule.default(48000, 2, 2048)
} catch (error) {
  console.error('Ошибка при загрузке opusscript:', error)
}

export class PlayerService {
  private static instance: PlayerService
  private yandexMusicService: YandexMusicService
  private players: Map<string, AudioPlayer> = new Map()
  private connections: Map<string, VoiceConnection> = new Map()
  private playerStates: Map<string, IPlayerState> = new Map()
  private currentResources: Map<string, AudioResource> = new Map()
  private inactivityTimers: Map<string, NodeJS.Timeout> = new Map()
  private pauseTimers: Map<string, NodeJS.Timeout> = new Map()
  private serverButtonsAccess: Map<string, boolean> = new Map()

  private readonly EMPTY_CHANNEL_TIMEOUT = 20000
  private readonly NO_PLAYBACK_TIMEOUT = 30000

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
   * Проверяет, существует ли активный плеер для данного сервера
   * @param guildId ID сервера
   * @returns Объект с информацией о плеере или null, если плеер не существует
   */
  public isPlayerActive(guildId: string): { active: boolean; discordUserId?: string } {
    const player = this.players.get(guildId)
    const playerState = this.playerStates.get(guildId)

    if (!player || !playerState) {
      return { active: false }
    }

    return {
      active: true,
      discordUserId: playerState.discordUserId
    }
  }

  /**
   * Создание и настройка плеера для воспроизведения треков
   */
  public async createPlayer(options: IPlayerOptions): Promise<{
    player: AudioPlayer
    connection: VoiceConnection
    embedMessage: Message | undefined
  }> {
    const { interaction, voiceChannel, accessToken, userId, stationId } = options
    const guildId = interaction.guild!.id

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: interaction.guild!.voiceAdapterCreator
    })

    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play
      }
    })

    connection.subscribe(player)

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 5_000)
    } catch (error) {
      console.log(error)
      connection.destroy()
      throw new Error('Не удалось подключиться к голосовому каналу')
    }

    connection.on('stateChange', (oldState, newState) => {
      console.log(`[${guildId}] Соединение: ${oldState.status} -> ${newState.status}`)
    })

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.log(`[${guildId}] Соединение потеряно, пытаемся восстановить...`)

      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
        ])
        console.log(`[${guildId}] Соединение восстанавливается...`)
      } catch (error) {
        console.log(`[${guildId}] Не удалось восстановить соединение автоматически`)
        this.handleConnectionLost(guildId, 'Соединение с голосовым каналом потеряно')
      }
    })

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      console.log(`[${guildId}] Соединение уничтожено`)
      this.cleanupPlayer(guildId)
    })

    connection.on('error', error => {
      console.error(`[${guildId}] Ошибка соединения:`, error)
    })

    const embed = new EmbedBuilder()
      .setColor('#FFCC00')
      .setTitle('🎵 Сейчас играет')
      .setDescription('Загрузка трека...')
      .setFooter({ text: 'Яндекс Музыка' })
      .setTimestamp()

    const row = this.createControlButtons(true)

    let embedMessage: Message | undefined
    if (interaction.channel && 'send' in interaction.channel) {
      embedMessage = await interaction.channel.send({
        embeds: [embed],
        components: [row]
      })

      this.setupButtonHandler(embedMessage, guildId)
    }

    this.players.set(guildId, player)
    this.connections.set(guildId, connection)

    // Используем серверную настройку публичного доступа при создании плеера
    const publicButtonsAccess = this.isPublicButtonsAccessEnabled(guildId)

    this.playerStates.set(guildId, {
      isPlaying: false,
      currentTrack: null,
      previousTracks: [],
      trackQueue: [],
      accessToken,
      userId,
      discordUserId: interaction.user.id,
      stationId,
      embedMessage,
      trackStartTime: null,
      retryCount: 0,
      lastTrackId: null,
      skipRequested: false,
      publicButtonsAccess // Используем серверную настройку
    })

    this.startActivityChecks(guildId, voiceChannel)

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
    console.log('Настройка обработчика кнопок')

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 86400000
    })

    console.log('Коллектор кнопок создан')

    collector.on('collect', async (interaction: ButtonInteraction) => {
      const player = this.players.get(guildId)
      const playerState = this.playerStates.get(guildId)
      const connection = this.connections.get(guildId)

      if (!player || !playerState || !connection) {
        await interaction.reply({
          content: 'Плеер не найден или уже остановлен.',
          ephemeral: true
        })
        return
      }

      const isOwner = interaction.user.id === playerState.discordUserId
      const isGlobalAdmin =
        config.admins.includes(interaction.user.id) || config.admins.includes(interaction.user.username)
      const isServerAdmin = interaction.memberPermissions?.has('Administrator') || false
      const isLikeButton = interaction.customId === 'like'
      const isPublicAccessEnabled = this.isPublicButtonsAccessEnabled(guildId)
      let isInSameVoiceChannel = false

      if (interaction.guild) {
        const botVoiceChannelId = connection.joinConfig.channelId
        const guildMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null)

        isInSameVoiceChannel = guildMember?.voice.channelId === botVoiceChannelId
      }

      // Разрешаем использовать кнопки, если:
      // 1. Пользователь - владелец плеера, или
      // 2. Это кнопка "Лайк" (ее можно нажимать всем), или
      // 3. Пользователь - глобальный админ (из списка ADMINS), или
      // 4. Пользователь - администратор сервера, или
      // 5. Режим публичного доступа включен И пользователь находится в том же голосовом канале
      if (
        !isOwner &&
        !isLikeButton &&
        !isGlobalAdmin &&
        !isServerAdmin &&
        !(isPublicAccessEnabled && isInSameVoiceChannel)
      ) {
        let errorMessage = ''

        if (isPublicAccessEnabled) {
          errorMessage = 'Вы должны находиться в том же голосовом канале, что и бот, чтобы управлять плеером.'
        } else {
          errorMessage =
            'Только пользователь, запустивший воспроизведение, может управлять плеером. Администраторы сервера могут включить общий доступ к кнопкам с помощью команды /allow-buttons.'
        }

        await interaction.reply({
          content: errorMessage,
          ephemeral: true
        })
        return
      }

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
      if (message.editable) {
        message.edit({ components: [] }).catch(console.error)
      }
    })
  }

  /**
   * Включение/выключение режима публичного доступа к кнопкам на уровне сервера
   */
  public setPublicButtonsAccess(guildId: string, enabled: boolean): boolean {
    DatabaseService.getInstance().setGuildButtonsAccess(guildId, enabled)
    this.serverButtonsAccess.set(guildId, enabled)

    const playerState = this.playerStates.get(guildId)
    if (playerState) {
      playerState.publicButtonsAccess = enabled
    }

    return true
  }

  /**
   * Проверяет, включен ли режим публичного доступа к кнопкам на уровне сервера
   */
  public isPublicButtonsAccessEnabled(guildId: string): boolean {
    if (this.serverButtonsAccess.has(guildId)) {
      return this.serverButtonsAccess.get(guildId) as boolean
    }

    const enabled = DatabaseService.getInstance().getGuildButtonsAccess(guildId)
    this.serverButtonsAccess.set(guildId, enabled)
    return enabled
  }

  /**
   * Обработка нажатия кнопки "Лайк"
   * Добавляет трек в избранное пользователю, который нажал на кнопку
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
      }
      return
    }

    try {
      if (!playerState.currentTrack.id) {
        await interaction.reply({
          content: `Не удалось добавить трек "${playerState.currentTrack.title}" в список понравившихся: ID трека не определен.`,
          ephemeral: true
        })
        return
      }

      const clickedUserId = interaction.user.id

      const db = DatabaseService.getInstance()

      if (!db.hasUserToken(clickedUserId)) {
        await interaction.reply({
          content: 'Вы не авторизованы в Яндекс Музыке. Используйте команду `/login` для авторизации.',
          ephemeral: true
        })
        return
      }

      const userData = db.getUserData(clickedUserId)
      if (!userData) {
        await interaction.reply({
          content:
            'Не удалось получить данные вашего аккаунта. Попробуйте выйти и войти снова с помощью команд `/logout` и `/login`.',
          ephemeral: true
        })
        return
      }

      const success = await this.yandexMusicService.likeTrack(
        userData.accessToken,
        userData.userInfo.id,
        playerState.currentTrack.id
      )

      try {
        if (success) {
          await interaction.reply({
            content: `Трек "${playerState.currentTrack.title}" добавлен в список понравившихся у ${userData.userInfo.nickName}!`,
            ephemeral: true
          })
        } else {
          await interaction.reply({
            content: `Не удалось добавить трек "${playerState.currentTrack.title}" в список понравившихся у ${userData.userInfo.nickName}.`,
            ephemeral: true
          })
        }
      } catch (replyError) {
        console.error('Ошибка при ответе на взаимодействие:', replyError)
      }
    } catch (error) {
      console.error('Ошибка при отправке лайка:', error)
      const content =
        error instanceof YandexAuthError
          ? 'Ваш токен Яндекс истёк или недействителен. Выполните `/logout`, затем `/login` с новым токеном.'
          : 'Произошла ошибка при отправке лайка.'
      try {
        await interaction.reply({
          content,
          ephemeral: true
        })
      } catch (replyError) {
        console.error('Ошибка при ответе на взаимодействие после ошибки лайка:', replyError)
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
      }
      return
    }

    try {
      const previousTrack = playerState.previousTracks.pop()

      if (previousTrack) {
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
      }
      return
    }

    try {
      player.pause()
      playerState.isPlaying = false

      if (playerState.embedMessage && playerState.embedMessage.editable) {
        try {
          console.log('Обновляем кнопки на паузу')
          const row = this.createControlButtons(false)
          await playerState.embedMessage.edit({ components: [row] })
          console.log('Кнопки обновлены')
        } catch (error) {
          console.error('Ошибка при обновлении кнопок:', error)
        }
      }

      try {
        await interaction.reply({
          content: 'Воспроизведение приостановлено.',
          ephemeral: true
        })
      } catch (replyError) {
        console.error('Ошибка при ответе на взаимодействие:', replyError)
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
      }
      return
    }

    try {
      player.unpause()
      playerState.isPlaying = true

      if (playerState.embedMessage && playerState.embedMessage.editable) {
        try {
          console.log('Обновляем кнопки на воспроизведение')
          const row = this.createControlButtons(true)
          await playerState.embedMessage.edit({ components: [row] })
          console.log('Кнопки обновлены')
        } catch (error) {
          console.error('Ошибка при обновлении кнопок:', error)
        }
      }

      try {
        await interaction.reply({
          content: 'Воспроизведение возобновлено.',
          ephemeral: true
        })
      } catch (replyError) {
        console.error('Ошибка при ответе на взаимодействие:', replyError)
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
      }
      return
    }

    try {
      player.stop()
      connection.destroy()

      this.cleanupPlayer(guildId)

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
      }
      return
    }

    try {
      playerState.skipRequested = true
      console.log('Пользователь запросил переход к следующему треку')

      player.emit(AudioPlayerStatus.Idle)

      try {
        await interaction.reply({
          content: 'Переход к следующему треку.',
          ephemeral: true
        })
      } catch (replyError) {
        console.error('Ошибка при ответе на взаимодействие:', replyError)
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
      }
    }
  }

  /**
   * Обновление embed с информацией о треке
   */
  public updateEmbed(message: Message | undefined, trackInfo: ITrackInfo) {
    if (!message) return

    const guildId = message.guild?.id
    if (!guildId) return

    const playerState = this.playerStates.get(guildId)
    if (!playerState) return

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

      if (trackInfo.id) {
        await this.yandexMusicService.sendTrackStartedFeedback(accessToken, stationId, trackInfo.id)
      }

      if (!trackInfo.id) {
        console.log(`Не удалось получить URL для трека: ${trackInfo.title} (ID трека не определен)`)
        if (embedMessage) {
          this.updateEmbedWithError(
            embedMessage,
            `Не удалось получить URL для трека: ${trackInfo.title} (ID трека не определен)`
          )
        }
        return false
      }

      const streamUrl = await this.yandexMusicService.getStreamUrl(accessToken, trackInfo.id)
      if (!streamUrl) {
        console.log(`Не удалось получить URL для трека: ${trackInfo.title}`)
        if (embedMessage) {
          this.updateEmbedWithError(embedMessage, `Не удалось получить URL для трека: ${trackInfo.title}`)
        }
        return false
      }

      console.log(`Создание ресурса для трека: ${trackInfo.title}`)
      console.log(`Stream URL: ${streamUrl}`)

      if (!opusscript) {
        console.warn('opusscript не был инициализирован, могут возникнуть проблемы с воспроизведением')
      }

      const resource = createAudioResource(streamUrl, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true,
        silencePaddingFrames: 5
      })

      if (resource.volume) {
        resource.volume.setVolume(0.8) // Чтоб не оглохли
      }

      const guildId = embedMessage?.guild?.id
      if (guildId) {
        this.currentResources.set(guildId, resource)

        const playerState = this.playerStates.get(guildId)
        if (playerState) {
          if (playerState.currentTrack) {
            const currentTrackAsYandexTrack: IYandexTrack = {
              id: playerState.currentTrack.id,
              title: playerState.currentTrack.title,
              artists: [{ name: playerState.currentTrack.artist }],
              albums: [{ title: playerState.currentTrack.album }],
              coverUri: playerState.currentTrack.coverUrl?.replace('https://', '').replace('400x400', '%%') || ''
            }

            if (playerState.previousTracks.length >= 10) {
              playerState.previousTracks.shift()
            }

            playerState.previousTracks.push(currentTrackAsYandexTrack)
          }

          playerState.currentTrack = trackInfo
          playerState.isPlaying = true

          if (playerState.embedMessage && playerState.embedMessage.editable) {
            try {
              console.log('Обновляем кнопки при воспроизведении трека')
              const row = this.createControlButtons(true)
              await playerState.embedMessage.edit({ components: [row] })
              console.log('Кнопки обновлены')
            } catch (error) {
              console.error('Ошибка при обновлении кнопок:', error)
            }
          }
        }
      }

      console.log(`Начало воспроизведения трека: ${trackInfo.title}`)
      console.log('Ожидаем 2 секунды перед воспроизведением...')

      resource.playStream.on('error', err => {
        console.error('Ошибка в потоке воспроизведения:', err)
      })

      setTimeout(() => {
        try {
          console.log('Запускаем воспроизведение...')
          player.play(resource)
          console.log(`Команда воспроизведения отправлена для трека: ${trackInfo.title}`)
        } catch (error) {
          const playError = error instanceof Error ? error : new Error(String(error))
          console.error('Ошибка при запуске воспроизведения:', playError)
          if (embedMessage) {
            this.updateEmbedWithError(embedMessage, `Ошибка при запуске воспроизведения: ${playError.message}`)
          }
        }
      }, 2000)

      if (guildId) {
        const currentPlayerState = this.playerStates.get(guildId)
        if (currentPlayerState && currentPlayerState.embedMessage) {
          this.updateEmbed(currentPlayerState.embedMessage, trackInfo)
        }
      } else {
        console.error('Не удалось получить ID сервера из сообщения при обновлении embed')
        return true
      }

      const playerState = this.playerStates.get(guildId)
      if (playerState) {
        playerState.trackStartTime = Date.now()
        if (trackInfo.id) {
          playerState.lastTrackId = trackInfo.id
        } else {
          playerState.lastTrackId = null
        }
        playerState.retryCount = 0
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
    if (!guildId) {
      console.error('Не удалось получить ID сервера из сообщения')
      return
    }

    const playerState = this.playerStates.get(guildId)
    if (playerState) {
      playerState.trackQueue = [...initialTracks]
    }

    const loadMoreTracks = async () => {
      try {
        console.log('Загружаем новые треки для очереди...')
        const newTracks = await this.yandexMusicService.getStationTracks(accessToken, stationId)

        const playerState = this.playerStates.get(guildId)
        if (playerState && newTracks && newTracks.length > 0) {
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

    player.removeAllListeners(AudioPlayerStatus.Idle)
    player.removeAllListeners('error')

    let isLoadingTrack = false
    const MIN_PLAY_TIME = 10000
    const MAX_RETRY_COUNT = 5

    player.on(AudioPlayerStatus.Playing, () => {
      console.log('Плеер перешел в состояние Playing')

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

    player.on('error', error => {
      console.error('Ошибка воспроизведения:', error)
      console.error('Детали ошибки:', JSON.stringify(error, null, 2))

      console.log('Текущий OPUS_ENGINE при ошибке:', process.env.OPUS_ENGINE)

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

      if (playerState.embedMessage && playerState.embedMessage.editable) {
        const errorEmbed = new EmbedBuilder()
          .setColor('#FFA500')
          .setTitle('⚠️ Проблема с воспроизведением')
          .setDescription(
            `Возникла проблема при воспроизведении трека "${playerState.currentTrack.title}". Пытаемся восстановить...`
          )
          .setFooter({ text: 'Яндекс Музыка - Моя волна' })
          .setTimestamp()

        playerState.embedMessage.edit({ embeds: [errorEmbed] }).catch((error: Error) => {
          console.error('Ошибка при обновлении embed с ошибкой:', error)
        })
      }

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

    player.on(AudioPlayerStatus.Idle, async () => {
      const playerState = this.playerStates.get(guildId)
      if (!playerState) return

      if (isLoadingTrack) {
        console.log('Уже идет загрузка трека, игнорируем событие Idle')
        return
      }

      const currentTime = Date.now()
      const playTime = playerState.trackStartTime ? currentTime - playerState.trackStartTime : 0

      if (playerState.skipRequested) {
        console.log('Пользователь запросил переход к следующему треку, пропускаем проверку времени воспроизведения')
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

        playerState.retryCount++

        if (playerState.retryCount >= MAX_RETRY_COUNT) {
          console.log(
            `Достигнуто максимальное количество попыток для трека: ${playerState.currentTrack.title}, переходим к следующему треку`
          )

          isLoadingTrack = false

          if (playerState.trackQueue.length > 0) {
            const nextTrack = playerState.trackQueue.shift()
            if (nextTrack) {
              const nextTrackInfo = this.yandexMusicService.trackToTrackInfo(nextTrack)
              this.playTrack(player, nextTrackInfo, accessToken, stationId, embedMessage)
            }
          } else {
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

        if (playerState.embedMessage && playerState.embedMessage.editable) {
          const reconnectEmbed = new EmbedBuilder()
            .setColor('#FFA500')
            .setTitle('🔄 Восстановление соединения')
            .setDescription(`Восстанавливаем воспроизведение трека "${playerState.currentTrack.title}"...`)
            .setFooter({ text: 'Яндекс Музыка' })
            .setTimestamp()

          if (playerState.currentTrack.coverUrl) {
            reconnectEmbed.setThumbnail(playerState.currentTrack.coverUrl)
          }

          playerState.embedMessage.edit({ embeds: [reconnectEmbed] }).catch((error: Error) => {
            console.error('Ошибка при обновлении embed с информацией о восстановлении:', error)
          })
        }

        setTimeout(() => {
          if (playerState.currentTrack) {
            this.playTrack(player, playerState.currentTrack, accessToken, stationId, embedMessage)
          }
        }, 10000)

        return
      }

      console.log('Трек закончился, проверяем очередь')
      console.log(`Треков в очереди: ${playerState.trackQueue.length}`)

      if (playerState.trackQueue.length > 0) {
        isLoadingTrack = true

        try {
          const nextTrack = playerState.trackQueue.shift()
          if (nextTrack) {
            console.log(`Подготовка к воспроизведению следующего трека: ${nextTrack.title}`)
            const nextTrackInfo = this.yandexMusicService.trackToTrackInfo(nextTrack)

            const success = await this.playTrack(player, nextTrackInfo, accessToken, stationId, embedMessage)
            if (!success) {
              console.log(`Не удалось воспроизвести трек: ${nextTrack.title}, ждем 3 секунды перед следующей попыткой`)

              setTimeout(() => {
                isLoadingTrack = false
                player.emit(AudioPlayerStatus.Idle)
              }, 2000)
            } else {
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

        isLoadingTrack = true

        try {
          const loaded = await loadMoreTracks()
          if (loaded) {
            setTimeout(() => {
              isLoadingTrack = false
              player.emit(AudioPlayerStatus.Idle)
            }, 1000)
          } else {
            console.log('Не удалось загрузить новые треки, завершаем воспроизведение')
            // Используем только embedMessage из playerState, чтобы обновлять только самый последний embed
            const currentPlayerState = this.playerStates.get(guildId)
            if (currentPlayerState && currentPlayerState.embedMessage && currentPlayerState.embedMessage.editable) {
              const finalEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('⚠️ Воспроизведение завершено')
                .setDescription('Не удалось загрузить новые треки.')
                .setFooter({ text: 'Яндекс Музыка' })
                .setTimestamp()

              currentPlayerState.embedMessage.edit({ embeds: [finalEmbed], components: [] }).catch((error: Error) => {
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

  /**
   * Запуск периодических проверок активности в голосовом канале и проверки воспроизведения
   */
  private startActivityChecks(guildId: string, voiceChannel: any) {
    this.clearActivityTimers(guildId)

    const checkInterval = setInterval(() => {
      const connection = this.connections.get(guildId)
      const playerState = this.playerStates.get(guildId)

      if (!connection || !playerState) {
        this.clearActivityTimers(guildId)
        return
      }

      const channel = voiceChannel.guild.channels.cache.get(connection.joinConfig.channelId)

      if (!channel || channel.type !== 2) {
        // 2 - это тип голосового канала
        console.log(`Канал для проверки не найден или не является голосовым: ${connection.joinConfig.channelId}`)
        return
      }

      const membersInChannel = channel.members.filter((member: { user: { bot: boolean } }) => !member.user.bot).size

      if (membersInChannel === 0) {
        console.log(`Голосовой канал пуст, запускаем таймер отключения для ${guildId}`)

        if (!this.inactivityTimers.has(guildId)) {
          const timer = setTimeout(() => {
            console.log(`Таймер отключения истек для ${guildId}, отключаемся от пустого канала`)
            this.handleAutoDisconnect(guildId, 'Все пользователи покинули голосовой канал')
          }, this.EMPTY_CHANNEL_TIMEOUT)

          this.inactivityTimers.set(guildId, timer)
        }
      } else {
        if (this.inactivityTimers.has(guildId)) {
          console.log(`В канале есть пользователи, сбрасываем таймер неактивности для ${guildId}`)
          clearTimeout(this.inactivityTimers.get(guildId))
          this.inactivityTimers.delete(guildId)
        }
      }

      const player = this.players.get(guildId)
      if (
        (player && player.state.status === AudioPlayerStatus.Idle) ||
        player?.state.status === AudioPlayerStatus.Paused
      ) {
        if (!this.pauseTimers.has(guildId)) {
          console.log(`Плеер не воспроизводит музыку, запускаем таймер отключения для ${guildId}`)

          const timer = setTimeout(() => {
            console.log(`Таймер паузы истек для ${guildId}, отключаемся из-за отсутствия воспроизведения`)
            this.handleAutoDisconnect(guildId, 'Нет активного воспроизведения музыки')
          }, this.NO_PLAYBACK_TIMEOUT)

          this.pauseTimers.set(guildId, timer)
        }
      } else if (player && player.state.status === AudioPlayerStatus.Playing) {
        if (this.pauseTimers.has(guildId)) {
          console.log(`Плеер воспроизводит музыку, сбрасываем таймер паузы для ${guildId}`)
          clearTimeout(this.pauseTimers.get(guildId))
          this.pauseTimers.delete(guildId)
        }
      }
    }, 5000)

    const existingIntervals = this.playerStates.get(guildId)?.checkIntervals || []

    if (this.playerStates.get(guildId)) {
      this.playerStates.get(guildId)!.checkIntervals = [
        ...existingIntervals,
        checkInterval as unknown as NodeJS.Timeout
      ]
    }
  }

  private handleConnectionLost(guildId: string, reason: string) {
    const playerState = this.playerStates.get(guildId)
    const connection = this.connections.get(guildId)

    console.log(`[${guildId}] Обработка потери соединения: ${reason}`)

    if (playerState?.embedMessage?.editable) {
      const disconnectEmbed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('⚠️ Соединение потеряно')
        .setDescription(
          `${reason}\n\nВоспроизведение остановлено. Используйте команду /my-wave для повторного запуска.`
        )
        .setFooter({ text: 'Яндекс Музыка' })
        .setTimestamp()

      playerState.embedMessage.edit({ embeds: [disconnectEmbed], components: [] }).catch(error => {
        console.error('Ошибка при обновлении сообщения о потере соединения:', error)
      })
    }

    // Уничтожаем соединение если оно ещё существует
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        connection.destroy()
      } catch (error) {
        console.error(`[${guildId}] Ошибка при уничтожении соединения:`, error)
      }
    }

    this.cleanupPlayer(guildId)
  }

  /**
   * Обработчик автоматического отключения
   */
  private handleAutoDisconnect(guildId: string, reason: string) {
    const player = this.players.get(guildId)
    const connection = this.connections.get(guildId)
    const playerState = this.playerStates.get(guildId)

    if (!player || !connection || !playerState) {
      return
    }

    console.log(`Автоматическое отключение для ${guildId}. Причина: ${reason}`)

    if (playerState.embedMessage && playerState.embedMessage.editable) {
      const disconnectEmbed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('⏹️ Воспроизведение остановлено')
        .setDescription(`Автоматическое отключение: ${reason}`)
        .setFooter({ text: 'Яндекс Музыка' })
        .setTimestamp()

      playerState.embedMessage.edit({ embeds: [disconnectEmbed], components: [] }).catch(error => {
        console.error('Ошибка при обновлении сообщения при автоматическом отключении:', error)
      })
    }

    player.stop()
    connection.destroy()

    this.cleanupPlayer(guildId)
  }

  /**
   * Очистка всех ресурсов плеера
   */
  private cleanupPlayer(guildId: string) {
    this.clearActivityTimers(guildId)

    const playerState = this.playerStates.get(guildId)
    if (playerState && playerState.checkIntervals) {
      for (const interval of playerState.checkIntervals) {
        clearInterval(interval)
      }
    }

    this.players.delete(guildId)
    this.connections.delete(guildId)
    this.playerStates.delete(guildId)
    this.currentResources.delete(guildId)
  }

  /**
   * Очистка таймеров активности
   */
  private clearActivityTimers(guildId: string) {
    if (this.inactivityTimers.has(guildId)) {
      clearTimeout(this.inactivityTimers.get(guildId))
      this.inactivityTimers.delete(guildId)
    }

    if (this.pauseTimers.has(guildId)) {
      clearTimeout(this.pauseTimers.get(guildId))
      this.pauseTimers.delete(guildId)
    }
  }
}
