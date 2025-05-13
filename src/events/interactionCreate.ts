import { Events, Interaction } from 'discord.js'

export const name = Events.InteractionCreate
export const once = false

export async function execute(interaction: Interaction) {
  const interactionInfo = {
    id: interaction.id,
    type: interaction.type,
    commandName:
      'isChatInputCommand' in interaction && interaction.isChatInputCommand() ? interaction.commandName : 'не команда',
    isButton: 'isButton' in interaction && interaction.isButton(),
    isChatInputCommand: 'isChatInputCommand' in interaction && interaction.isChatInputCommand(),
    isMessageComponent: 'isMessageComponent' in interaction && interaction.isMessageComponent()
  }

  console.log(`Получено взаимодействие: ${JSON.stringify(interactionInfo)} от ${interaction.user.tag}`)
}
