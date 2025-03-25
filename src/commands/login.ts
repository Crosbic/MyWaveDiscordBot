import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js'

import { TokenStoreService } from '../services/token-store.service.js'

export const data = new SlashCommandBuilder().setName('login').setDescription('Авторизоваться через Яндекс')

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id
  const tokenStore = TokenStoreService.getInstance()

  if (tokenStore.hasToken(userId)) {
    await interaction.reply({
      content: 'Вы уже авторизованы в Яндексе! Используйте `/logout` чтобы выйти.',
      ephemeral: true
    })
    return
  }

  const authUrl = `${process.env.API}/auth?userId=${userId}&debug=true`

  await interaction.reply({
    content: `Для авторизации в Яндексе перейдите по ссылке: ${authUrl}`,
    ephemeral: true
  })
}
