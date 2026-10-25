import { createHash } from 'node:crypto'
import { Session } from 'node:inspector/promises'
import { setTimeout } from 'node:timers/promises'
import { AgentMuxError } from './errors.js'
import type { AgentMuxRuntimeOwnerIdentity } from './hosted-client-contract.js'
import type { RuntimeV8ProfileInput, RuntimeV8ProfileResult } from './runtime-v8-profile.js'
import { v8ProfileJSON } from './v8-profile.js'

// The profiler belongs to this Node process, not to a route, consumer, or Session.
let active = false
export async function captureRuntimeV8Profile(input: RuntimeV8ProfileInput,
  readOwner: () => AgentMuxRuntimeOwnerIdentity, signal?: AbortSignal): Promise<RuntimeV8ProfileResult> {
  signal?.throwIfAborted()
  const owner = structuredClone(readOwner())
  const matches = (value: AgentMuxRuntimeOwnerIdentity) => value.runtimeId === input.fence.runtimeId &&
    value.ownerInstanceId === input.fence.ownerInstanceId && value.processId === input.processId && input.processId === process.pid
  if (!matches(owner)) throw new AgentMuxError('The original Host process changed. No profile was started.', 'RUNTIME_PROFILE_TARGET_CHANGED')
  if (active) throw new AgentMuxError('This Host already has an active CPU capture. Existing work is retained.', 'RUNTIME_PROFILE_BUSY')
  active = true
  const started = performance.now(), session = new Session()
  const result: RuntimeV8ProfileResult = {
    schema: 'agentmux.runtime-v8-profile.v1', scope: 'semantic-host-main-thread-v8', owner, durationMs: input.durationMs,
    status: 'failed', timing: { requestedAt: Date.now(), startedAt: null, stoppedAt: null, finishedAt: 0, elapsedMs: 0 },
    sourceVerified: { before: true, after: false }, cleanup: { stopped: false, disabled: false, disconnected: false },
    profile: null, profileBytes: null, profileSha256: null, issues: []
  }
  let connected = false, enabled = false, startRequested = false, stage = 'connect'
  const issue = (where: string, error: unknown) => result.issues.push({ stage: where,
    message: (error instanceof Error ? error.message : String(error)).slice(0, 512) })
  try {
    session.connect(); connected = true
    stage = 'enable'; await session.post('Profiler.enable'); enabled = true
    signal?.throwIfAborted()
    stage = 'start'; startRequested = true; await session.post('Profiler.start'); result.timing.startedAt = Date.now()
    stage = 'capture'; await setTimeout(input.durationMs, undefined, { signal })
  } catch (error) { issue(stage, error) }
  finally {
    if (startRequested) {
      try {
        const { profile } = await session.post('Profiler.stop')
        result.cleanup.stopped = true; result.timing.stoppedAt = Date.now()
        const json = v8ProfileJSON(profile)
        result.profile = profile
        result.profileBytes = Buffer.byteLength(json); result.profileSha256 = createHash('sha256').update(json).digest('hex')
      } catch (error) { result.profile = null; result.profileBytes = null; result.profileSha256 = null; issue('stop', error) }
    }
    if (enabled) { try { await session.post('Profiler.disable'); result.cleanup.disabled = true } catch (error) { issue('disable', error) } }
    try { session.disconnect(); result.cleanup.disconnected = true } catch (error) { issue('disconnect', error) }
    // A failed disconnect cannot admit another capture over an unresolved connection.
    active = connected && !result.cleanup.disconnected
    try { result.sourceVerified.after = matches(readOwner()) } catch (error) { issue('owner', error) }
    result.timing.finishedAt = Date.now(); result.timing.elapsedMs = performance.now() - started
  }
  result.status = !result.cleanup.disconnected || !result.sourceVerified.after ? 'unknown' : signal?.aborted ? 'cancelled' :
    result.profile !== null && result.cleanup.stopped && result.cleanup.disabled && !result.issues.length ? 'completed' : 'failed'
  return result
}
