import axios from 'axios'

import { ITrackInfo } from '../types/trackInfo.js'
import { IUserData } from '../types/userData.js'
import { IYandexTrack, IYandexTrackSequenceItem } from '../types/yandexTrack.js'

export class YandexMusicService {
  private static instance: YandexMusicService

  private constructor() {}

  public static getInstance(): YandexMusicService {
    if (!YandexMusicService.instance) {
      YandexMusicService.instance = new YandexMusicService()
    }
    return YandexMusicService.instance
  }

  /**
   * Получение информации о станции
   */
  public async getStationInfo(token: string, stationId: string) {
    try {
      const response = await axios.get(`https://api.music.yandex.net/rotor/station/${stationId}/info`, {
        headers: {
          Authorization: `OAuth ${token}`
        }
      })
      return response.data
    } catch (error: any) {
      console.error('Ошибка при получении информации о станции:', error)
      throw new Error('Не удалось получить информацию о станции')
    }
  }

  /**
   * Отправка фидбэка о начале воспроизведения станции
   */
  public async sendStationStartedFeedback(token: string, stationId: string) {
    try {
      const now = new Date().toISOString().replace('Z', '')
      const response = await axios.post(
        `https://api.music.yandex.net/rotor/station/${stationId}/feedback`,
        {
          type: 'radioStarted',
          timestamp: now,
          from: 'ym-player-bot',
          totalPlayedSeconds: 0
        },
        {
          headers: {
            Authorization: `OAuth ${token}`,
            'Content-Type': 'application/json'
          }
        }
      )
      return response.data
    } catch (error: any) {
      console.error('Ошибка при отправке фидбэка о начале воспроизведения станции:', error)
      throw new Error('Не удалось отправить фидбэк о начале воспроизведения станции')
    }
  }

  /**
   * Получение треков станции
   */
  public async getStationTracks(token: string, stationId: string): Promise<IYandexTrack[]> {
    try {
      const response = await axios.get(
        `https://api.music.yandex.net/rotor/station/${stationId}/tracks?settings=2=true`,
        {
          headers: {
            Authorization: `OAuth ${token}`
          }
        }
      )
      return response.data.result.sequence.map((track: IYandexTrackSequenceItem) => {
        return {
          id: track.track.id,
          title: track.track.title,
          artists: track.track.artists,
          albums: track.track.albums,
          coverUri: track.track.coverUri
        }
      })
    } catch (error: any) {
      console.error('Ошибка при получении треков станции:', error)
      throw new Error('Не удалось получить треки станции')
    }
  }

  /**
   * Отправка фидбэка о начале воспроизведения трека
   */
  public async sendTrackStartedFeedback(token: string, stationId: string, trackId: string) {
    try {
      const now = new Date().toISOString().replace('Z', '')
      const payload: any = {
        type: 'trackStarted',
        timestamp: now,
        from: 'ym-player-bot',
        totalPlayedSeconds: 0,
        trackId: trackId
      }
      const response = await axios.post(`https://api.music.yandex.net/rotor/station/${stationId}/feedback`, payload, {
        headers: {
          Authorization: `OAuth ${token}`,
          'Content-Type': 'application/json'
        }
      })
      return response.data
    } catch (error: any) {
      console.error('Ошибка при отправке фидбэка о начале воспроизведения трека:', error)
      throw new Error('Не удалось отправить фидбэк о начале воспроизведения трека')
    }
  }

