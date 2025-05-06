import { Message } from 'discord.js'

import { ITrackInfo } from './trackInfo.js'
import { IYandexTrack } from './yandexTrack.js'

export interface IPlayerState {
  isPlaying: boolean
  currentTrack: ITrackInfo | null
  previousTracks: IYandexTrack[]
  trackQueue: IYandexTrack[]
  accessToken: string
  userId: string
  discordUserId: string
  stationId: string
  embedMessage: Message | undefined
  trackStartTime: number | null
  retryCount: number
  lastTrackId: string | null
  skipRequested: boolean
}
