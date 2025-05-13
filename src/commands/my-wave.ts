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

  const member = interaction.member as GuildMember
  console.log(member.voice.channelId)

  if (!member.voice?.channel) {
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

  const voiceChannel: any =
    member.voice?.channel ||
    (
      await interaction.guild.members.fetch({
        user: interaction.user.id,
        force: true
      })
    ).voice.channel

  const permissions = voiceChannel.permissionsFor(interaction.client.user.id)
  if (!permissions?.has('Connect') || !permissions?.has('Speak')) {
    await interaction.reply({
      content: 'У меня нет прав для подключения или воспроизведения аудио в этом голосовом канале!',
      ephemeral: true
    })
    return
  }

  await interaction.reply({
    content: `Подключаюсь к голосовому каналу "${voiceChannel.name}"...`,
    ephemeral: true
  })

  try {
    const { accessToken } = userData
    const stationId = 'user:onyourwave'

    const playerStatus = playerService.isPlayerActive(interaction.guild.id)
    if (playerStatus.active && playerStatus.discordUserId !== interaction.user.id) {
      await interaction.followUp({
        content:
          'В данный момент плеер уже используется другим пользователем. Дождитесь, пока он остановит воспроизведение.',
        ephemeral: true
      })
      return
    }

    const { player, connection, embedMessage } = await playerService.createPlayer({
      interaction,
      voiceChannel,
      accessToken,
      userId: userData.userInfo.id,
      stationId
    })

    try {
      await yandexMusicService.getStationInfo(accessToken, stationId)
      await yandexMusicService.sendStationStartedFeedback(accessToken, stationId)

      const tracks = await yandexMusicService.getStationTracks(accessToken, stationId)
      if (!tracks || tracks.length === 0) {
        connection.destroy()
        await interaction.followUp({
          content: 'Не удалось получить треки из "Моя волна".',
          ephemeral: true
        })
        return
      }

      const firstTrack = tracks[0]
      const trackInfo = yandexMusicService.trackToTrackInfo(firstTrack)

      const success = await playerService.playTrack(player, trackInfo, accessToken, stationId, embedMessage)
      if (!success) {
        connection.destroy()
        await interaction.followUp({
          content: 'Не удалось воспроизвести трек.',
          ephemeral: true
        })
        return
      }

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