  /**
   * Получение URL для стриминга трека
   */
  public async getStreamUrl(token: string, trackId: string): Promise<string | null> {
    try {
      // Получаем информацию о загрузке трека
      const downloadInfoResponse = await axios.get(`https://api.music.yandex.net/tracks/${trackId}/download-info`, {
        headers: {
          Authorization: `OAuth ${token}`
        }
      })
      if (
        !downloadInfoResponse.data ||
        !downloadInfoResponse.data.result ||
        downloadInfoResponse.data.result.length === 0
      ) {
        console.error('Не удалось получить информацию о загрузке трека')
        return null
      }
      const downloadInfo = downloadInfoResponse.data.result[0]
      const downloadUrlResponse = await axios.get(`${downloadInfo.downloadInfoUrl}&format=json`, {
        headers: {
          Authorization: `OAuth ${token}`
        }
      })
      if (
        !downloadUrlResponse.data ||
        !downloadUrlResponse.data.host ||
        !downloadUrlResponse.data.path ||
        !downloadUrlResponse.data.s
      ) {
        console.error('Не удалось получить URL для загрузки трека')
        return null
      }

      return `https://${downloadUrlResponse.data.host}/get-mp3/${downloadUrlResponse.data.s}/${downloadUrlResponse.data.ts}${downloadUrlResponse.data.path}`
    } catch (error: any) {
      console.error('Ошибка при получении URL для стриминга:', error)
      return null
    }
  }

  /**
   * Преобразование трека в информацию о треке
   */
  public trackToTrackInfo(track: IYandexTrack): ITrackInfo {
    return {
      id: track.id,
      title: track.title,
      artist: track.artists.map((artist: { name: string }) => artist.name).join(', '),
      album: track.albums[0]?.title || 'Неизвестный альбом',
      coverUrl: track.coverUri ? `https://${track.coverUri.replace('%%', '400x400')}` : null
    }
  }

  /**
   * Получение информации о пользователе
   */
  public async getUserInfo(token: string): Promise<{ userInfo: IUserData; hasPlus: boolean } | null> {
    try {
      const statusResponse = await axios.get('https://api.music.yandex.net/account/status', {
        headers: {
          Authorization: `OAuth ${token}`
        }
      })

      const userResponse = await axios.get('https://login.yandex.ru/info?format=json', {
        headers: {
          Authorization: `OAuth ${token}`
        }
      })

      if (!statusResponse.data || !statusResponse.data.result) {
        console.error(`Не удалось выполнить запрос https://api.music.yandex.net/account/status с token=${token}`)
        return null
      }

      if (!userResponse.data) {
        console.error(`Не удалось выполнить запрос https://login.yandex.ru/info?format=json с token=${token}`)
        return null
      }

      const user = userResponse.data
      const hasPlus = statusResponse.data.result.plus?.hasPlus || false

      const userInfo: IUserData = {
        id: user.id,
        fullName: user.real_name || '',
        firstName: user.first_name || '',
        lastName: user.last_name || '',
        nickName: user.display_name || '',
        avatarUrl: user.default_avatar_id || '',
        hasPlus: hasPlus
      }

      return { userInfo, hasPlus }
    } catch (error: any) {
      console.error('Ошибка при получении информации о пользователе:', error)
      if (error.response) {
        console.error('Статус ответа:', error.response.status)
        console.error('Данные ответа:', error.response.data)
      }
      return null
    }
  }

  /**
   * Добавление трека в список понравившихся
   */
  public async likeTrack(token: string, userId: string, trackId: string): Promise<boolean> {
    try {
      console.log(`Добавление трека ${trackId} в избранное для пользователя ${userId}`)

      const data = `track_ids=${trackId}`

      console.log(`Отправляемые данные: ${data}`)
      console.log(`URL запроса: https://api.music.yandex.net/users/${userId}/likes/tracks/add-multiple`)

      const response = await axios({
        method: 'post',
        url: `https://api.music.yandex.net/users/${userId}/likes/tracks/add-multiple`,
        data: data,
        headers: {
          Authorization: `OAuth ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      })

      console.log(`Ответ сервера при добавлении трека в избранное: ${response.status}`)
      return response.status === 200
    } catch (error: any) {
      console.error('Ошибка при добавлении трека в список понравившихся:', error)
      if (error.response) {
        console.error('Статус ответа:', error.response.status)
        console.error('Данные ответа:', error.response.data)
        console.error('Заголовки ответа:', error.response.headers)
      } else if (error.request) {
        console.error('Запрос был отправлен, но ответ не получен:', error.request)
      } else {
        console.error('Ошибка при настройке запроса:', error.message)
      }
      console.error('Конфигурация запроса:', error.config)
      return false
    }
  }
}
