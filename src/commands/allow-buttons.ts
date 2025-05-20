import { ChatInputCommandInteraction, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js'

import { PlayerService } from '../services/player.service.js'
import config from '../config.js'

export const data = new SlashCommandBuilder()
  .setName('allow-buttons')
  .setDescription('Включить/выключить публичный доступ к управлению плеером')
  .addBooleanOption(option => option.setName('enabled').setDescription('Включить или выключить').setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

export async function execute(interaction: ChatInputCommandInteraction) {
  const isEnabled = interaction.options.getBoolean('enabled', true)
  const guildId = interaction.guild?.id

  if (!guildId) {
    await interaction.reply({
      content: 'Эта команда может быть использована только на сервере.',
      ephemeral: true
    })
    return
  }

  // Проверяем, имеет ли пользователь права на выполнение команды
  // 1. Пользователь должен быть администратором сервера или
  // 2. Пользователь должен быть в списке глобальных администраторов
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || false
  const isGlobalAdmin = config.admins.includes(interaction.user.id) || config.admins.includes(interaction.user.username)

  if (!isAdmin && !isGlobalAdmin) {
    await interaction.reply({
      content:
        'У вас нет прав на выполнение этой команды. Она доступна только администраторам сервера и глобальным администраторам бота.',
      ephemeral: true
    })
    return
  }

  const playerService = PlayerService.getInstance()
  const success = playerService.setPublicButtonsAccess(guildId, isEnabled)

  if (success) {
    await interaction.reply({
      content: isEnabled
        ? 'Публичный доступ к управлению плеером включен для этого сервера. Теперь любой пользователь может управлять плеером.'
        : 'Публичный доступ к управлению плеером выключен для этого сервера. Только пользователь, запустивший воспроизведение, может управлять плеером.',
      ephemeral: false
    })
  } else {
    await interaction.reply({
      content: 'Не удалось изменить настройки доступа к кнопкам плеера.',
      ephemeral: true
    })
  }
}
