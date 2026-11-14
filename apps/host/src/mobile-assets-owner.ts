import { realpath } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { AgentMuxError } from '@agentmux/core'
import { mintObjectId } from '@agentmux/core/object-id'
import type { MobileAssetRelease, MobileAssetsActivateParams, MobileAssetsActivationAuthority,
  MobileAssetsActivationReceipt, MobileAssetsInspectParams, MobileAssetsInspection, MobileAssetsLoadedParams,
  MobileAssetsLoadedReceipt, MobileAssetsPort } from '@agentmux/core/mobile-web'
import { loadMobileSnapshot, mobileCandidateDirectory, mobileDigest, MobileAssetCapacityError, MOBILE_ASSET_LIMITS, type MobileAsset, type MobileSnapshot } from './mobile-assets.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isMobilePageEntry, mobilePageUnavailable, mobileResourceUnavailable } from './mobile-page-response.js'
import { mobileAssetNamespace } from '@agentmux/core/mobile-web-codec'

function acceptsGzip(value: string | undefined): boolean {
  const encodings = (value ?? '').toLowerCase().split(',').map(item => item.trim().split(';').map(part => part.trim()))
  const selected = encodings.find(([name]) => name === 'gzip') ?? encodings.find(([name]) => name === '*')
  if (!selected) return false
  const quality = selected.slice(1).find(part => part.startsWith('q='))?.slice(2)
  return quality === undefined || /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.test(quality) && Number(quality) > 0
}

/** One original Host owns HTTP snapshots, activation results and bounded page observations. */
export class MobileAssetsOwner implements MobileAssetsPort {
  readonly instanceId = mintObjectId()
  private active: MobileSnapshot | null = null
  private revision = 0
  private retained: MobileSnapshot[] = []
  private readonly sending = new Map<MobileSnapshot, number>()
  private responseCount = 0
  private busy = false
  private pending: { operationId: string; inputDigest: string; promise: Promise<MobileAssetsActivationReceipt> } | null = null
  private readonly operations = new Map<string, MobileAssetsActivationReceipt>()
  private operationsEvicted = 0
  private readonly clients = new Map<string, MobileAssetsLoadedReceipt>()
  private loadedRejected = 0
  constructor(readonly hostId = 'local') {}

