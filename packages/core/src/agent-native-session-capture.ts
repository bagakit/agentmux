import type { AgentProvider } from './agent-provider.js'
import type { AgentMuxAgentSessionRegistry } from './agent-session-registry.js'
import type { CtxmuxRunAdapter } from './ctxmux-run-adapter.js'
import { normalizeNativeSessionId, normalizeNativeTranscriptPath } from './agent-native-locator.js'
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
  // A concurrently confirmed Hook identity remains authoritative; never replace it by discovery.
  if (current.nativeHandle) return current
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
  await assertRun()
  await discovered.assertCurrent()
  await assertRun()
  current = await registry.refresh(expected.agentSessionId, expected.run)
  assertSession(current)
  if (current.nativeHandle && !sameHandle(current.nativeHandle, handle)) {
    throw changed('A concurrent confirmed native identity cannot be replaced by discovery.')
  }
  if (current.nativeHandle) return current
  // A successful CAS is the acknowledgement. Readable post-rename bytes cannot replace it.
  return await registry.update(expected.agentSessionId, expected.run, value => {
    assertSession(value)
    if (value.nativeHandle && !sameHandle(value.nativeHandle, handle)) {
      throw changed('Native identity capture cannot overwrite a concurrent Hook identity.')
    }
    return { ...value, nativeHandle: { ...handle }, updatedAt: Math.max(value.updatedAt, Date.now()) }
  }, signal)
}
