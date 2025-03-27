import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js'

import { DatabaseService } from '../services/database.service.js'

export const data = new SlashCommandBuilder().setName('login').setDescription('Авторизоваться через Яндекс')

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id
  const db = DatabaseService.getInstance()

  if (db.hasUserToken(userId)) {
    await interaction.reply({
      content: 'Вы уже авторизованы через Яндекс! Используйте `/logout` чтобы выйти.',
      ephemeral: true
    })
    return
  }

  const debug = process.env.DEBUG
  const authUrl = `${process.env.API}/auth?userId=${userId}&debug=${debug}`

  await interaction.reply({
    content: `Для авторизации через Яндекс перейдите по ссылке: ${authUrl}`,
    ephemeral: true
  })
}
