import { ChatInputCommandInteraction } from 'discord.js'

export interface IPlayerOptions {
  interaction: ChatInputCommandInteraction
  voiceChannel: any
  accessToken: string
  userId: string
  stationId: string
}
