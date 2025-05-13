import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js'

import { DatabaseService } from '../services/database.service.js'
import { YandexMusicService } from '../services/yandex-music.service.js'

export const data = new SlashCommandBuilder()
  .setName('login')
  .setDescription('Авторизация через Яндекс, используя токен')
  .addStringOption(option => option.setName('token').setDescription('Токен доступа Яндекс').setRequired(true))

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id
  const db = DatabaseService.getInstance()
  const yandexMusicService = YandexMusicService.getInstance()

  if (db.hasUserToken(userId)) {
    await interaction.reply({
      content: 'Вы уже авторизованы через Яндекс! Используйте `/logout` чтобы выйти и авторизоваться заново.',
      ephemeral: true
    })
    return
  }

  const token = interaction.options.getString('token')
  if (!token) {
    await interaction.reply({
      content: 'Токен не предоставлен. Используйте команду `/token ВАШТОКЕН`.',
      ephemeral: true
    })
    return
  }

  await interaction.deferReply({ ephemeral: true })

  try {
    const userInfoResult = await yandexMusicService.getUserInfo(token)

    if (!userInfoResult) {
      await interaction.editReply({
        content: 'Не удалось получить информацию о пользователе. Проверьте правильность токена и попробуйте снова.'
      })
      return
    }

    const { userInfo, hasPlus } = userInfoResult

    if (!hasPlus) {
      await interaction.editReply({
        content:
          'Для использования бота требуется активная подписка Яндекс Плюс. Активируйте подписку и попробуйте снова.'
      })
      return
    }

    db.saveUserToken(userId, token, userInfo)

    await interaction.editReply({
      content: `Авторизация успешно завершена! Вы вошли как ${userInfo.nickName}. Теперь вы можете использовать команды бота.`
    })
  } catch (error) {
    console.error('Ошибка при авторизации:', error)
    await interaction.editReply({
      content: 'Произошла ошибка при авторизации. Пожалуйста, попробуйте позже или обратитесь к администратору.'
    })
  }
}
