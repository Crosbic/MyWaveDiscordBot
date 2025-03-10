import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js'

export const data = new SlashCommandBuilder().setName('ping').setDescription('Отвечает pong!')

export async function execute(interaction: ChatInputCommandInteraction) {
  // Вариант 1: Используем reply с получением ответа через withResponse
  await interaction.reply({ content: 'Измеряем пинг...', withResponse: true })

  // Измеряем задержку на основе времени
  const apiLatency = interaction.client.ws.ping

  // Редактируем ответ с информацией о задержке
  await interaction.editReply({
    content: `Pong! Задержка API: ${apiLatency}ms`
  })
}
