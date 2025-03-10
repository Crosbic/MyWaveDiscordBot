export class TokenStoreService {
  private static instance: TokenStoreService
  private tokenMap = new Map<
    string,
    {
      accessToken: string
      userInfo: any
    }
  >()

  private constructor() {}

  static getInstance(): TokenStoreService {
    if (!TokenStoreService.instance) {
      TokenStoreService.instance = new TokenStoreService()
    }
    return TokenStoreService.instance
  }

  setToken(userId: string, accessToken: string, userInfo: any): void {
    this.tokenMap.set(userId, { accessToken, userInfo })
  }

  hasToken(userId: string): boolean {
    return this.tokenMap.has(userId)
  }

  removeToken(userId: string): boolean {
    return this.tokenMap.delete(userId)
  }

  getData(userId: string): { accessToken: string; userInfo: any } | undefined {
    return this.tokenMap.get(userId)
  }

  get size(): number {
    return this.tokenMap.size
  }
}
