import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import Database from 'better-sqlite3'

import { IUserData } from '../types/userData.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export class DatabaseService {
  private static instance: DatabaseService
  private db: Database.Database

  private constructor() {
    const dbDir = path.join(__dirname, '../../data')
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }

    const dbPath = path.join(dbDir, 'users.db')
    this.db = new Database(dbPath)

    this.db.pragma('foreign_keys = ON')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        discord_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        yandex_id TEXT NOT NULL,
        full_name TEXT,
        first_name TEXT,
        last_name TEXT,
        nick_name TEXT,
        avatar_url TEXT,
        has_plus BOOLEAN NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    console.log('База данных инициализирована')
  }

  static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService()
    }
    return DatabaseService.instance
  }

  saveUserToken(discordId: string, accessToken: string, userInfo: IUserData): void {
    const stmt = this.db.prepare(`
      INSERT INTO users (
        discord_id, access_token, yandex_id, full_name, first_name, last_name, 
        nick_name, avatar_url, has_plus, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(discord_id) DO UPDATE SET
        access_token = excluded.access_token,
        yandex_id = excluded.yandex_id,
        full_name = excluded.full_name,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        nick_name = excluded.nick_name,
        avatar_url = excluded.avatar_url,
        has_plus = excluded.has_plus,
        updated_at = CURRENT_TIMESTAMP
    `)

    stmt.run(
      discordId,
      accessToken,
      userInfo.id,
      userInfo.fullName,
      userInfo.firstName,
      userInfo.lastName,
      userInfo.nickName,
      userInfo.avatarUrl,
      userInfo.hasPlus ? 1 : 0
    )
  }

  hasUserToken(discordId: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM users WHERE discord_id = ?')
    const result = stmt.get(discordId)
    return !!result
  }

  removeUserToken(discordId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM users WHERE discord_id = ?')
    const result = stmt.run(discordId)
    return result.changes > 0
  }

  getUserData(discordId: string): { accessToken: string; userInfo: IUserData } | undefined {
    const stmt = this.db.prepare(`
      SELECT 
        access_token, yandex_id, full_name, first_name, last_name, 
        nick_name, avatar_url, has_plus
      FROM users 
      WHERE discord_id = ?
    `)

    const row = stmt.get(discordId) as any

    if (!row) {
      return undefined
    }

    return {
      accessToken: row.access_token,
      userInfo: {
        id: row.yandex_id,
        fullName: row.full_name,
        firstName: row.first_name,
        lastName: row.last_name,
        nickName: row.nick_name,
        avatarUrl: row.avatar_url,
        hasPlus: !!row.has_plus
      }
    }
  }

  get userCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM users')
    const result = stmt.get() as { count: number }
    return result.count
  }

  close(): void {
    this.db.close()
  }
}
