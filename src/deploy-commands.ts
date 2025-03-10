import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { REST, Routes } from 'discord.js'

import config from './config.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const commands = []
const commandsPath = path.join(__dirname, 'commands')
const commandFiles = fs
  .readdirSync(commandsPath)
  .filter(file => file.endsWith('.js') || file.endsWith('.ts'))

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file)
  const command = await import(`file://${filePath}`)

  if ('data' in command && 'execute' in command) {
    commands.push(command.data.toJSON())
  } else {
    console.log(
      `[ПРЕДУПРЕЖДЕНИЕ] Команда в ${filePath} отсутствует обязательное свойство "data" или "execute".`
    )
  }
}

const rest = new REST().setToken(config.token)

;(async () => {
  try {
    console.log(`Начинаем регистрацию ${commands.length} слеш-команд.`)

    let data
    if (config.devGuildId) {
      data = await rest.put(Routes.applicationGuildCommands(config.clientId, config.devGuildId), {
        body: commands
      })
      console.log(
        `Успешно зарегистрировано ${(data as any[]).length} команд на сервере разработки.`
      )
    } else {
      data = await rest.put(Routes.applicationCommands(config.clientId), { body: commands })
      console.log(`Успешно зарегистрировано ${(data as any[]).length} глобальных команд.`)
    }
  } catch (error) {
    console.error(error)
  }
})()
