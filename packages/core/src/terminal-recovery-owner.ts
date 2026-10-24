import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { durableWriteFile } from './durable-write.js'
import { AgentMuxError } from './errors.js'
import { mintObjectId } from './object-id.js'
import { rpcRecord } from './rpc-data.js'
import { parsePreparedTerminal, type AgentMuxPreparedTerminal } from './terminal-preparation.js'
import { parseCreationRuntime, type AgentMuxCreationRuntime, type AgentMuxTerminalCreationRetirement, type AgentMuxTerminalCreationRetirementObservation } from './terminal-creation-retirement.js'
import { parseTerminalRecoveryInput, type AgentMuxTerminalRecoveryInput, type AgentMuxTerminalRecoveryResult } from './terminal-recovery.js'
import type { AgentMuxRun, AgentMuxRunRef } from './types.js'

type Intent = {
  schemaVersion: 1; expectedRun: AgentMuxRunRef; runtimeId: string; workspacePath: string; operationId: string
  prepared: AgentMuxPreparedTerminal; phase: 'prepared' | 'dispatched' | 'retained' | 'not_applied'
  run: AgentMuxRunRef | null; continuedBy: string[]; retirement: AgentMuxCreationRuntime | null
  retiredAttempts: Array<{ prepared: AgentMuxPreparedTerminal; runtime: AgentMuxCreationRuntime; continuationOperationId: string }>
}
type Port = {
  runtime(): AgentMuxCreationRuntime
  /** Confirms raw ownership from durable Core bindings and exact Native status. */
  original(input: AgentMuxTerminalRecoveryInput): Promise<AgentMuxRun | null>
  prepare(operationId: string, workspacePath: string): Promise<AgentMuxPreparedTerminal>
  start(prepared: AgentMuxPreparedTerminal): Promise<AgentMuxRun>
  inspect(prepared: AgentMuxPreparedTerminal, ref?: AgentMuxRunRef): Promise<AgentMuxRun | null>
  retire(prepared: AgentMuxPreparedTerminal, runtime: AgentMuxCreationRuntime): Promise<AgentMuxTerminalCreationRetirement>
  observeRetirement(prepared: AgentMuxPreparedTerminal, runtime: AgentMuxCreationRuntime): Promise<AgentMuxTerminalCreationRetirementObservation>
}
const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
const failure = (message: string) => new AgentMuxError(message + ' The original work surface and healthy Runs are retained.', 'TERMINAL_RECOVERY_UNCONFIRMED')
function parseIntent(value: unknown): Intent {
  const r = rpcRecord(value, ['schemaVersion', 'expectedRun', 'runtimeId', 'workspacePath', 'operationId', 'prepared', 'phase', 'run', 'continuedBy', 'retirement', 'retiredAttempts'])
  parseTerminalRecoveryInput({ expectedRun: r.expectedRun, runtimeId: r.runtimeId, workspacePath: r.workspacePath, operationId: r.operationId })
  const prepared = parsePreparedTerminal(r.prepared)
  if (r.schemaVersion !== 1 || prepared.workspacePath !== r.workspacePath || !['prepared', 'dispatched', 'retained', 'not_applied'].includes(String(r.phase)) ||
      !Array.isArray(r.continuedBy) || r.continuedBy.some(id => typeof id !== 'string' || !id || /[\0\r\n]/u.test(id)) || new Set(r.continuedBy).size !== r.continuedBy.length) throw failure('The original terminal recovery intent is invalid.')
  if (r.run !== null && (typeof rpcRecord(r.run, ['runId']).runId !== 'string' || !rpcRecord(r.run).runId) || r.phase === 'retained' && r.run === null) throw failure('The retained replacement Run is unconfirmed.')
  if (r.retirement !== null) parseCreationRuntime(r.retirement)
  if (r.phase === 'not_applied' && r.retirement === null) throw failure('The original creation has no confirmed Native retirement fence.')
  if (!Array.isArray(r.retiredAttempts)) throw failure('The original creation fence history is unconfirmed.')
  for (const value of r.retiredAttempts) {
    const old = rpcRecord(value, ['prepared', 'runtime', 'continuationOperationId'])
    if (parsePreparedTerminal(old.prepared).workspacePath !== r.workspacePath || parseCreationRuntime(old.runtime).runtimeId !== r.runtimeId ||
        typeof old.continuationOperationId !== 'string' || !r.continuedBy.includes(old.continuationOperationId)) throw failure('The original creation fence identity changed.')
  }
  return structuredClone(r) as Intent
}

