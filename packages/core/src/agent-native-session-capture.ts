import type { AgentProvider } from './agent-provider.js'
import type { AgentMuxAgentSessionRegistry } from './agent-session-registry.js'
import type { CtxmuxRunAdapter } from './ctxmux-run-adapter.js'
import { matchesProviderNativeSessionTarget, normalizeNativeSessionId, normalizeNativeTranscriptPath } from './agent-native-locator.js'
import { sameRun } from './agent-session-identity.js'
import { AgentMuxError } from './errors.js'
import type { AgentMuxStoredAgentSession, AgentNativeSessionHandle } from './types.js'

function changed(message: string): AgentMuxError {
  return new AgentMuxError(message, 'AGENT_NATIVE_IDENTITY_UNCONFIRMED')
}

function sameHandle(left: AgentNativeSessionHandle | undefined, right: AgentNativeSessionHandle): boolean {
  return left?.kind === 'provider' && right.kind === 'provider' && left.providerId === right.providerId &&
    left.sessionId === right.sessionId && left.transcriptPath === right.transcriptPath
}

/** Provider discovery is a lifecycle observation, independent of conversation readers. */
export async function captureAgentNativeSessionIdentity(input: {
  session: AgentMuxStoredAgentSession
  provider: AgentProvider
  registry: AgentMuxAgentSessionRegistry
  kernel: Pick<CtxmuxRunAdapter, 'status'>
  signal: AbortSignal
  assertConnection(): void
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  /** The original initialized actor may add a witnessed locator to its confirmed identity. */
  enrichConfirmedIdentity?: true
}): Promise<AgentMuxStoredAgentSession> {
  const { session: expected, registry, kernel, provider, signal } = input
  const assertObservation = (): void => { signal.throwIfAborted(); input.assertConnection() }
  const assertSession = (current: AgentMuxStoredAgentSession): void => {
    assertObservation()
    if (current.agentSessionId !== expected.agentSessionId || current.hostId !== 'local' ||
      current.providerId !== expected.providerId || current.workspacePath !== expected.workspacePath ||
      !sameRun(current.run, expected.run)) throw changed('The original Session changed during native identity capture.')
  }
  assertObservation()
  let current = await registry.refresh(expected.agentSessionId, expected.run)
  assertSession(current)
  const confirmed = current.nativeHandle ?? expected.nativeHandle
  const enrich = input.enrichConfirmedIdentity === true && (!confirmed || confirmed.kind === 'provider')
  if (enrich && expected.nativeHandle && !matchesProviderNativeSessionTarget(expected.nativeHandle, current.nativeHandle)) {
    throw changed('The original confirmed native identity changed before locator capture.')
  }
  // A concurrently confirmed Hook identity remains authoritative; never replace it by discovery.
  if (current.nativeHandle && (!enrich || current.nativeHandle.kind !== 'provider' || current.nativeHandle.transcriptPath !== undefined)) return current
  const firstRun = await kernel.status(expected.run.runId)
  const assertRun = async (): Promise<void> => {
    assertObservation()
    const run = await kernel.status(expected.run.runId)
    assertObservation()
    if (run.runId !== expected.run.runId || run.workspacePath !== expected.workspacePath ||
      run.state.type !== 'running' || run.pid !== firstRun.pid) {
      throw changed('The original Run process changed during native identity capture.')
    }
  }
  assertObservation()
  if (firstRun.runId !== expected.run.runId || firstRun.workspacePath !== expected.workspacePath ||
    firstRun.state.type !== 'running' || !Number.isSafeInteger(firstRun.pid) || !firstRun.pid || firstRun.pid <= 0) {
    throw changed('The original running process is unconfirmed; its retained work is kept.')
  }
  const discovered = await provider.discoverNativeSession!({ processId: firstRun.pid,
    workspacePath: expected.workspacePath, command: input.command, args: input.args, env: input.env, signal })
  assertObservation()
  const handle = discovered?.handle
  if (!handle || handle.kind !== 'provider' || handle.providerId !== expected.providerId ||
    normalizeNativeSessionId(handle.sessionId) !== handle.sessionId ||
    (handle.transcriptPath !== undefined && normalizeNativeTranscriptPath(handle.transcriptPath) !== handle.transcriptPath)) {
    throw changed('No unique main native identity was confirmed; the original Agent input remains available.')
  }
  if (enrich && confirmed && !matchesProviderNativeSessionTarget(confirmed, handle)) {
    throw changed('Discovery did not confirm the original native conversation.')
  }
  const assertHandle = (value: AgentMuxStoredAgentSession): void => {
    if (enrich && confirmed && !matchesProviderNativeSessionTarget(confirmed, value.nativeHandle) ||
      value.nativeHandle && !sameHandle(value.nativeHandle, handle) && !(enrich && value.nativeHandle.kind === 'provider' &&
        value.nativeHandle.transcriptPath === undefined && matchesProviderNativeSessionTarget(value.nativeHandle, handle))) {
      throw changed('Native locator capture cannot replace a concurrent confirmed identity or locator.')
    }
  }
  await assertRun()
  await discovered.assertCurrent()
  await assertRun()
  current = await registry.refresh(expected.agentSessionId, expected.run)
  assertSession(current)
  assertHandle(current)
  if (current.nativeHandle && sameHandle(current.nativeHandle, handle)) return current
  // A successful CAS is the acknowledgement. Readable post-rename bytes cannot replace it.
  return await registry.update(expected.agentSessionId, expected.run, value => {
    assertSession(value)
    assertHandle(value)
    return { ...value, nativeHandle: { ...(value.nativeHandle?.kind === 'provider' ? value.nativeHandle : handle),
      ...(handle.transcriptPath === undefined ? {} : { transcriptPath: handle.transcriptPath }) }, updatedAt: Math.max(value.updatedAt, Date.now()) }
  }, signal)
}
