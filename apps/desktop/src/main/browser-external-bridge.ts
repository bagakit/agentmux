import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { WebSocketServer, WebSocket } from 'ws'
import { z } from 'zod'
import { BROWSER_PAGE_CAPABILITY_NAMES, durableWriteFile } from '@agentmux/core'
import type { AgentMuxBrowserTarget, AgentMuxExternalBrowserPairing } from '@agentmux/core'
import { EXTERNAL_BROWSER_PROTOCOL, MAX_BRIDGE_BYTES, EXTERNAL_CDP_METHODS, isShareUrl, isTabScopedCommand } from '../../browser-extension/protocol.js'

const id = z.string().min(1).max(200)
const grantSchema = z.object({ tabId: z.number().int().nonnegative(), grantId: z.string().uuid(),
  navigationId: id, url: z.string().max(8192).refine(isShareUrl), title: z.string().max(512) }).strict()
const savedSchema = grantSchema.extend({ id: z.string().uuid(), workspaceId: id,
  extensionId: z.string().regex(/^[a-p]{32}$/), instanceId: z.string().uuid(),
  status: z.enum(['ready', 'disconnected', 'revoked', 'closed', 'unavailable']), warning: z.string().max(2000).optional(),
  ledgerNavigationId: id.optional() })
const documentSchema = z.object({ version: z.literal(1), targets: z.array(savedSchema).max(64) }).strict()

type Grant = z.infer<typeof grantSchema>
type SavedTarget = z.infer<typeof savedSchema>
export type ExternalBrowserBinding = SavedTarget & { connection: ExternalBrowserConnection | null }
export type ExternalBrowserEvent = { method: string; params: unknown; navigationId: string; sessionId?: string; mainDocumentNavigation: boolean }
export type ExternalBrowserOperationOwner = { operationId: string; callerId: string }
type Connection = { id: string; extensionId: string; instanceId: string; workspaceId: string; socket: WebSocket;
  pending: Map<string, Pending>; targets: Set<string>; byGrant: Map<string, ExternalBrowserBinding> }
type Pending = { binding: ExternalBrowserBinding; navigationId: string; allowNavigation: boolean;
  action: 'attach' | 'detach' | 'command';
  owner: ExternalBrowserOperationOwner; sessionId: string | undefined;
  resolve(value: unknown): void; reject(error: ExternalBrowserRequestFailure): void; timer: ReturnType<typeof setTimeout> }
type Pairing = { workspaceId: string; expiresAt: number; extensionId?: string; instanceId?: string }

export class ExternalBrowserRequestFailure extends Error {
  constructor(message: string, readonly sent: boolean, readonly uncertain = sent) { super(message); this.name = 'ExternalBrowserRequestFailure' }
}

/** A connection is transport, never a grant. Only a matching original binding can issue requests. */
export class ExternalBrowserConnection {
  constructor(private readonly bridge: ExternalBrowserBridge, private readonly connection: Connection) {}
  get id(): string { return this.connection.id }
  request(binding: ExternalBrowserBinding, owner: ExternalBrowserOperationOwner, action: 'attach' | 'detach' | 'command',
    method?: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    return this.bridge.request(this.connection, binding, owner, action, method, params, sessionId)
  }
}

