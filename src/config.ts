import 'dotenv/config'

interface Config {
  token: string
  clientId: string
  devGuildId?: string
  admins: string[]
  encryptionKey: string
}

const config: Config = {
  token: process.env.DISCORD_TOKEN || '',
  clientId: process.env.CLIENT_ID || '',
  // devGuildId: process.env.DEV_GUILD_ID
  admins: process.env.ADMINS ? process.env.ADMINS.split(',').map(id => id.trim()) : ['crosbic'],
  encryptionKey: process.env.ENCRYPTION_KEY || ''
}

if (!config.token) {
  throw new Error('DISCORD_TOKEN отсутствует в .env файле')
}

if (!config.clientId) {
  throw new Error('CLIENT_ID отсутствует в .env файле')
}

if (!config.encryptionKey) {
  throw new Error('ENCRYPTION_KEY отсутствует в .env файле (используется для шифрования токенов в БД)')
}

export default config
