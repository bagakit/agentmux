import type { ConnectionConfig } from '@agentmux/core/connections'
import { readConnectionApiResponse } from '../../connection-api-response.js'
import { telegramConfig, telegramFailure, telegramId, type TelegramUser } from './protocol.js'

export type TelegramResponse = { status: number; data: { ok?: boolean; result?: unknown; error_code?: number; parameters?: { retry_after?: number } } }
/** One native request; no automatic effect retry or secret-bearing exception crosses this boundary. */
export class TelegramClient {
  private readonly identities = new Map<string, { credential: string; appId: string; user: TelegramUser }>()
  constructor(private readonly request: typeof fetch = fetch) {}
  release(connectionId: string): void { this.identities.delete(connectionId) }
  close(): void { this.identities.clear() }
  async call(credential: string, method: string, body?: unknown, signal?: AbortSignal): Promise<TelegramResponse> {
    if (!/^[0-9]+:[A-Za-z0-9_-]+$/u.test(credential) || !/^[a-z][a-zA-Z0-9]*$/u.test(method)) return telegramFailure('TELEGRAM_REQUEST_INVALID')
    try {
      const response = await this.request(`https://api.telegram.org/bot${credential}/${method}`, { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), ...(signal ? { signal } : {}) })
      // Native custody consumes a protocol page of up to 100 updates. Public
      // business-response budgets cannot truncate that page and stall its cursor.
      const parsed = method === 'getUpdates' ? { format: 'json', value: await response.json() } : await readConnectionApiResponse({ body: response.body, contentType: response.headers.get('content-type'), contentLength: response.headers.get('content-length'), cancel: () => response.body?.cancel() })
      if (parsed.format !== 'json' || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return telegramFailure('TELEGRAM_RESPONSE_UNCONFIRMED')
      return { status: response.status, data: parsed.value as TelegramResponse['data'] }
    } catch { return telegramFailure('TELEGRAM_REQUEST_UNCONFIRMED') }
  }
  async identity(config: ConnectionConfig, credential: string, signal?: AbortSignal, refresh = false): Promise<TelegramUser> {
    telegramConfig(config)
    const old = this.identities.get(config.connectionId)
    if (!refresh && old?.credential === credential && old.appId === config.application.appId) return old.user
    const response = await this.call(credential, 'getMe', undefined, signal), user = response.data.result as TelegramUser | undefined
    if (user && ['username', 'first_name', 'last_name'].some(key => Object.hasOwn(user, key) && typeof user[key as keyof TelegramUser] !== 'string')) return telegramFailure('TELEGRAM_RESPONSE_UNCONFIRMED')
    if (response.data.ok === false && [401, 403].includes(response.status) && response.data.error_code === response.status) return telegramFailure('TELEGRAM_AUTHENTICATION_REJECTED')
    if (response.status !== 200 || response.data.ok !== true || !user) return telegramFailure('TELEGRAM_RESPONSE_UNCONFIRMED')
    if (user.is_bot !== true || telegramId(user.id) !== config.application.appId) return telegramFailure('TELEGRAM_APPLICATION_MISMATCH')
    this.identities.set(config.connectionId, { credential, appId: config.application.appId, user })
    return user
  }
}
