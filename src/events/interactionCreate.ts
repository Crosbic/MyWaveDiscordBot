import { Events, Interaction } from 'discord.js'

export const name = Events.InteractionCreate
export const once = false

export async function execute(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return

  const command = interaction.client.commands.get(interaction.commandName)

  if (!command) {
    console.error(`Команда ${interaction.commandName} не найдена.`)
    return
  }

  try {
    await command.execute(interaction)
  } catch (error) {
    console.error(error)

    const replyOptions = {
      content: 'Произошла ошибка при выполнении команды!',
      ephemeral: true
    }

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(replyOptions)
    } else {
      await interaction.reply(replyOptions)
    }
  }
}
