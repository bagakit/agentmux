export type AgentProviderAcpProbeContext = {
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  workspacePath: string
  signal?: AbortSignal
}

/** Initialize declarations and the result of one scoped session/list observation. */
export type AgentProviderAcpHandshake = {
  protocolVersion: 1
  sessions: { list: boolean; load: boolean; resume: boolean; close: boolean; additionalDirectories: boolean }
  prompt: { image: boolean; audio: boolean; embeddedContext: boolean }
}

export const AGENT_PROVIDER_ACP_PROBE_FAILURES = [
  'spawn-failed', 'transport-closed', 'response-timeout', 'invalid-response', 'incompatible-protocol', 'rpc-error'
] as const

export type AgentProviderAcpProbeFailure = typeof AGENT_PROVIDER_ACP_PROBE_FAILURES[number]

type ProbeUnknown = { state: 'unconfirmed'; reason: AgentProviderAcpProbeFailure; rpcCode?: number }
export type AgentProviderAcpProbe =
  | { handshake: null; service: { state: 'unsupported'; stage: 'provider' } }
  | { handshake: null; service: ProbeUnknown & { stage: 'launch' | 'initialize' } }
  | { handshake: AgentProviderAcpHandshake; service: { state: 'ready' | 'unsupported'; stage: 'session/list' } }
  | { handshake: AgentProviderAcpHandshake; service: { state: 'authentication-required'; stage: 'session/list'; rpcCode: -32000 } }
  | { handshake: AgentProviderAcpHandshake; service: ProbeUnknown & { stage: 'session/list' } }
