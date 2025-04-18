export interface IYandexTrack {
  id: string
  title: string
  artists: Array<{ name: string }>
  albums: Array<{ title: string }>
  coverUri: string
}

export interface IYandexTrackSequenceItem {
  track: IYandexTrack
}
