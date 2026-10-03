import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { MobileConnection } from '../conversation/use-hosted-conversation'
import type { NativePrivateAccess } from '../platform/native/private-transport'

type Device = { deviceId: string; name: string; createdAt: number }
export type PrivateConnectionSnapshot = {
  phase: 'unavailable' | 'connecting' | 'needs-approval' | 'waiting' | 'authorized' | 'connected'
  origin: string | null
  hostId: string | null
  device: Device | null
  confirmationCode: string | null
  hostBindingNotice: string | null
  nativeRecovery: 'save-secret' | 'unlock-resume' | 'new-invitation' | null
  client: AgentMuxHostedClient | null
  connection: MobileConnection
}
/** The factory comes from the single public browser Client/Hosted SDK adapter, never this module. */
export type AuthorizedHostedClientFactory = (input: {
  origin: string; hostId: string; signal: AbortSignal; fetch?: typeof globalThis.fetch
}) => Promise<AgentMuxHostedClient>
/** Native implements only admission and raw transport. It never releases a secret to JS. */
export type NativePrivateAdmission = NativePrivateAccess

const PATH = '/_agentmux/device'
const unavailable = '连接与设备授权尚未核实；原会话与草稿仍保留。'
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || !keys.every(key => Object.hasOwn(value, key))) throw new Error('Mac 返回的设备授权状态无法核实。')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128) throw new Error('Mac 返回的设备身份无法核实。')
  return value
}
function device(value: unknown): Device {
  const v = record(value, ['deviceId', 'name', 'createdAt'])
  if (!Number.isSafeInteger(v.createdAt) || (v.createdAt as number) < 0) throw new Error('Mac 返回的设备身份无法核实。')
  return { deviceId: text(v.deviceId), name: text(v.name), createdAt: v.createdAt as number }
}
async function json(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' || !response.body) {
    throw new Error('设备授权入口尚不可用。请核对 Mac 地址，原会话保持。')
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > 4096) throw new Error('Mac 返回的设备授权状态超过读取范围。')
      chunks.push(next.value)
    }
    const joined = new Uint8Array(bytes); let offset = 0
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined))
  } finally { await reader.cancel().catch(() => {}) }
}

/** Browser admission only. Secrets are handled by HTTPS HttpOnly cookies, never this state. */
export class PrivateConnection {
  private value: PrivateConnectionSnapshot = { phase: 'unavailable', origin: null, hostId: null,
    device: null, confirmationCode: null, hostBindingNotice: null, nativeRecovery: null,
    client: null, connection: { state: 'unavailable', message: unavailable } }
  private readonly listeners = new Set<(value: PrivateConnectionSnapshot) => void>()
  private epoch = 0
  private attempt: AbortController | undefined
  private releaseClientEvents: (() => void) | undefined

