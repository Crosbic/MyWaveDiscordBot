/**
 * Бросается, когда Яндекс возвращает 401 — токен истёк или отозван.
 * Команды ловят её, чтобы подсказать пользователю переавторизоваться через /login.
 */
export class YandexAuthError extends Error {
  constructor(message = 'Токен Яндекс недействителен или истёк') {
    super(message)
    this.name = 'YandexAuthError'
  }
}
