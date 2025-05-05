import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js'

import { DatabaseService } from '../services/database.service.js'

export const data = new SlashCommandBuilder()
  .setName('login-help')
  .setDescription('Получить инструкции по авторизации через Яндекс')

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

  const authUrl = 'https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d'

  await interaction.reply({
    content: `
Для авторизации через Яндекс выполните следующие шаги:

1. Перейдите по ссылке: ${authUrl}
2. Авторизуйтесь в Яндексе и предоставьте доступ
3. После авторизации вы будете перенаправлены на страницу с URL вида:
   \`https://music.yandex.ru/#access_token=ВАШТОКЕН&token_type=bearer&expires_in=31535645\`
4. Скопируйте значение токена (часть после \`access_token=\` и до \`&\`)
5. Используйте команду \`/login ВАШТОКЕН\` для завершения авторизации

Примечание: Токен действителен в течение года.
`,
    ephemeral: true
  })
}
