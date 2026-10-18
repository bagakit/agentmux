import { AgentMuxError, type AgentMuxBrowserControl, type AgentMuxAgentCreationInspection } from '@agentmux/core'
import type { BrowserControlHandoff } from '../shared/contracts.js'
import type { RuntimeController } from './runtime-controller.js'

export type BrowserAgent = NonNullable<AgentMuxBrowserControl['agent']>
export type BrowserAgentAuthority = {
  /** Original retained Core identities, never Session display membership or operation history. */
  resolve(agentSessionId: string): BrowserAgent | undefined
  inspect(agent: BrowserAgent): Promise<AgentMuxAgentCreationInspection & { hostId: string }>
}

export function browserAgentAuthority(runtime: Pick<RuntimeController, 'rpcClients' | 'agentCreation'>): BrowserAgentAuthority {
  return {
    resolve(agentSessionId) {
      const owners = runtime.rpcClients().flatMap(({ hostId, client }) => {
        try { return client.agentSession(agentSessionId).agentSessionId === agentSessionId ? [{ hostId, agentSessionId }] : [] }
        catch { return [] }
      })
      return owners.length === 1 ? owners[0] : undefined
    },
    inspect: agent => runtime.agentCreation(agent.hostId, agent.agentSessionId)
  }
}

/** Narrow only this trusted operation; no caller-supplied approval or loose object casting. */
export function parseBrowserControlHandoff(input: unknown): BrowserControlHandoff {
  const invalid = () => new AgentMuxError('An exact Browser navigation, revision and Agent Session/Run are required for this handoff.', 'INVALID_CONTROL_REQUEST')
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid()
  const value = input as Record<string, unknown>, source = value.agent
  if (Object.keys(value).some(key => !['agent', 'navigationId', 'expectedRevision'].includes(key)) ||
    typeof value.navigationId !== 'string' || !value.navigationId.trim() || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0 ||
    !source || typeof source !== 'object' || Array.isArray(source)) throw invalid()
  const agent = source as Record<string, unknown>, run = agent.run
  if (Object.keys(agent).some(key => !['kind', 'hostId', 'agentSessionId', 'run'].includes(key)) || agent.kind !== 'agent' ||
    typeof agent.hostId !== 'string' || !agent.hostId.trim() || typeof agent.agentSessionId !== 'string' || !agent.agentSessionId.trim() ||
    !run || typeof run !== 'object' || Array.isArray(run) || Object.keys(run).some(key => key !== 'runId') ||
    typeof (run as Record<string, unknown>).runId !== 'string' || !(run as { runId: string }).runId.trim()) throw invalid()
  return { navigationId: value.navigationId, expectedRevision: Number(value.expectedRevision), agent: {
    kind: 'agent', hostId: agent.hostId, agentSessionId: agent.agentSessionId, run: { runId: (run as { runId: string }).runId }
  } }
}
