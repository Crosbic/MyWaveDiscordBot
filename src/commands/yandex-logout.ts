import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js'

import { TokenStoreService } from '../services/token-store.service.js'

export const data = new SlashCommandBuilder()
  .setName('yandex-logout')
  .setDescription('Выйти из аккаунта Яндекса')

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id
  const tokenStore = TokenStoreService.getInstance()

  if (!tokenStore.hasToken(userId)) {
    await interaction.reply({
      content: 'Вы не авторизованы в Яндексе. Используйте `/yandex-login` чтобы авторизоваться.',
      ephemeral: true
    })
    return
  }

  tokenStore.removeToken(userId)

  await interaction.reply({
    content: 'Вы успешно вышли из аккаунта Яндекса!',
    ephemeral: true
  })
}
