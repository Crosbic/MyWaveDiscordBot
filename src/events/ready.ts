import { Client, Events } from 'discord.js'

export const name = Events.ClientReady
export const once = true

export function execute(client: Client) {
  console.log(`Бот успешно запущен как ${client.user?.tag}`)
}
