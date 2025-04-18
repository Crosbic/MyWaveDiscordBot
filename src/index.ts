import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { Client, Collection, Events, GatewayIntentBits } from 'discord.js'

import axios from 'axios'
import bodyParser from 'body-parser'
import express from 'express'

import config from './config.js'
import { DatabaseService } from './services/database.service.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const db = DatabaseService.getInstance()

declare module 'discord.js' {
  interface Client {
    commands: Collection<string, any>
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ]
})

client.commands = new Collection()

const commandsPath = path.join(__dirname, 'commands')
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js') || file.endsWith('.ts'))

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file)
  // Используем динамический импорт для ESM
  const command = await import(`file://${filePath}`)

  // Устанавливаем новую команду в коллекцию клиента
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command)
  } else {
    console.log(`[ПРЕДУПРЕЖДЕНИЕ] Команда в ${filePath} отсутствует обязательное свойство "data" или "execute".`)
  }
}

const eventsPath = path.join(__dirname, 'events')
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js') || file.endsWith('.ts'))

for (const file of eventFiles) {
  const filePath = path.join(eventsPath, file)
  const event = await import(`file://${filePath}`)

  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args))
  } else {
    client.on(event.name, (...args) => event.execute(...args))
  }
}

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return

  const command = client.commands.get(interaction.commandName)

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
})

client.once(Events.ClientReady, readyClient => {
  console.log(`Бот запущен как ${readyClient.user.tag}`)
})

client.login(config.token).then(_ => console.log('Логин по токену успешен'))

const app = express()
const API_PORT = process.env.API_PORT || 3001

app.use(bodyParser.json())

app.post('/auth/callback', async (req: any, res: any) => {
  const { userId, accessToken, userInfo } = req.body
  const discordUser = client.users.cache.get(userId)
  const response = await axios.get('https://api.music.yandex.net/account/status', {
    headers: {
      Authorization: `OAuth ${accessToken}`
    }
  })

  if (!userId || !accessToken || !userInfo) {
    return res.status(400).json({
      success: false,
      message: 'Не получены все нужные данные'
    })
  }

  userInfo.hasPlus = response.data.result.plus.hasPlus

  if (userInfo.hasPlus) {
    db.saveUserToken(userId, accessToken, userInfo)
    console.log(`Получен токен для пользователя ${userId} ${accessToken}`)
  }

  if (discordUser) {
    if (!userInfo.hasPlus) {
      discordUser
        .send(`Для авторизации на аккаунте Яндекса должна быть активна подписка Плюс.`)
        .catch(error => console.error('Не удалось отправить сообщение пользователю:', error))

      return res.status(403).json({ success: false, message: 'Отсутствует активная подписка Плюс' })
    } else {
      discordUser
        .send(`Вы успешно авторизовались через Яндекс! Подписка Плюс активна. Теперь можно использовать команды бота.`)
        .catch(error => console.error('Не удалось отправить сообщение пользователю:', error))
    }
  }

  return res.json({ success: true })
})

app.get('/health', (_, res) => {
  res.json({ status: 'ok', userTokensCount: db.userCount })
})

app.listen(API_PORT, () => {
  console.log(`API для авторизации запущен на порту ${API_PORT}`)
})

process.on('SIGINT', () => {
  console.log('Получен сигнал завершения работы, закрываем соединение с базой данных...')
  DatabaseService.getInstance().close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('Получен сигнал завершения работы, закрываем соединение с базой данных...')
  DatabaseService.getInstance().close()
  process.exit(0)
})
