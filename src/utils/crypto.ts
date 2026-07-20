import crypto from 'crypto'

import config from '../config.js'

const ENCRYPTION_PREFIX = 'enc:v1:'
const ALGORITHM = 'aes-256-gcm'

// Ключ выводится из ENCRYPTION_KEY детерминированно, чтобы расшифровка работала между перезапусками.
const key = crypto.scryptSync(config.encryptionKey, 'ym-player-bot:token-salt', 32)

/**
 * Шифрует строку. Результат самоописываемый: enc:v1:<iv>:<authTag>:<ciphertext> (hex).
 */
export function encrypt(plainText: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return `${ENCRYPTION_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

/**
 * Расшифровывает строку. Значения без префикса считаются старыми plaintext-токенами
 * и возвращаются как есть — это обеспечивает миграцию уже сохранённых записей.
 */
export function decrypt(value: string): string {
  if (!value.startsWith(ENCRYPTION_PREFIX)) {
    return value
  }

  const [ivHex, authTagHex, cipherHex] = value.slice(ENCRYPTION_PREFIX.length).split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  return Buffer.concat([decipher.update(Buffer.from(cipherHex, 'hex')), decipher.final()]).toString('utf8')
}
