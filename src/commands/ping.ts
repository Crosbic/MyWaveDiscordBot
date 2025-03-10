import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js'

export const data = new SlashCommandBuilder().setName('ping').setDescription('Отвечает pong!')

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.reply({ content: 'Измеряем пинг...', withResponse: true })

  const apiLatency = interaction.client.ws.ping

  await interaction.editReply({
    content: `Pong! Задержка API: ${apiLatency}ms`
  })
}
