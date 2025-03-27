import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js'

import { DatabaseService } from '../services/database.service.js'

export const data = new SlashCommandBuilder().setName('logout').setDescription('Выйти из аккаунта Яндекса')

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id
  const db = DatabaseService.getInstance()

  if (!db.hasUserToken(userId)) {
    await interaction.reply({
      content: 'Вы не авторизованы через Яндекс. Используйте `/login` чтобы авторизоваться.',
      ephemeral: true
    })
    return
  }

  db.removeUserToken(userId)

  await interaction.reply({
    content: 'Вы успешно удалили данные Яндекс аккаунта у бота!',
    ephemeral: true
  })
}