  async initialize(directory: string): Promise<void> {
    if (this.active) return
    if (this.busy || this.pending) throw new AgentMuxError('The original asset IO is still in flight. Retry only this mobile initialization.', 'CONTROL_UNAVAILABLE')
    this.busy = true
    try { const snapshot = await loadMobileSnapshot(directory); this.active = snapshot; this.retained = [snapshot] }
    finally { this.busy = false }
  }
  private payloadBytes(): number {
    return [...new Set([...this.retained, ...this.sending.keys()])].reduce((sum, snapshot) => sum + snapshot.release.bytes, 0)
  }
  inspect(input: MobileAssetsInspectParams): MobileAssetsInspection {
    if (input.hostId !== this.hostId) throw new AgentMuxError('The requested mobile asset Host does not match this owner.', 'CONTROL_PERMISSION_DENIED')
    const target = input.client
    const item = target ? this.clients.get(JSON.stringify([target.devicePrincipalId, target.documentId])) ?? null : null
    const receipt = input.operationId ? this.operations.get(input.operationId) ?? null : null
    return { hostId: this.hostId, hostInstanceId: this.instanceId,
      active: this.active ? { ...this.active.release, revision: this.revision } : null,
      retained: this.retained.map(snapshot => ({ ...snapshot.release })), retention: 'active-and-previous',
      operation: input.operationId ? { operationId: input.operationId, availability: receipt ? 'found' : this.pending?.operationId === input.operationId ? 'in-flight' : 'not-retained', receipt: receipt ? structuredClone(receipt) : null } : null,
      clients: [...this.clients.values()].map(value => structuredClone(value)),
      client: target ? { target: { ...target }, availability: item ? 'found' : 'not-retained', loaded: item ? structuredClone(item) : null,
        namespace: item?.buildId === null || !item?.namespaceDigest ? 'unknown' : this.retained.some(snapshot =>
          snapshot.release.buildId === item.buildId && snapshot.release.digest === item.namespaceDigest) ? 'retained' : 'not-retained' } : null,
      coverage: { lifetime: 'current-host-instance', operationsRetained: this.operations.size, operationsEvicted: this.operationsEvicted,
        loadedRetained: this.clients.size, loadedRejected: this.loadedRejected }, observedAt: Date.now() }
  }
  loaded(input: MobileAssetsLoadedParams, devicePrincipalId: string): MobileAssetsLoadedReceipt {
    const key = JSON.stringify([devicePrincipalId, input.documentId])
    const receipt: MobileAssetsLoadedReceipt = { buildId: input.buildId, namespaceDigest: input.namespaceDigest, occurrenceId: input.occurrenceId, observedAt: input.observedAt,
      hostId: this.hostId, hostInstanceId: this.instanceId,
      producer: { devicePrincipalId, documentId: input.documentId }, receivedAt: Date.now(), accepted: true, reason: null }
    const previous = this.clients.get(key)
    if (previous?.occurrenceId === input.occurrenceId) {
      if (previous.buildId !== input.buildId || previous.namespaceDigest !== input.namespaceDigest || previous.observedAt !== input.observedAt) throw new AgentMuxError('The original loaded occurrence changed.', 'INVALID_CONTROL_REQUEST')
      return structuredClone(previous)
    }
    if (Buffer.byteLength(JSON.stringify(receipt)) > 1024) throw new AgentMuxError('The original loaded identity exceeds the observation envelope.', 'INVALID_CONTROL_REQUEST')
    if (!previous && this.clients.size >= MOBILE_ASSET_LIMITS.clients) {
      this.loadedRejected++; return { ...receipt, accepted: false, reason: 'capacity' }
    }
    this.clients.set(key, receipt); return structuredClone(receipt)
  }
  private remember(receipt: MobileAssetsActivationReceipt): MobileAssetsActivationReceipt {
    while (this.operations.size >= MOBILE_ASSET_LIMITS.operations) {
      // Protect only the latest receipt for each retained release, not every same-build activation.
      const kept = new Set(this.retained.map(snapshot => [...this.operations].reverse().find(([, value]) =>
        value.status === 'active' && value.candidate?.digest === snapshot.release.digest)?.[0]))
      const victim = [...this.operations].find(([id]) => !kept.has(id))
      if (!victim) break
      this.operations.delete(victim[0]); this.operationsEvicted++
    }
    if (this.operations.size < MOBILE_ASSET_LIMITS.operations) this.operations.set(receipt.operationId, receipt)
    return structuredClone(receipt)
  }
  async activate(input: MobileAssetsActivateParams, authority: MobileAssetsActivationAuthority): Promise<MobileAssetsActivationReceipt> {
    const scope = { hostId: authority.hostId, agentSessionId: authority.agentSessionId, runId: authority.runId, workspacePath: authority.workspacePath }
    const inputDigest = mobileDigest(JSON.stringify({ input: { hostId: input.hostId, operationId: input.operationId,
      candidatePath: input.candidatePath, candidateDigest: input.candidateDigest, expectedActiveRevision: input.expectedActiveRevision }, scope }))
    const previous = this.operations.get(input.operationId)
    if (previous) {
      if (previous.inputDigest !== inputDigest) throw new AgentMuxError('This activation operation already has another original input.', 'INVALID_CONTROL_REQUEST')
      return structuredClone(previous)
    }
    const receipt = (status: MobileAssetsActivationReceipt['status'], reason: MobileAssetsActivationReceipt['reason'], candidate: MobileAssetRelease | null = null): MobileAssetsActivationReceipt =>
      ({ operationId: input.operationId, hostInstanceId: this.instanceId, inputDigest, expectedActiveRevision: input.expectedActiveRevision,
        status, reason, candidate, activeRevision: this.revision, persistence: 'not-requested', observedAt: Date.now() })
    if (this.pending) {
      const original = this.pending
      if (original.operationId === input.operationId) {
        if (original.inputDigest !== inputDigest) throw new AgentMuxError('The in-flight activation has another original input.', 'INVALID_CONTROL_REQUEST')
        await authority.assertCurrent(); return await original.promise
      }
      await authority.assertCurrent(); return this.remember(receipt('not-admitted', 'busy'))
    }
    const operation = (async () => {
    await authority.assertCurrent()
    if (input.hostId !== authority.hostId || input.hostId !== this.hostId) throw new AgentMuxError('Activation cannot cross the authenticated execution Host.', 'CONTROL_PERMISSION_DENIED')
    if (this.busy) return this.remember(receipt('not-admitted', 'busy'))
    if (input.expectedActiveRevision !== this.revision) return this.remember(receipt('rejected', 'stale-revision'))
    this.busy = true
    try {
      let snapshot: MobileSnapshot, root: string, directory: string
      try {
        root = await realpath(authority.workspacePath)
        directory = await mobileCandidateDirectory(root, input.candidatePath)
        snapshot = await loadMobileSnapshot(directory, input.candidateDigest, MOBILE_ASSET_LIMITS.totalPayloadBytes - this.payloadBytes())
        if (await realpath(authority.workspacePath) !== root || await mobileCandidateDirectory(root, input.candidatePath) !== directory) throw Error('Original execution resource changed')
      } catch (error) { return this.remember(error instanceof MobileAssetCapacityError ? receipt('not-admitted', 'capacity') : receipt('rejected', 'candidate-invalid')) }
      await authority.assertCurrent()
      if (input.expectedActiveRevision !== this.revision) return this.remember(receipt('rejected', 'stale-revision', snapshot.release))
      if (this.retained.some(old => old.release.buildId === snapshot.release.buildId && old.release.digest !== snapshot.release.digest)) return this.remember(receipt('rejected', 'candidate-invalid'))
      this.active = snapshot
      this.retained = [snapshot, ...this.retained.filter(old => old.release.buildId !== snapshot.release.buildId)].slice(0, MOBILE_ASSET_LIMITS.retained)
      this.revision++
      return this.remember(receipt('active', null, snapshot.release))
    } finally { this.busy = false }
    })()
    const pending = { operationId: input.operationId, inputDigest, promise: operation }; this.pending = pending
    try { return await operation } finally { if (this.pending === pending) this.pending = null }
  }
  readonly route = (request: IncomingMessage, response: ServerResponse): void => {
    let target: URL
    try { target = new URL(request.url ?? '/', 'http://localhost') }
    catch { mobileResourceUnavailable(request, response, 400); return }
    const path = target.pathname, readable = request.method === 'GET' || request.method === 'HEAD'
    const entry = isMobilePageEntry(path)
    let snapshot: MobileSnapshot | undefined, file: MobileAsset | undefined
    const openCurrent = () => {
      response.writeHead(302, { Location: this.namespace(this.active!) + target.search,
        'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end()
    }
    if ((path === '/' || path === '/index.html') && this.active && readable) {
      openCurrent(); return
    }
    else for (const candidate of this.retained) {
      const short = this.namespace(candidate)
      const prefixes = [short, '/mobile/' + encodeURIComponent(candidate.release.buildId) + '/' + candidate.release.digest.slice(7) + '/']
      const prefix = prefixes.find(value => path.startsWith(value))
      if (readable && path === this.namespace(candidate) + 'index.html') {
        response.writeHead(302, { Location: this.namespace(candidate) + target.search, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(); return
      }
      if (prefix) { snapshot = candidate; file = candidate.files.get(path.slice(prefix.length) || (prefix === short ? 'index.html' : '')); break }
    }
    if (!readable || !file || !snapshot) {
      if (readable && entry) {
        if (this.active) openCurrent()
        else mobilePageUnavailable(request, response, path.startsWith('/mobile/') || path.startsWith('/m/') ? 410 : 503)
      } else mobileResourceUnavailable(request, response, path.startsWith('/mobile/') || path.startsWith('/m/') ? 410 : 404)
      return
    }
    if (this.responseCount >= MOBILE_ASSET_LIMITS.responses) {
      if (entry) mobilePageUnavailable(request, response, 503)
      else mobileResourceUnavailable(request, response, 503)
      return
    }
    const compress = file.bytes.length >= 1024 && (file.type.startsWith('text/') || file.type === 'image/svg+xml') && acceptsGzip(request.headers['accept-encoding'])
    response.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': entry ? 'no-store' : 'private, max-age=31536000, immutable',
      Vary: 'Accept-Encoding', ...(compress ? { 'Content-Encoding': 'gzip' } : {}), 'X-Content-Type-Options': 'nosniff',
      'X-AgentMux-Mobile-Build': encodeURIComponent(snapshot.release.buildId), 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" })
    if (request.method === 'HEAD') { response.end(); return }
    this.responseCount++; this.sending.set(snapshot, (this.sending.get(snapshot) ?? 0) + 1)
    let released = false
    const release = () => {
      if (released) return; released = true; this.responseCount--
      const left = this.sending.get(snapshot!)! - 1
      if (left === 0) this.sending.delete(snapshot!); else this.sending.set(snapshot!, left)
    }
    response.once('finish', release); response.once('close', release)
    void this.send(file.bytes, response, compress).catch(() => response.destroy())
  }
  private namespace(snapshot: MobileSnapshot): string {
    return mobileAssetNamespace(snapshot.release.digest)
  }
  private *chunks(bytes: Buffer): Generator<Buffer> {
    for (let offset = 0; offset < bytes.length; offset += MOBILE_ASSET_LIMITS.chunk) yield bytes.subarray(offset, offset + MOBILE_ASSET_LIMITS.chunk)
  }
  private async send(bytes: Buffer, response: ServerResponse, compress: boolean): Promise<void> {
    if (compress) {
      // Subarrays share the admitted snapshot. The pipeline bounds each stream's
      // buffering and destroys both producers when this response is closed.
      await pipeline(Readable.from(this.chunks(bytes), { objectMode: false, highWaterMark: MOBILE_ASSET_LIMITS.chunk }),
        createGzip({ chunkSize: MOBILE_ASSET_LIMITS.chunk }), response)
      return
    }
    for (let offset = 0; offset < bytes.length && !response.destroyed; offset += MOBILE_ASSET_LIMITS.chunk) {
      if (!response.write(bytes.subarray(offset, offset + MOBILE_ASSET_LIMITS.chunk))) await new Promise<void>(resolve => {
        const done = () => { response.off('drain', done); response.off('close', done); resolve() }
        response.once('drain', done); response.once('close', done)
      })
    }
    if (!response.destroyed) response.end()
  }
}