/** Main-owned, loopback-only bridge. It does not create tabs, browser processes, or an Agent Runtime. */
export class ExternalBrowserBridge {
  private readonly targets = new Map<string, ExternalBrowserBinding>()
  private readonly connections = new Set<Connection>()
  private readonly pairings = new Map<string, Pairing>()
  private readonly observers = new Map<string, Set<(event: ExternalBrowserEvent) => void>>()
  private readonly availability = new Map<string, Set<() => void>>()
  private readonly readyPromise: Promise<void>
  private saveTail: Promise<void> = Promise.resolve()
  private server: Server | null = null
  private sockets: WebSocketServer | null = null
  private port = 0
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private starting: Promise<void> | null = null
  private disposed = false
  private persistenceWarning: string | undefined
  constructor(private readonly path: string, private readonly changed: () => void = () => {},
    private readonly documentEnded: (browserId: string, navigationId: string) => void = () => {}) {
    this.readyPromise = this.load()
  }
  async ready(): Promise<void> { await this.readyPromise }
  private async load(): Promise<void> {
    try {
      const parsed = documentSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
      for (const row of parsed.targets) this.targets.set(row.id, { ...row,
        status: row.status === 'ready' ? 'disconnected' : row.status,
        ...(row.status === 'ready' ? { warning: 'Client restarted. Reconnect the original shared tab; actions are not replayed.' } : {}), connection: null })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.persistenceWarning = 'Shared-tab metadata could not be read. Existing work remains; share the original tab explicitly.'
    }
  }
  async createPairing(workspaceId: string): Promise<AgentMuxExternalBrowserPairing> {
    workspaceId = id.parse(workspaceId)
    await this.ready()
    if (this.disposed) throw new Error('Shared-tab bridge is closed.')
    await this.start()
    for (const [token, row] of this.pairings) if (!row.extensionId && row.expiresAt < Date.now()) this.pairings.delete(token)
    if (this.pairings.size >= 32) throw new Error('Too many pending shared-tab connections. Close unused connections before creating another.')
    const token = randomBytes(32).toString('hex')
    const expiresAt = Date.now() + 10 * 60_000
    this.pairings.set(token, { workspaceId, expiresAt })
    return { link: `ws://127.0.0.1:${this.port}/shared-tab#${token}`, expiresAt }
  }
  private async start(): Promise<void> {
    if (this.server) return
    if (this.starting) return await this.starting
    this.starting = new Promise<void>((resolve, reject) => {
      const server = createServer((_request, response) => { response.writeHead(404); response.end() })
      const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BRIDGE_BYTES })
      server.on('upgrade', (request, socket, head) => {
        const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(request.headers.origin ?? '')
        if (request.url !== '/shared-tab' || !match || this.disposed || this.connections.size + sockets.clients.size >= 16) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
        }
        sockets.handleUpgrade(request, socket, head, ws => this.accept(ws, match[1]!))
      })
      server.once('error', error => { sockets.close(); server.close(); reject(error) })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string' || this.disposed) { server.close(); sockets.close(); reject(new Error('Shared-tab listener could not start.')); return }
        this.server = server; this.sockets = sockets; this.port = address.port; resolve()
      })
    })
    try { await this.starting } finally { this.starting = null }
  }
  private accept(socket: WebSocket, extensionId: string): void {
    let connection: Connection | null = null
    const timeout = setTimeout(() => socket.close(1008), 5000)
    socket.on('error', () => { /* close owns pending request cancellation. */ })
    socket.on('close', () => { clearTimeout(timeout); if (connection) this.end(connection) })
    socket.on('message', (raw, binary) => {
      const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw)
      if (binary || bytes.byteLength > MAX_BRIDGE_BYTES) { socket.close(1008); return }
      let message: Record<string, unknown>
      try { message = JSON.parse(bytes.toString()) as Record<string, unknown>; if (!message || typeof message !== 'object') throw new Error() } catch { socket.close(1008); return }
      if (!connection) {
        const hello = z.object({ type: z.literal('hello'), protocol: z.literal(EXTERNAL_BROWSER_PROTOCOL),
          token: z.string().regex(/^[a-f0-9]{64}$/), instanceId: z.string().uuid(), grants: z.array(grantSchema).max(64) }).strict().safeParse(message)
        if (!hello.success) { socket.close(1008); return }
        const pairing = this.pairings.get(hello.data.token)
        if (!pairing || (!pairing.extensionId && pairing.expiresAt < Date.now()) ||
          (pairing.extensionId && (pairing.extensionId !== extensionId || pairing.instanceId !== hello.data.instanceId))) { socket.close(1008); return }
        pairing.extensionId = extensionId; pairing.instanceId = hello.data.instanceId
        for (const previous of this.connections) {
          if (previous.extensionId === extensionId && previous.instanceId === hello.data.instanceId) { this.end(previous); previous.socket.close() }
        }
        connection = { id: randomUUID(), extensionId, instanceId: hello.data.instanceId, workspaceId: pairing.workspaceId,
          socket, pending: new Map(), targets: new Set(), byGrant: new Map() }
        this.connections.add(connection); clearTimeout(timeout)
        const bindings = []
        const rejectedGrants = []
        for (const grant of hello.data.grants) {
          const row = this.bind(connection, grant, false)
          if (row) bindings.push({ tabId: row.tabId, grantId: row.grantId, bindingId: row.id })
          else rejectedGrants.push(grant.grantId)
        }
        this.send(connection, { type: 'welcome', bindings, rejectedGrants })
        this.keepAlive(); this.changed(); return
      }
      if (message.connectionId !== connection.id || !this.connections.has(connection)) return
      if (message.type === 'share') {
        const grant = grantSchema.safeParse({ tabId: message.tabId, grantId: message.grantId,
          navigationId: message.navigationId, url: message.url, title: message.title })
        if (!grant.success) { socket.close(1008); return }
        const row = this.bind(connection, grant.data, true)
        if (row) this.send(connection, { type: 'bound', tabId: row.tabId, grantId: row.grantId, bindingId: row.id })
        else this.send(connection, { type: 'rejected', grantId: grant.data.grantId, reason: 'This target could not be shared. Remove unused bindings or explicitly share the original tab again.' })
      } else if (message.type === 'revoked') {
        const row = this.original(connection, message.tabId, message.grantId)
        if (row && message.reason === 'closed') this.documentEnded(row.id, row.navigationId)
        if (row) this.revoke(row, message.reason === 'closed' ? 'closed' : message.reason === 'unavailable' ? 'unavailable' : 'revoked',
          'The original tab stopped sharing. Sent actions are not replayed; share it explicitly to grant control again.')
      } else if (message.type === 'response') this.response(connection, message)
      else if (message.type === 'event') this.event(connection, message)
      else if (message.type === 'metadata') {
        const row = this.original(connection, message.tabId, message.grantId)
        if (row && row.status === 'ready' && message.navigationId === row.navigationId && typeof message.title === 'string') {
          row.title = message.title.slice(0, 512); this.changed()
        }
      }
    })
  }
  private bind(connection: Connection, grant: Grant, explicit: boolean): ExternalBrowserBinding | null {
    let row = [...this.targets.values()].find(item => item.extensionId === connection.extensionId &&
      item.instanceId === connection.instanceId && item.tabId === grant.tabId && item.grantId === grant.grantId)
    if (!row && !explicit) return null
    if (row && row.workspaceId !== connection.workspaceId) return null
    if (row && ['revoked', 'closed'].includes(row.status)) return null
    if (!row) {
      if (this.targets.size >= 64) return null
      row = { ...grant, id: randomUUID(), workspaceId: connection.workspaceId,
        extensionId: connection.extensionId, instanceId: connection.instanceId, status: 'ready', connection: null }
      this.targets.set(row.id, row)
    }
    Object.assign(row, grant, { status: 'ready', connection: new ExternalBrowserConnection(this, connection) })
    delete row.warning
    connection.targets.add(row.id); connection.byGrant.set(`${row.tabId}:${row.grantId}`, row)
    void this.persist(); this.notify(row.id); return row
  }
  private original(connection: Connection, tabId: unknown, grantId: unknown): ExternalBrowserBinding | undefined {
    if (typeof tabId !== 'number' || typeof grantId !== 'string') return undefined
    const row = connection.byGrant.get(`${tabId}:${grantId}`)
    return row && this.targets.get(row.id) === row && row.connection?.id === connection.id ? row : undefined
  }
  private send(connection: Connection, message: Record<string, unknown>): void {
    if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(JSON.stringify({ ...message, connectionId: connection.id }))
  }
  private keepAlive(): void {
    if (this.heartbeat) return
    // Actual paired sockets only: keep the MV3 connection alive without querying any tabs.
    this.heartbeat = setInterval(() => {
      for (const connection of this.connections) this.send(connection, { type: 'heartbeat' })
    }, 20_000)
    this.heartbeat.unref()
  }
  private end(connection: Connection): void {
    if (!this.connections.delete(connection)) return
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new ExternalBrowserRequestFailure('Connection ended after the request was sent. Inspect the original tab; do not replay the action.', true))
    }
    connection.pending.clear()
    for (const id of connection.targets) {
      const row = this.targets.get(id)
      if (row?.connection?.id === connection.id) this.revoke(row, 'disconnected', 'Connection lost. Original tab identity remains; sent actions are not replayed.')
    }
    if (!this.connections.size && this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null }
  }
  private revoke(row: ExternalBrowserBinding, status: SavedTarget['status'], warning: string): void {
    row.status = status; row.warning = warning; row.connection = null
    for (const connection of this.connections) for (const [id, pending] of connection.pending) {
      if (pending.binding === row) { clearTimeout(pending.timer); connection.pending.delete(id); pending.reject(new ExternalBrowserRequestFailure(warning, true)) }
    }
    void this.persist(); this.notify(row.id)
  }
  request(connection: Connection, row: ExternalBrowserBinding, owner: ExternalBrowserOperationOwner,
    action: 'attach' | 'detach' | 'command', method?: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    if (this.disposed || connection.socket.readyState !== WebSocket.OPEN || this.targets.get(row.id) !== row || row.status !== 'ready' ||
      row.connection?.id !== connection.id || !this.connections.has(connection) || !connection.targets.has(row.id)) {
      return Promise.reject(new ExternalBrowserRequestFailure('The original shared tab is unavailable. No replacement is selected.', false))
    }
    if (!owner.operationId || !owner.callerId || (action === 'command' && !isTabScopedCommand(method, params))) {
      return Promise.reject(new ExternalBrowserRequestFailure('This request is outside the original shared-tab capability.', false))
    }
    if (connection.pending.size >= 64) return Promise.reject(new ExternalBrowserRequestFailure('The shared-tab connection has too many pending requests.', false))
    const requestId = randomUUID()
    let packet: string
    try {
      packet = JSON.stringify({ type: 'request', connectionId: connection.id, requestId, tabId: row.tabId, grantId: row.grantId,
        navigationId: row.navigationId, operationId: owner.operationId, callerId: owner.callerId, action,
        ...(method ? { method } : {}), ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) })
      if (Buffer.byteLength(packet) > MAX_BRIDGE_BYTES) throw new Error()
    } catch { return Promise.reject(new ExternalBrowserRequestFailure('Shared-tab request could not be encoded within its byte limit. Nothing was sent.', false)) }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(requestId)
        reject(new ExternalBrowserRequestFailure('Shared-tab response timed out after send. Check the original page before another action; nothing is replayed.', true))
      }, 30_000)
      timer.unref()
      connection.pending.set(requestId, { binding: row, navigationId: row.navigationId, owner: { ...owner }, sessionId,
        action, allowNavigation: action === 'attach' || action === 'detach' || method === 'Page.navigate', resolve, reject, timer })
      connection.socket.send(packet, error => {
        if (!error || !connection.pending.delete(requestId)) return
        clearTimeout(timer); reject(new ExternalBrowserRequestFailure('Connection failed while sending. Inspect the original tab before another action; nothing is replayed.', true))
      })
    })
  }
  private response(connection: Connection, message: Record<string, unknown>): void {
    if (typeof message.requestId !== 'string') return
    const pending = connection.pending.get(message.requestId)
    if (!pending) return
    const row = this.original(connection, message.tabId, message.grantId)
    if (row !== pending.binding || row.status !== 'ready') return
    if (message.operationId !== pending.owner.operationId || message.callerId !== pending.owner.callerId ||
      message.sessionId !== pending.sessionId) return
    clearTimeout(pending.timer); connection.pending.delete(message.requestId)
    if (typeof message.error === 'string') {
      const documentChanged = row.navigationId !== pending.navigationId || message.navigationId !== pending.navigationId
      pending.reject(new ExternalBrowserRequestFailure(documentChanged ?
        'The original document changed before its error was confirmed. Inspect the original page; do not replay the action.' : message.error.slice(0, 2000),
      message.sent !== false, message.uncertain === true || (message.sent !== false && documentChanged)))
      return
    }
    if (typeof message.navigationId !== 'string' || (!pending.allowNavigation &&
      (row.navigationId !== pending.navigationId || message.navigationId !== pending.navigationId))) {
      pending.reject(new ExternalBrowserRequestFailure('The original document changed before its result was confirmed. Do not replay the action.', true)); return
    }
    if (pending.action === 'attach') {
      const grant = grantSchema.safeParse(message.value)
      if (!grant.success || grant.data.tabId !== row.tabId || grant.data.grantId !== row.grantId || grant.data.navigationId !== message.navigationId) {
        pending.reject(new ExternalBrowserRequestFailure('The attached page identity was not confirmed. No replacement is selected.', true)); return
      }
      if (row.navigationId !== grant.data.navigationId) this.documentEnded(row.id, row.navigationId)
      Object.assign(row, grant.data)
    } else if (pending.allowNavigation) row.navigationId = message.navigationId
    pending.resolve(message.value)
  }
  private event(connection: Connection, message: Record<string, unknown>): void {
    const row = this.original(connection, message.tabId, message.grantId)
    if (!row || row.status !== 'ready' || typeof message.method !== 'string' || typeof message.navigationId !== 'string') return
    if (message.mainDocumentNavigation === true && !message.sessionId) {
      if (message.method === 'Page.frameNavigated' && row.navigationId !== message.navigationId) this.documentEnded(row.id, row.navigationId)
      row.navigationId = message.navigationId
      if (typeof message.url === 'string' && isShareUrl(message.url)) row.url = message.url
      void this.persist(); this.changed()
    } else if (message.navigationId !== row.navigationId) return
    const event: ExternalBrowserEvent = { method: message.method, params: message.params, navigationId: message.navigationId,
      mainDocumentNavigation: message.mainDocumentNavigation === true && !message.sessionId,
      ...(typeof message.sessionId === 'string' ? { sessionId: message.sessionId } : {}) }
    for (const observer of this.observers.get(row.id) ?? []) observer(event)
  }
  require(id: string): ExternalBrowserBinding {
    const row = this.targets.get(id)
    if (!row) throw new Error('Unknown Browser target. Choose an explicitly shared target from browser targets.')
    return row
  }
  has(id: string): boolean { return this.targets.has(id) }
  recordLedger(id: string, navigationId: string): void {
    const row = this.require(id)
    if (row.status !== 'ready' || row.navigationId !== navigationId) throw new Error('The original document changed before its refs could be recorded.')
    row.ledgerNavigationId = navigationId
    void this.persist()
  }
  stopSharing(id: string): void {
    const row = this.require(id)
    const connection = [...this.connections].find(item => item.id === row.connection?.id)
    if (connection) this.send(connection, { type: 'stop-sharing', tabId: row.tabId, grantId: row.grantId })
    this.revoke(row, 'revoked', 'Sharing of this original tab ended. Grant control explicitly before another action.')
  }
  get warning(): string | undefined { return this.persistenceWarning }
  list(): AgentMuxBrowserTarget[] {
    return [...this.targets.values()].map(row => ({ id: row.id, workspaceId: row.workspaceId, source: 'external', status: row.status,
      url: row.url, title: row.title, navigationId: row.navigationId,
      capabilities: BROWSER_PAGE_CAPABILITY_NAMES.filter(name => !['download', 'readDownload'].includes(name)),
      cdpMethods: EXTERNAL_CDP_METHODS,
      ...(row.warning || this.persistenceWarning ? { warning: row.warning ?? this.persistenceWarning! } : {}) }))
  }
  observe(id: string, listener: (event: ExternalBrowserEvent) => void): () => void {
    const set = this.observers.get(id) ?? new Set(); set.add(listener); this.observers.set(id, set)
    return () => { set.delete(listener); if (!set.size) this.observers.delete(id) }
  }
  observeAvailability(id: string, listener: () => void): () => void {
    const set = this.availability.get(id) ?? new Set(); set.add(listener); this.availability.set(id, set)
    return () => { set.delete(listener); if (!set.size) this.availability.delete(id) }
  }
  private notify(id: string): void { this.changed(); for (const listener of this.availability.get(id) ?? []) listener() }
  private async persist(): Promise<void> {
    const document = { version: 1, targets: [...this.targets.values()].map(({ connection, ...row }) => row) }
    this.saveTail = this.saveTail.then(async () => {
      try { await durableWriteFile(this.path, JSON.stringify(document)); this.persistenceWarning = undefined }
      catch { this.persistenceWarning = 'Shared-tab metadata could not be saved. Original tabs remain usable; bindings may need an explicit share after restart.'; this.changed() }
    })
    await this.saveTail
  }
  async dispose(): Promise<void> {
    this.disposed = true
    for (const connection of [...this.connections]) { this.end(connection); connection.socket.close() }
    for (const socket of this.sockets?.clients ?? []) socket.terminate()
    this.pairings.clear(); this.observers.clear(); this.availability.clear()
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.sockets?.close(); this.server?.close()
    await this.saveTail
  }
}