/** Private Host material only. No frozen environment enters the spatial graph or public receipt. */
export class TerminalRecoveryOwner {
  constructor(private readonly directory: string, private readonly port: Port) {}
  private path(input: AgentMuxTerminalRecoveryInput): string {
    return join(this.directory, createHash('sha256').update(input.expectedRun.runId).digest('hex') + '.json')
  }
  private async read(path: string): Promise<Intent | null> {
    try { return parseIntent(JSON.parse(await readFile(path, 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  private async locked<T>(path: string, work: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    // Stable inode; never unlink a lock that another Core process may already have opened.
    const lock = await open(path + '.lock', 'a+', 0o600)
    try {
      const deadline = Date.now() + 5000
      while (!native.tryLock(lock.fd)) { if (Date.now() > deadline) throw failure('The original terminal recovery is completing admission; inspect the same intent.'); await delay(10) }
      // A newly created private namespace must itself be durable before any Start.
      // Every contender acknowledges it; observing mkdir success in another process is not fsync.
      const parent = await open(dirname(this.directory), 'r')
      try { await parent.sync() } finally { await parent.close() }
      return await work()
    } finally { await lock.close() }
  }
  private save(path: string, intent: Intent): Promise<void> {
    parseIntent(intent)
    return durableWriteFile(path, JSON.stringify(intent) + '\n', { mode: 0o600, requireDirectorySync: true })
  }
  private identity(input: AgentMuxTerminalRecoveryInput): AgentMuxCreationRuntime {
    const runtime = this.port.runtime()
    if (runtime.runtimeId !== input.runtimeId) throw failure('The requested terminal belongs to another persistent Runtime.')
    return runtime
  }
  private assertIntent(intent: Intent, input: AgentMuxTerminalRecoveryInput): void {
    if (intent.expectedRun.runId !== input.expectedRun.runId || intent.runtimeId !== input.runtimeId || intent.workspacePath !== input.workspacePath)
      throw failure('The original terminal recovery target or execution directory changed.')
  }
  private result(intent: Intent, run?: AgentMuxRun): AgentMuxTerminalRecoveryResult {
    const base = { expectedRun: intent.expectedRun, runtimeId: intent.runtimeId, operationId: intent.operationId }
    if (run?.state === 'running') return { ...base, kind: 'recovered', run }
    return { ...base, kind: 'pending', phase: intent.phase, ...(intent.run ? { replacementRun: intent.run } : {}),
      message: intent.phase === 'retained' ? 'The original replacement is retained but has ended; inspect its exact Run.'
        : 'The original terminal creation is unconfirmed. Inspect this same intent; explicit continue fences its original creation before a successor.' }
  }
  async recover(value: AgentMuxTerminalRecoveryInput): Promise<AgentMuxTerminalRecoveryResult> {
    const input = parseTerminalRecoveryInput(value), runtime = this.identity(input), path = this.path(input)
    const original = await this.port.original(input)
    if (original?.state === 'running') return { kind: 'reattachable', expectedRun: input.expectedRun, runtimeId: input.runtimeId, operationId: input.operationId, run: original }
    let intent = await this.read(path)
    if (!intent && input.action === 'inspect') return { kind: 'pending', expectedRun: input.expectedRun, runtimeId: input.runtimeId, operationId: input.operationId, phase: 'not_applied', message: 'No recovery intent has been admitted for this original Run.' }
    // Shell preparation can await Host discovery. It never holds the per-Run admission lock.
    // A caller operation can be reused for another old Run; it cannot alias Native creations.
    const prepared = !intent ? await this.port.prepare(mintObjectId(), input.workspacePath) : undefined
    intent = await this.locked(path, async () => {
      const prior = await this.read(path)
      if (prior) { this.assertIntent(prior, input); return prior }
      const created: Intent = { schemaVersion: 1, expectedRun: input.expectedRun, runtimeId: input.runtimeId,
        workspacePath: input.workspacePath, operationId: input.operationId, prepared: prepared!, phase: 'prepared', run: null, continuedBy: [], retirement: null, retiredAttempts: [] }
      await this.save(path, created); return created
    })
    this.assertIntent(intent, input)
    // Each update is bound to the attempt observed before its Native await. A lost
    // compare-and-swap only returns the latest intent; it never follows its successor.
    const update = async (attempt: AgentMuxPreparedTerminal, change: (current: Intent) => boolean) =>
      this.locked(path, async () => {
        const current = (await this.read(path))!
        this.assertIntent(current, input)
        const changed = current.prepared.createOperationId === attempt.createOperationId && change(current)
        if (changed) await this.save(path, current)
        return { current, changed }
      })
    // A confirmed retirement is monotonic even before a successor is prepared.
    // A reply generated before that fence cannot resurrect the same attempt.
    const retain = (current: Intent, run: AgentMuxRun): boolean => {
      if (!['dispatched', 'retained'].includes(current.phase)) return false
      current.phase = 'retained'; current.run = { runId: run.runId }; return true
    }
    // A durable dispatched marker may precede a lost Start reply or a Core crash. Only observe.
    if (intent.phase === 'dispatched' || intent.phase === 'retained') {
      const attempt = intent.prepared
      const retained = await this.port.inspect(attempt, intent.run ?? undefined)
      if (retained) {
        const observed = await update(attempt, current => retain(current, retained))
        intent = observed.current
        if (!observed.changed) return this.result(intent)
        return this.result(intent, retained)
      }
      if (intent.retirement) {
        const fence = await this.port.observeRetirement(attempt, intent.retirement)
        if (fence.outcome === 'retired') {
          const observed = await update(attempt, current => { current.phase = 'not_applied'; return true })
          intent = observed.current
          if (!observed.changed) return this.result(intent)
        }
      }
      if (intent.phase !== 'not_applied' && input.action !== 'continue') return this.result(intent)
      if (intent.phase !== 'not_applied' && intent.continuedBy.includes(input.operationId)) return this.result(intent)
      if (intent.phase !== 'not_applied') {
        // Admit the exact attempt, phase and unused authorization under the lock.
        // A concurrent owner may already have consumed this operation for a successor.
        let retirementRuntime: AgentMuxCreationRuntime | null = null
        const admitted = await update(attempt, current => {
          if (!['dispatched', 'retained'].includes(current.phase) || current.continuedBy.includes(input.operationId)) return false
          current.retirement ??= runtime; retirementRuntime = current.retirement; return true
        })
        intent = admitted.current
        if (!admitted.changed) return this.result(intent)
        const retirement = await this.port.retire(attempt, retirementRuntime!)
        if (retirement.outcome === 'retained') {
          const observed = await update(attempt, current => retain(current, retirement.run))
          intent = observed.current
          if (!observed.changed) return this.result(intent)
          return this.result(intent, retirement.run)
        }
        const observed = await update(attempt, current => { current.phase = 'not_applied'; return true })
        intent = observed.current
        if (!observed.changed) return this.result(intent)
      }
    }
    if (intent.phase === 'not_applied') {
      if (input.action !== 'continue' || intent.continuedBy.includes(input.operationId)) return this.result(intent)
      const attempt = intent.prepared, next = await this.port.prepare(mintObjectId(), input.workspacePath)
      const continued = await update(attempt, current => {
        if (current.phase !== 'not_applied' || current.continuedBy.includes(input.operationId)) return false
        current.retiredAttempts.push({ prepared: current.prepared, runtime: current.retirement!, continuationOperationId: input.operationId })
        current.continuedBy.push(input.operationId); current.prepared = next; current.phase = 'prepared'; current.run = null; current.retirement = null
        return true
      })
      intent = continued.current
      if (!continued.changed) return this.result(intent)
    }
    if (input.action === 'inspect' || intent.phase !== 'prepared') return this.result(intent)
    // One process claims dispatch under a short per-original-Run lock, before any Native wait.
    const attempt = intent.prepared
    const dispatched = await update(attempt, current => { if (current.phase !== 'prepared') return false; current.phase = 'dispatched'; return true })
    intent = dispatched.current
    if (!dispatched.changed) return this.result(intent)
    this.identity(input)
    let run: AgentMuxRun
    try { run = await this.port.start(attempt) }
    catch { return this.result(intent) }
    const observed = await update(attempt, current => retain(current, run))
    intent = observed.current
    if (!observed.changed) return this.result(intent)
    return this.result(intent, run)
  }
}
