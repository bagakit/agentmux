import type { WebContents } from 'electron'
import { AgentMuxError, agentMuxControlTimeoutMs, parseRendererHeapUsage, parseRendererWorkerMemoryResult,
  RENDERER_WORKER_MEMORY_LIMITS as LIMITS, type RendererWorkerMemoryInput, type RendererWorkerMemoryResult,
  type RendererWorkerMemoryRelation, type RendererWorkerMemoryText } from '@agentmux/core/control'

type Isolate = RendererWorkerMemoryResult['isolates'][number]
const identity = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\0\r\n]/u.test(v)
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AgentMuxError('Native Worker identity is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return v as Record<string, unknown>
}

/** One invocation of the original memory inspector; no independent debugger owner. */
export async function readRendererWorkerMemory(contents: WebContents, input: RendererWorkerMemoryInput,
  controller: AbortController, verify: () => void): Promise<RendererWorkerMemoryResult> {
  const client = contents.debugger, requestedAt = Date.now()
  const result: RendererWorkerMemoryResult = { ...input, schema: 'agentmux.renderer-worker-memory.v1', scope: 'renderer-related-dedicated-worker-isolates', units: 'bytes',
    status: 'failed', timing: { requestedAt, finishedAt: requestedAt }, sourceVerified: { before: true, after: false }, limits: { ...LIMITS },
    discovery: { scope: 'root-and-nested-dedicated-workers', coverage: 'bounded', startedAt: null, finishedAt: null, observed: 0, omitted: 0, ignored: 0, pending: 0 },
    root: null, relations: [], isolates: [], cleanup: { detached: 'not-attached' }, issues: [], issuesOmitted: 0 }
  let owned = false, detaching = false, accepting = true, discovering = false, active = 0, commandCount = 0, metadataLeft = LIMITS.metadataCodeUnits
  const relations = new Map<string, RendererWorkerMemoryRelation>(), queue: RendererWorkerMemoryRelation[] = []
  const readings = new Map<string, Promise<Isolate>>()
  const tasks = new Set<Promise<void>>(), timers = new Set<ReturnType<typeof setTimeout>>()
  const partial = () => { result.discovery.coverage = 'partial' }
  const issue = (stage: string, error: unknown, message: string) => {
    if (!accepting) return
    partial()
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.length <= 128 ? error.code : 'CONTROL_FAILED'
    if (result.issues.length < LIMITS.issues) result.issues.push({ stage, code, message, messageTruncated: false })
    else result.issuesOmitted++
  }
  const assertOwned = () => {
    try { verify() } catch (error) { controller.abort(error); throw error }
    controller.signal.throwIfAborted()
    if (!owned || contents.isDestroyed() || contents.isDevToolsOpened() || !client.isAttached())
      throw new AgentMuxError('Original Worker memory debugger ownership ended.', 'CONTROL_OWNER_LOST')
  }
  let rejectCancelled!: (reason: unknown) => void
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject })
  const abortCancelled = () => rejectCancelled(controller.signal.reason)
  if (controller.signal.aborted) abortCancelled(); else controller.signal.addEventListener('abort', abortCancelled, { once: true })
  void cancelled.catch(() => {})
  const command = async (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> => {
    assertOwned()
    if (++commandCount > LIMITS.commands) throw new AgentMuxError('Worker memory observation command budget reached.', 'CONTROL_OBSERVATION_LIMIT')
    const value: unknown = await Promise.race([client.sendCommand(method, params, sessionId), cancelled])
    assertOwned(); return record(value)
  }
  const pause = (ms: number) => Promise.race([new Promise<void>(resolve => {
    const timer = setTimeout(() => { timers.delete(timer); resolve() }, ms); timers.add(timer)
  }), cancelled])
  const metadata = (value: unknown, maximum: number): RendererWorkerMemoryText => {
    if (value === undefined) return { state: 'absent', value: null, originalLength: null }
    if (typeof value !== 'string') { issue('metadata', undefined, 'A native Worker metadata field is unavailable. Counters remain independently readable.'); return { state: 'unavailable', value: null, originalLength: null } }
    if (!metadataLeft && value.length) { partial(); return { state: 'omitted', value: null, originalLength: value.length } }
    const prefix = value.slice(0, Math.min(maximum, metadataLeft)); metadataLeft -= prefix.length
    if (prefix.length !== value.length) partial()
    return { state: prefix.length === value.length ? 'present' : 'truncated', value: prefix, originalLength: value.length }
  }
  const optionalIdentity = (value: unknown) => {
    if (value === undefined) return null
    if (identity(value)) return value
    issue('metadata', undefined, 'A native Worker relation label is unavailable. It was not used as authority.'); return null
  }
  const usage = (raw: Record<string, unknown>) => parseRendererHeapUsage({ usedSize: raw.usedSize, totalSize: raw.totalSize,
    embedderHeapUsedSize: raw.embedderHeapUsedSize ?? null, backingStorageSize: raw.backingStorageSize ?? null })
  const autoAttach = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
    filter: [{ type: 'worker', exclude: false }, { exclude: true }] }
  const read = async (row: RendererWorkerMemoryRelation) => {
    // Discovery on each admitted Worker preserves actual native nested relations.
    try { await command('Target.setAutoAttach', autoAttach, row.sessionId) }
    catch (error) { if (accepting) issue('discovery', error, 'Nested Worker discovery is incomplete. Existing Worker facts are retained.') }
    try {
      const found = await command('Runtime.getIsolateId', {}, row.sessionId)
      if (!identity(found.id)) throw new AgentMuxError('Native Worker isolate identity is invalid.', 'CONTROL_PROTOCOL_ERROR')
      if (!accepting) return
      row.isolateId = found.id
      if (row.endedAt !== null) throw new AgentMuxError('The observed Worker ended during this read.', 'CONTROL_OWNER_LOST')
      if (found.id === result.root!.isolateId) { row.status = 'root-alias'; return }
      let pending = readings.get(found.id)
      const alias = pending !== undefined
      if (!pending) {
        const isolateId = found.id
        pending = (async () => {
          const raw = await command('Runtime.getHeapUsage', {}, row.sessionId)
          const measured = usage(raw)
          if (!accepting || row.endedAt !== null) throw new AgentMuxError('The observed Worker ended before its counter reply.', 'CONTROL_OWNER_LOST')
          const sample = { isolateId, sessionId: row.sessionId, targetId: row.target.targetId, usage: measured, sampledAt: Date.now() }
          result.isolates.push(sample); return sample
        })()
        readings.set(isolateId, pending)
      }
      await pending
      if (accepting) row.status = row.endedAt !== null ? 'failed' : alias ? 'worker-alias' : 'measured'
    } catch (error) {
      if (!accepting) return
      row.status = 'failed'
      issue('child', error, 'An observed Worker counter could not be confirmed. Other original counters are retained.')
    }
  }
  const pump = () => {
    while (accepting && !controller.signal.aborted && active < LIMITS.concurrency && queue.length) {
      const row = queue.shift()!; active++
      const task = read(row).finally(() => { tasks.delete(task); active--; if (accepting) pump() })
      tasks.add(task)
    }
  }
  const receive = (_event: unknown, method: string, params: unknown, parent?: string) => {
    if (!accepting || !owned) return
    if (method === 'Target.detachedFromTarget') {
      try { const row = relations.get(record(params).sessionId as string); if (row) { row.endedAt = Date.now(); issue('child-ended', undefined, 'An observed Worker ended during the bounded query. Its earlier counters remain original.') } } catch { /* Unrelated native metadata does not alter other rows. */ }
      return
    }
    if (method !== 'Target.attachedToTarget') return
    try {
      const payload = record(params), native = record(payload.targetInfo)
      if (native.type !== 'worker') { result.discovery.ignored++; return }
      if (parent && !relations.has(parent)) { result.discovery.ignored++; issue('relation', undefined, 'A Worker attachment had no observed parent session and was not selected.'); return }
      if (!identity(payload.sessionId) || !identity(native.targetId)) throw new AgentMuxError('Native Worker target identity is invalid.', 'CONTROL_PROTOCOL_ERROR')
      const previous = relations.get(payload.sessionId)
      if (previous) { if (previous.target.targetId !== native.targetId) issue('relation', undefined, 'A native Worker session identity changed and was not reused.'); return }
      if (!discovering || relations.size >= LIMITS.relations) { result.discovery.omitted++; partial(); return }
      if (payload.waitingForDebugger !== false) issue('discovery', undefined, 'Native Worker no-pause acknowledgement was not confirmed. No resume or pause command was sent.')
      const row: RendererWorkerMemoryRelation = { sessionId: payload.sessionId, parentSessionId: parent || null,
        observedAt: Date.now(), endedAt: null, target: { targetId: native.targetId, type: 'worker', url: metadata(native.url, LIMITS.urlCodeUnits), title: metadata(native.title, LIMITS.titleCodeUnits),
          parentId: optionalIdentity(native.parentId), parentFrameId: optionalIdentity(native.parentFrameId), openerId: optionalIdentity(native.openerId), openerFrameId: optionalIdentity(native.openerFrameId) },
        status: 'pending', isolateId: null, process: null }
      relations.set(row.sessionId, row); result.relations.push(row); result.discovery.observed = relations.size; queue.push(row); pump()
    } catch (error) { result.discovery.omitted++; issue('relation', error, 'Native Worker relation metadata could not establish an exact observation target.') }
  }
  const lost = () => { owned = false; if (!detaching) controller.abort(new AgentMuxError('Original Worker memory debugger ownership ended.', 'CONTROL_OWNER_LOST')) }
  const changed = () => { try { verify() } catch (error) { controller.abort(error) } }
  const deadline = setTimeout(() => controller.abort(new AgentMuxError('Worker memory observation budget ended; original pages and Workers remain available.', 'CONTROL_TIMEOUT')),
    agentMuxControlTimeoutMs('metrics.memory.workers.inspect'))
  try {
    client.attach(); owned = true
    client.on('detach', lost); client.on('message', receive)
    contents.on('destroyed', changed); contents.on('render-process-gone', changed); contents.on('did-start-navigation', changed)
    assertOwned()
    const native = record((await command('Target.getTargetInfo')).targetInfo), rootId = await command('Runtime.getIsolateId')
    if (!identity(native.targetId) || !identity(rootId.id)) throw new AgentMuxError('Native root isolate identity is invalid.', 'CONTROL_PROTOCOL_ERROR')
    const rootUsage = usage(await command('Runtime.getHeapUsage'))
    result.root = { targetId: native.targetId, isolateId: rootId.id, usage: rootUsage, sampledAt: Date.now() }
    discovering = true; result.discovery.startedAt = Date.now()
    try { await command('Target.setAutoAttach', autoAttach) }
    catch (error) { issue('discovery', error, 'Related Worker discovery could not be fully confirmed. The original root counters remain available.') }
    await pause(LIMITS.discoveryMs)
    discovering = false; result.discovery.finishedAt = Date.now()
    while (tasks.size) await Promise.race([Promise.all([...tasks]), cancelled])
    assertOwned(); result.sourceVerified.after = true
    result.status = result.discovery.coverage === 'partial' ? 'partial' : 'completed'
  } catch (error) {
    issue('read', error, 'The original Worker memory observation did not complete. Successful individual counters remain original.')
    result.status = controller.signal.aborted || error instanceof AgentMuxError && error.code === 'CONTROL_OWNER_LOST' ? 'unknown' : 'failed'
  } finally {
    accepting = false; discovering = false
    controller.signal.removeEventListener('abort', abortCancelled)
    clearTimeout(deadline); for (const timer of timers) clearTimeout(timer); timers.clear()
    contents.removeListener('destroyed', changed); contents.removeListener('render-process-gone', changed); contents.removeListener('did-start-navigation', changed)
    client.removeListener('message', receive)
    if (owned && !contents.isDestroyed() && !contents.isDevToolsOpened() && client.isAttached()) {
      detaching = true
      try { client.detach(); result.cleanup.detached = client.isAttached() ? 'unconfirmed' : 'confirmed' }
      catch { result.cleanup.detached = 'unconfirmed' }
    } else if (owned || controller.signal.aborted) result.cleanup.detached = 'owner-lost'
    client.removeListener('detach', lost)
    if (result.cleanup.detached !== 'confirmed') result.status = 'unknown'
    result.discovery.pending = result.relations.filter(row => row.status === 'pending').length
    if (result.discovery.pending) partial()
    result.timing.finishedAt = Date.now()
  }
  return parseRendererWorkerMemoryResult(result, input)
}
