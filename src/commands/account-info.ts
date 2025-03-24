import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from 'discord.js'

import { TokenStoreService } from '../services/token-store.service.js'
import { IUserData } from '../types/userData.js'

export const data = new SlashCommandBuilder()
  .setName('account-info')
  .setDescription('Отобразить данные, полученные от Яндекса')

export async function execute(interaction: ChatInputCommandInteraction) {
  const userDiscordId = interaction.user.id
  const userData: IUserData | undefined = TokenStoreService.getInstance().getData(userDiscordId)

  if (!userData) {
    return interaction.reply({
      content: 'Вы не авторизованы! Используйте команду /login для входа в Яндекс Музыку',
      ephemeral: true
    })
  }

  // Создаем embed с информацией о пользователе
  const userEmbed = new EmbedBuilder()
    .setColor('#86cecb')
    .setTitle('Информация о вашем аккаунте Яндекс')
    .setThumbnail(
      // eslint-disable-next-line no-constant-binary-expression
      `https://avatars.mds.yandex.net/get-yapic/${userData.userInfo.avatarUrl}/islands-retina-50` ||
        'https://music.yandex.ru/i/ytimg/static/favicon_200.png'
    )
    .addFields(
      {
        name: 'Имя пользователя',
        value: userData.userInfo.fullName || 'Нет данных',
        inline: true
      },
      { name: 'ID', value: userData.userInfo.id, inline: true }
    )
    .setFooter({
      text: 'Яндекс Музыка',
      iconURL: 'https://music.yandex.ru/i/ytimg/static/favicon_200.png'
    })
    .setTimestamp()

  // Отправляем embed
  return interaction.reply({ embeds: [userEmbed], ephemeral: true })
}
