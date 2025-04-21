import { Events, Interaction } from 'discord.js'

export const name = Events.InteractionCreate
export const once = false

export async function execute(interaction: Interaction) {
  // Обработка взаимодействий здесь, если не используете централизованную обработку в index.ts
  // Например, можно добавить логирование всех взаимодействий, но пока только логирование, хз чё ещё надо

  // Создаем объект с основной информацией о взаимодействии
  const interactionInfo = {
    id: interaction.id,
    type: interaction.type,
    // Проверяем тип взаимодействия и добавляем соответствующую информацию
    commandName:
      'isChatInputCommand' in interaction && interaction.isChatInputCommand() ? interaction.commandName : 'не команда',
    isButton: 'isButton' in interaction && interaction.isButton(),
    isChatInputCommand: 'isChatInputCommand' in interaction && interaction.isChatInputCommand(),
    isMessageComponent: 'isMessageComponent' in interaction && interaction.isMessageComponent()
  }

  // Выводим информацию о взаимодействии в виде строки JSON
  console.log(`Получено взаимодействие: ${JSON.stringify(interactionInfo)} от ${interaction.user.tag}`)
}
