import { Events, Interaction } from 'discord.js'

export const name = Events.InteractionCreate
export const once = false

export async function execute(interaction: Interaction) {
  // Обработка взаимодействий здесь, если не используете централизованную обработку в index.ts
  // Например, можно добавить логирование всех взаимодействий
  console.log(`Получено взаимодействие: ${interaction.type} от ${interaction.user.tag}`)
}