  constructor(private readonly options: { native: boolean; nativeAccess?: NativePrivateAdmission; connectClient?: AuthorizedHostedClientFactory;
    confirmHost?: (host: { origin: string; hostId: string }) => string | null }) {}
  supportsNativeAccess(): boolean { return this.options.nativeAccess !== undefined }
  snapshot(): PrivateConnectionSnapshot { return this.value }
  observe(listener: (value: PrivateConnectionSnapshot) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener) }
  }
  private publish(patch: Partial<PrivateConnectionSnapshot>): void {
    this.value = { ...this.value, ...patch }
    for (const listener of this.listeners) listener(this.value)
  }
  private sameOrigin(origin: string): boolean {
    if (this.options.native) {
      if (!this.options.nativeAccess) {
        this.publish({ connection: { state: 'unavailable', message: '原生设备的安全授权通道尚未可用。请先使用 Mac 的 HTTPS 手机页面；原会话与草稿保留。' } })
        return false
      }
      try {
        const url = new URL(origin)
        if (url.protocol === 'https:' && url.origin === origin && !url.username && !url.password) return true
      } catch { /* An invalid target has no authority over the original workface. */ }
      this.failure(); return false
    }
    if (!origin.startsWith('https://') || origin !== globalThis.location.origin) {
      this.publish({ connection: { state: this.value.connection.state === 'connected' ? 'connected' : 'unavailable',
        message: '请在这台 Mac 的 HTTPS 手机页面继续连接。当前页面不能代替另一地址的设备授权；原阅读与草稿保留。' } })
      return false
    }
    return true
  }
  private async request(path: string, signal: AbortSignal, input?: unknown): Promise<Response> {
    return await fetch(`${this.value.origin}${path}`, { method: input === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      ...(input === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) })
  }
  private failure(error?: unknown, action?: 'claim'): void {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    const pendingSave = this.value.nativeRecovery === 'save-secret' && this.value.confirmationCode !== null
    if (this.options.native && (code === 'NATIVE_SECRET_STORE_UNCONFIRMED' || (code === 'NATIVE_DEVICE_UNAPPROVED' && pendingSave))) {
      const saving = this.value.confirmationCode !== null && (action === 'claim' || pendingSave)
      this.publish({ phase: saving ? 'waiting' : 'unavailable', nativeRecovery: saving ? 'save-secret' : 'unlock-resume',
        connection: { state: this.value.client ? 'disconnected' : 'unavailable', message: saving
          ? '系统设备秘密保存尚未确认。请解锁设备后重试系统保存；不会重新提交一次授权领取，原会话保留。'
          : '系统设备秘密暂不可读。请解锁设备后重新核对授权；原身份、会话与草稿保留。' } })
      return
    }
    if (this.options.native && code === 'NATIVE_DEVICE_UNAPPROVED') {
      this.publish({ phase: 'needs-approval', confirmationCode: null, nativeRecovery: null, connection: { state: 'unavailable',
        message: '这台原生设备尚无已批准的系统设备凭证。请使用 Mac 的短时邀请，并在 Mac 上核对确认码；原会话与草稿保留。' } })
      return
    }
    if (this.options.native && code === 'NATIVE_CLAIM_UNCONFIRMED') {
      this.publish({ phase: 'needs-approval', confirmationCode: null, nativeRecovery: 'new-invitation',
        connection: { state: this.value.client ? 'disconnected' : 'unavailable',
          message: '一次授权领取的结果未知，不会重新提交。原会话保留；请在 Mac 生成新邀请，重新确认此设备。' } })
      return
    }
    this.publish({ phase: this.value.nativeRecovery === 'new-invitation' ? 'needs-approval' : 'unavailable',
      connection: { state: this.value.client ? 'disconnected' : 'unavailable',
      message: 'Mac 连接或设备授权尚未核实。请核对系统证书信任、Mac 在线状态和设备授权；原阅读与草稿仍保留。' } })
  }
  private cancelAttempt(): number {
    this.attempt?.abort(); this.attempt = new AbortController()
    return ++this.epoch
  }
  /** A link is consumed once; receipt loss is reconciled with the secure device Cookie. */
  async connectLink(origin: string, code: string, name: string): Promise<void> {
    if (!this.sameOrigin(origin)) return
    const epoch = this.cancelAttempt(), signal = this.attempt!.signal
    this.publish({ phase: 'connecting', origin, connection: { state: 'connecting', message: '正在连接你的 Mac…' } })
    try {
      const response = await this.request(`${PATH}/connect`, signal, { code, name })
      if (epoch !== this.epoch) return
      if (!response.ok) {
        this.publish({ phase: 'unavailable', connection: { state: 'unavailable', message: '连接链接已过期、已使用或暂不可用。请在 Mac 设置生成新链接；原会话与草稿保留。' } })
        return
      }
      const approved = record(await json(response), ['state', 'hostId', 'device'])
      if (approved.state !== 'approved') throw new Error('Device exchange is unconfirmed')
      this.publish({ hostId: text(approved.hostId) })
      await this.connectApproved(device(approved.device), epoch, signal)
    } catch {
      if (epoch === this.epoch && !signal.aborted) {
        // Never resend a one-time exchange. Only read the authenticated status.
        await this.resume(origin)
        if (this.value.phase === 'needs-approval') this.publish({ connection: { state: 'unavailable', message: '连接结果尚未确认，未重复使用连接码。请在 Mac 设置生成新链接；原会话保留。' } })
      }
    }
  }

  async resume(origin: string): Promise<void> {
    if (!this.sameOrigin(origin)) return
    const epoch = this.cancelAttempt(), signal = this.attempt!.signal
    this.publish({ phase: 'connecting', origin, connection: { state: 'connecting', message: '正在核对这台 Mac 的设备授权…' } })
    try {
      const infoResponse = this.options.native ? await this.options.nativeAccess!.info(origin, signal) : await this.request(PATH, signal)
      if (!infoResponse.ok) throw new Error('Device endpoint unavailable')
      const hostId = text(record(await json(infoResponse), ['hostId']).hostId)
      if (epoch !== this.epoch) return
      if (this.value.hostId && this.value.hostId !== hostId) throw new Error('Original Host identity changed')
      this.publish({ hostId })
      const status = this.options.native ? await this.options.nativeAccess!.status(origin, hostId, signal) : await this.request(`${PATH}/status`, signal)
      if (epoch !== this.epoch) return
      if (status.status === 401) {
        this.publish({ phase: 'needs-approval', nativeRecovery: this.value.nativeRecovery === 'new-invitation' ? 'new-invitation' : null,
          connection: { state: 'unavailable', message: '请在 Mac 设置生成并复制连接链接，在这台手机打开即可连接。' } })
        return
      }
      if (!status.ok) throw new Error('Device authorization unavailable')
      const approved = record(await json(status), ['hostId', 'device'])
      if (approved.hostId !== hostId) throw new Error('Device approval belongs to another Host')
      await this.connectApproved(device(approved.device), epoch, signal)
    } catch (error) { if (epoch === this.epoch && !signal.aborted) this.failure(error) }
  }
  private async connectApproved(approved: Device, epoch: number, signal: AbortSignal): Promise<void> {
    if (epoch !== this.epoch || signal.aborted) return
    try {
      const notice = this.options.confirmHost?.({ origin: this.value.origin!, hostId: this.value.hostId! }) ?? null
      this.publish({ hostBindingNotice: notice })
    } catch {
      this.publish({ phase: 'unavailable', connection: { state: this.value.client ? 'disconnected' : 'unavailable',
        message: '当前 Mac 与已保全工作面的原 Host 身份无法确认一致。原会话、草稿和未确认输入仍保留；请接回原 Mac，或明确建立另一份设备工作面。' } })
      return
    }
    this.publish({ phase: 'authorized', device: approved, confirmationCode: null, nativeRecovery: null,
      connection: { state: 'unavailable', message: '设备授权已确认，Mac 会话连接尚未建立；原阅读与草稿保留。' } })
    if (!this.options.connectClient) return
    const client = await this.options.connectClient({ origin: this.value.origin!, hostId: this.value.hostId!, signal,
      ...(this.options.native ? { fetch: this.options.nativeAccess!.fetchForHost(this.value.origin!, this.value.hostId!) } : {}) })
    if (epoch !== this.epoch || signal.aborted) { await client.dispose(); return }
    // Only a successful common SDK factory may expose connected state and a new client.
    const previous = this.value.client
    this.releaseClientEvents?.()
    this.releaseClientEvents = client.onEvent(event => {
      if (this.value.client !== client) return
      if (event.type === 'connection-state') this.publish({ connection: event.state === 'restored'
        ? { state: 'connected', message: '已接回原 Mac，会话与未确认输入保持。' }
        : { state: 'disconnected', message: '原 Mac 的会话连接尚未恢复；原阅读与草稿保留，不会重投未知输入。' } })
    })
    this.publish({ phase: 'connected', client, connection: { state: 'connected', message: `已连接原 Mac，设备「${approved.name}」已获独立授权。` } })
    if (previous && previous !== client) await previous.dispose()
  }
  async begin(invitation: string, name: string): Promise<void> {
    if (!this.value.origin || !this.value.hostId || !this.sameOrigin(this.value.origin)) return
    const epoch = this.cancelAttempt(), signal = this.attempt!.signal
    try {
      let result: unknown
      if (this.options.native) result = await this.options.nativeAccess!.begin(this.value.origin, this.value.hostId, invitation.trim(), name.trim(), signal)
      else {
        const response = await this.request(PATH, signal, { hostId: this.value.hostId, invitation: invitation.trim(), name: name.trim() })
        if (!response.ok) throw new Error('Device invitation unavailable')
        result = await json(response)
      }
      const pending = record(result, ['state', 'hostId', 'deviceId', 'confirmationCode', 'expiresAt'])
      if (pending.state !== 'waiting' || pending.hostId !== this.value.hostId || !/^\d{6}$/u.test(String(pending.confirmationCode))
        || !Number.isSafeInteger(pending.expiresAt)) throw new Error('Device approval is unconfirmed')
      text(pending.deviceId)
      if (epoch === this.epoch) this.publish({ phase: 'waiting', confirmationCode: String(pending.confirmationCode), nativeRecovery: null,
        connection: { state: 'unavailable', message: '请在 Mac 上核对相同确认码并批准这台设备。尚未取得会话访问权限。' } })
    } catch (error) { if (epoch === this.epoch && !signal.aborted) this.failure(error) }
  }
  async claim(): Promise<void> {
    if (this.value.nativeRecovery === 'new-invitation') return
    if (!this.value.origin || !this.value.hostId || !this.sameOrigin(this.value.origin)) return
    const epoch = this.cancelAttempt(), signal = this.attempt!.signal
    try {
      let result: unknown
      if (this.options.native) result = await this.options.nativeAccess!.claim(this.value.origin, this.value.hostId, signal)
      else {
        const response = await this.request(`${PATH}/claim`, signal, { hostId: this.value.hostId })
        if (!response.ok) throw new Error('Device approval unavailable')
        result = await json(response)
      }
      if ((result as { state?: string } | null)?.state === 'waiting') {
        const waiting = record(result, ['state', 'hostId'])
        if (waiting.state !== 'waiting' || waiting.hostId !== this.value.hostId) throw new Error('Device approval is unconfirmed')
        if (epoch === this.epoch) this.publish({ connection: { state: 'unavailable', message: 'Mac 尚未批准这台设备，请先在 Mac 上核对确认码。' } })
        return
      }
      const approved = record(result, ['state', 'hostId', 'device'])
      if (approved.state !== 'approved' || approved.hostId !== this.value.hostId) throw new Error('Device approval belongs to another Host')
      if (epoch === this.epoch) await this.connectApproved(device(approved.device), epoch, signal)
    } catch (error) { if (epoch === this.epoch && !signal.aborted) this.failure(error, 'claim') }
  }
  stop(): void {
    ++this.epoch; this.attempt?.abort(); this.releaseClientEvents?.(); this.releaseClientEvents = undefined
    // The SDK releases only this consumer. Keep its last read projection for the workface.
    void this.value.client?.dispose().catch(() => {})
  }
}
