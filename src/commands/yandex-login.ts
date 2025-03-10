import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js'

export const data = new SlashCommandBuilder()
  .setName('yandex-login')
  .setDescription('Авторизоваться через Яндекс')

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id

  // Проверяем, авторизован ли уже пользователь (используем глобальную Map из index.ts)
  // @ts-ignore - используем userTokens из глобальной области, объявленной в index.ts
  if (global.userTokens && global.userTokens.has(userId)) {
    await interaction.reply({
      content: 'Вы уже авторизованы в Яндексе!',
      ephemeral: true
    })
    return
  }

  // Формируем URL для авторизации
  // URL к нашему бэкенду авторизации
  const authUrl = `http://localhost:3000/my-wave/auth?userId=${userId}`

  await interaction.reply({
    content: `Для авторизации в Яндексе перейдите по ссылке: ${authUrl}`,
    ephemeral: true
  })
}
