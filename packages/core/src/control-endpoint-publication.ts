import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Socket } from 'node:net'
import { findPackageJSON } from 'node:module'
import { AgentMuxError } from './errors.js'
import { probeSocketLiveness } from './socket-liveness.js'
import type { AgentMuxControlEndpointState } from './control-endpoint-state.js'

type Identity = { dev: number; ino: number }
type Listener = { child: ChildProcess; path: string; identity: Identity; alive: boolean; admitting: boolean; capacityBlocked: boolean; closed: Promise<void>; close(): Promise<void> }
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const code = (error: unknown) => error instanceof AgentMuxError ? error.code : (error as NodeJS.ErrnoException).code ?? 'CONTROL_UNAVAILABLE'
function cleanupFailure(original: unknown, cleanup: unknown): AgentMuxError {
  return new AgentMuxError(`${original instanceof Error ? original.message : String(original)} Candidate cleanup also failed (${code(cleanup)}): ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`, code(original))
}

/** One monitor per original semantic owner, independent of Session count. */
export class ControlEndpointPublication {
  private current: Listener | undefined
  private readonly retired = new Set<Listener>()
  private readonly cancellation = new AbortController()
  private active = false
  private timer?: NodeJS.Timeout
  private pending: Promise<void> | undefined
  private starting: Promise<void> | undefined
  private uncertain: { path: string; identity?: Identity } | undefined
  private firstFailure: { code: string; message: string } | undefined
  private observation: AgentMuxControlEndpointState = { state: 'unavailable', diagnostic: { code: 'CONTROL_UNAVAILABLE', message: 'Control endpoint has not been published.' } }
  constructor(readonly path: string, private readonly accept: (socket: Socket) => void,
    private readonly observed?: (state: AgentMuxControlEndpointState) => void) {}
  state(): AgentMuxControlEndpointState { return structuredClone(this.observation) }
  private publish(state: AgentMuxControlEndpointState): void {
    if (!this.active) return
    if (state.state === 'available') this.firstFailure = undefined
    else {
      this.firstFailure ??= state.diagnostic
      if (state.diagnostic.code !== this.firstFailure.code || state.diagnostic.message !== this.firstFailure.message) state = {
        state: 'unavailable', diagnostic: { code: this.firstFailure.code, message: `${this.firstFailure.message} Current publication attempt (${state.diagnostic.code}): ${state.diagnostic.message}` }
      }
    }
    if (JSON.stringify(state) === JSON.stringify(this.observation)) return
    this.observation = state
    try { this.observed?.(this.state()) }
    catch { try { console.error(new AgentMuxError('A control endpoint observation consumer failed. The original published endpoint and Run capabilities are retained.', 'CONTROL_OBSERVER_FAILED')) } catch { /* Diagnostic sinks do not own publication. */ } }
  }
  private async parent(): Promise<void> {
    const path = dirname(this.path)
    await mkdir(path, { recursive: true, mode: 0o700 })
    const stat = await lstat(path), uid = process.getuid?.() ?? stat.uid
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid && !(stat.uid === 0 && stat.mode & 0o1000)) {
      throw new AgentMuxError('The control endpoint directory belongs to another owner or is unconfirmed.', 'CONTROL_OWNER_BUSY')
    }
    // Shared system temporary directories retain their sticky permissions.
    if (stat.uid === uid && !(stat.mode & 0o1000)) await chmod(path, 0o700)
  }
  private async owns(path: string, identity: Identity): Promise<boolean> {
    try { const stat = await lstat(path); return stat.isSocket() && stat.uid === (process.getuid?.() ?? stat.uid) && same(stat, identity) }
    catch (error) { if (missing(error)) return false; throw error }
  }
  private async cleanup(listener: Listener, canonical = false): Promise<void> {
    for (const path of canonical ? [this.path, listener.path] : [listener.path]) if (await this.owns(path, listener.identity)) {
      try { await rm(path) } catch (error) { if (!missing(error)) throw error }
    }
  }
  private async discard(listener: Listener, canonical = false): Promise<void> {
    await listener.close()
    const candidate = { path: listener.path, identity: listener.identity }
    this.uncertain = candidate
    await this.cleanup(listener, canonical)
    if (this.uncertain === candidate) this.uncertain = undefined
  }
  private async create(): Promise<Listener> {
    // A failed identity observation cannot authorize deleting its candidate or
    // accumulating another candidate each tick. Known owned candidates can retry
    // cleanup; unknown names remain protected until their absence is confirmed.
    if (this.uncertain) {
      const candidate = this.uncertain
      if (candidate.identity) {
        if (await this.owns(candidate.path, candidate.identity)) await rm(candidate.path)
        this.uncertain = undefined
      } else {
        try { await lstat(candidate.path); throw new AgentMuxError('A private listener publication has unconfirmed ownership. Its pathname was retained; no further listener is created until its absence is confirmed.', 'CONTROL_PUBLICATION_UNCONFIRMED') }
        catch (error) { if (!missing(error)) throw error; this.uncertain = undefined }
      }
    }
    let path: string
    do { path = join(dirname(this.path), randomUUID().replaceAll('-', '').slice(0, Math.min(12, Buffer.byteLength(basename(this.path))))) } while (path === this.path)
    const packagePath = findPackageJSON('@agentmux/core', import.meta.url)
    if (!packagePath) throw new AgentMuxError('The installed Core listener asset is unavailable.', 'CONTROL_UNAVAILABLE')
    const worker = join(dirname(packagePath), 'dist/control-endpoint-listener-worker.js')
    return await new Promise<Listener>((resolve, reject) => {
      const child = fork(worker, [path], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      let adopted: Listener | undefined, failure: unknown, settled = false, unboundConfirmed = false
      // stdio is ignored; join actual process exit and IPC release separately.
      // Node's close event need not arrive after an explicit child.disconnect().
      const exited = new Promise<void>(done => {
        child.once('exit', () => done()); child.once('error', () => { if (!child.pid) done() })
      })
      const disconnected = new Promise<void>(done => {
        child.once('disconnect', () => done()); child.once('error', () => { if (!child.pid) done() })
      })
      const closed = Promise.all([exited, disconnected]).then(() => {})
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        this.cancellation.signal.removeEventListener('abort', abort)
        if (error || !adopted) {
          if (!adopted && !unboundConfirmed) this.uncertain ??= { path }
          const failure = error ?? new AgentMuxError('Listener worker exited without confirming ownership.', 'CONTROL_UNAVAILABLE')
          if (adopted) void this.discard(adopted).then(() => reject(failure), cleanup => reject(cleanupFailure(failure, cleanup)))
          else reject(failure)
        } else resolve(adopted)
      }
      const abort = () => { failure = new AgentMuxError('Control endpoint publication was stopped.', 'CONTROL_CANCELLED'); child.kill('SIGTERM') }
      this.cancellation.signal.addEventListener('abort', abort, { once: true })
      if (this.cancellation.signal.aborted) abort()
      child.on('message', (message: unknown, handle: unknown) => {
        if (failure) { if (handle instanceof Socket) handle.destroy(); return }
        if (!message || typeof message !== 'object') { failure = new AgentMuxError('Listener worker returned invalid transport facts.', 'CONTROL_PROTOCOL_ERROR'); child.kill('SIGKILL'); return }
        const value = message as { bound?: boolean; identity?: Identity; connection?: number; pending?: number; error?: { code?: string; message?: string } }
        // Node may deliver no handle when this particular Socket closed in transit.
        // Acknowledge its retirement without taking away healthy listener admission.
        if (adopted && Number.isSafeInteger(value.connection) && (handle instanceof Socket || handle == null)) {
          try {
            if (handle instanceof Socket) {
              if (this.active && adopted.admitting) { this.accept(handle); handle.resume() }
              else handle.destroy()
            }
          } catch (error) {
            if (handle instanceof Socket) handle.destroy()
            this.publish({ state: 'unavailable', diagnostic: { code: 'CONTROL_UNAVAILABLE', message: `Control connection admission failed: ${error instanceof Error ? error.message : String(error)}` } })
          }
          if (child.connected) child.send({ admitted: value.connection }, error => { if (error) child.kill('SIGTERM') })
          return
        }
        if (adopted && Number.isSafeInteger(value.pending) && value.pending! >= 0 && value.pending! <= 64) {
          adopted.capacityBlocked = value.pending === 64
          if (this.current === adopted && adopted.capacityBlocked) this.capacityFailure()
          return
        }
        if (handle instanceof Socket) handle.destroy()
        if (value.error) {
          unboundConfirmed = value.bound === false
          if (value.bound === true) this.uncertain = { path, ...(value.identity && Number.isSafeInteger(value.identity.dev) && Number.isSafeInteger(value.identity.ino) ? { identity: value.identity } : {}) }
          failure = new AgentMuxError(value.error.message ?? 'Listener creation failed.', value.error.code ?? 'CONTROL_UNAVAILABLE'); return
        }
        if (adopted || handle || !value.identity || !Number.isSafeInteger(value.identity.dev) || !Number.isSafeInteger(value.identity.ino)) {
          failure = new AgentMuxError('Listener worker returned invalid ownership facts.', 'CONTROL_PROTOCOL_ERROR'); child.kill('SIGKILL'); return
        }
        adopted = { child, path, identity: value.identity, alive: true, admitting: true, capacityBlocked: false, closed,
          close: async () => { adopted!.admitting = false; if (adopted!.alive) child.kill('SIGTERM'); await closed } }
        finish()
      })
      child.once('error', error => { failure = error; child.kill('SIGKILL'); if (!child.pid) finish(error) })
      child.once('exit', (code, signal) => {
        if (adopted) { adopted.alive = false; adopted.admitting = false }
        failure ??= new AgentMuxError(`Control listener worker exited (${signal ?? code}); existing accepted connections and Runs are retained. Publication will retry.`, 'CONTROL_UNAVAILABLE')
        if (adopted && this.current === adopted) this.publish({ state: 'unavailable', diagnostic: { code: 'CONTROL_UNAVAILABLE', message: (failure as Error).message } })
      })
      child.once('disconnect', () => { if (adopted) { adopted.alive = false; adopted.admitting = false }; child.kill('SIGTERM') })
      void closed.then(() => { if (!settled) finish(failure) })
    })
  }
  private capacityFailure(): void {
    this.publish({ state: 'unavailable', diagnostic: { code: 'CONTROL_CAPACITY', message: 'Control listener has 64 pending connection handoffs. Only new connections are refused; existing connections and Runs remain available. Retry the connection after admission catches up.' } })
  }
  private async reconcile(): Promise<void> {
    try {
      try {
        const target = await lstat(this.path)
        if (this.current && target.isSocket() && same(target, this.current.identity) && target.uid === (process.getuid?.() ?? target.uid)) {
          if (this.current.alive) {
            if (this.current.capacityBlocked) this.capacityFailure()
            else this.publish({ state: 'available' })
            return
          }
          await this.discard(this.current, true)
          this.current = undefined
        } else {
          throw new AgentMuxError('Another or unconfirmed owner occupies the control endpoint. Existing connections and Runs remain available.', 'CONTROL_OWNER_BUSY')
        }
      } catch (error) { if (!missing(error)) throw error }
      await this.parent()
      if (!this.active) return
      let listener = this.current
      if (!listener?.alive || !await this.owns(listener.path, listener.identity)) listener = await this.create()
      if (!this.active) { if (listener !== this.current) await this.discard(listener); return }
      try {
        await link(listener.path, this.path)
        if (!await this.owns(this.path, listener.identity)) throw new AgentMuxError('Control endpoint changed during publication.', 'CONTROL_OWNER_BUSY')
        if (!listener.alive) throw new AgentMuxError('Control listener exited during publication; existing connections and Runs are retained.', 'CONTROL_UNAVAILABLE')
        if (!this.active) {
          if (listener !== this.current) await this.discard(listener, true)
          return
        }
      } catch (error) {
        if (listener !== this.current) try { await this.discard(listener, true) } catch (cleanup) { throw cleanupFailure(error, cleanup) }
        throw error
      }
      const previous = this.current; this.current = listener
      if (previous && previous !== listener) {
        this.retired.add(previous)
        // Only the child's admission ends; transferred connections belong to Core.
        void previous.close().then(() => this.cleanup(previous)).catch(error => {
          this.uncertain ??= { path: previous.path, identity: previous.identity }
          this.publish({ state: 'unavailable', diagnostic: { code: 'CONTROL_UNAVAILABLE', message: `Retired listener cleanup failed: ${error instanceof Error ? error.message : String(error)}` } })
        }).finally(() => this.retired.delete(previous))
      }
      this.publish({ state: 'available' })
    } catch (error) {
      if (this.active) this.publish({ state: 'unavailable', diagnostic: {
        code: error instanceof AgentMuxError ? error.code : (error as NodeJS.ErrnoException).code ?? 'CONTROL_UNAVAILABLE',
        message: `Control endpoint publication failed; the original owner, connections and Runs are retained. Automatic publication will retry. ${error instanceof Error ? error.message : String(error)}`
      } })
      throw error
    }
  }
  private schedule(): void {
    if (!this.active) return
    this.timer = setTimeout(() => {
      this.pending = this.reconcile().catch(() => {}).finally(() => { this.pending = undefined; this.schedule() })
    }, 1000)
    this.timer.unref()
  }
  async start(): Promise<void> {
    if (this.starting) return this.starting
    if (this.active) return
    const starting = this.initialize()
    this.starting = starting
    try { await starting } finally { if (this.starting === starting) this.starting = undefined }
  }
  private async initialize(): Promise<void> {
    await this.parent()
    if (this.cancellation.signal.aborted) throw new AgentMuxError('Control endpoint startup was stopped.', 'CONTROL_CANCELLED')
    try {
      const stat = await lstat(this.path), uid = process.getuid?.() ?? stat.uid
      if (!stat.isSocket() || stat.uid !== uid) throw new AgentMuxError('Another owner occupies the RPC endpoint.', 'CONTROL_OWNER_BUSY')
      const live = await probeSocketLiveness(this.path)
      if (live !== 'dead') throw new AgentMuxError('RPC endpoint owner is alive or unconfirmed.', live === 'alive' ? 'CONTROL_OWNER_BUSY' : 'CONTROL_UNAVAILABLE')
      if (!await this.owns(this.path, stat)) throw new AgentMuxError('RPC endpoint changed during owner admission.', 'CONTROL_OWNER_BUSY')
      await rm(this.path)
    } catch (error) { if (!missing(error)) throw error }
    if (this.cancellation.signal.aborted) throw new AgentMuxError('Control endpoint startup was stopped.', 'CONTROL_CANCELLED')
    this.active = true
    const pending = this.reconcile(); this.pending = pending
    try { await pending }
    catch (error) {
      this.pending = undefined; this.active = false; clearTimeout(this.timer); this.cancellation.abort()
      await this.releaseListeners(); throw error
    }
    this.pending = undefined
    if (!this.active || this.cancellation.signal.aborted) throw new AgentMuxError('Control endpoint startup was stopped.', 'CONTROL_CANCELLED')
    this.schedule()
  }
  async stop(): Promise<void> {
    this.active = false; clearTimeout(this.timer); this.cancellation.abort()
    await this.starting?.catch(() => {})
    await this.pending?.catch(() => {})
    await this.releaseListeners()
  }
  private async releaseListeners(): Promise<void> {
    const listeners = [...this.retired, ...(this.current ? [this.current] : [])]
    this.current = undefined; this.retired.clear()
    await Promise.all(listeners.map(async listener => {
      await listener.close()
      await this.cleanup(listener, true)
    }))
    if (this.uncertain?.identity && await this.owns(this.uncertain.path, this.uncertain.identity)) await rm(this.uncertain.path)
  }
}
