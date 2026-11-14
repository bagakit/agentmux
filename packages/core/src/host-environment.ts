import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'

export type AgentMuxHostEnvironment = { homeDirectory: string }
export type AgentMuxHostEnvironmentSelector = { agentSessionId: string }
export type AgentMuxAgentWorkspaceLocator = { runtimeId: string; agentSessionId: string; workspacePath: string }
export type AgentMuxSelectedHostEnvironment = AgentMuxHostEnvironment & { agentWorkspace: AgentMuxAgentWorkspaceLocator }

/** A remote absolute path retains its executing platform's spelling and trailing spaces. */
export function parseHostEnvironment(value: unknown): AgentMuxHostEnvironment {
  const p = rpcRecord(value, ['homeDirectory'], 'CONTROL_PROTOCOL_ERROR')
  if (typeof p.homeDirectory !== 'string' || !p.homeDirectory || /[\0\r\n]/u.test(p.homeDirectory) ||
      !(p.homeDirectory.startsWith('/') || /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(p.homeDirectory))) {
    throw new AgentMuxError('The original Host home directory is unconfirmed.', 'CONTROL_PROTOCOL_ERROR')
  }
  return { homeDirectory: p.homeDirectory }
}

export function parseHostEnvironmentSelector(value: unknown): AgentMuxHostEnvironmentSelector {
  const p = rpcRecord(value, ['agentSessionId'])
  return { agentSessionId: rpcString(p.agentSessionId, 'Original Agent Session ID') }
}

/** Validate a selected read without changing the stricter two-key no-argument result. */
export function parseSelectedHostEnvironment(value: unknown, selector: AgentMuxHostEnvironmentSelector,
  expectedRuntimeId?: string): AgentMuxSelectedHostEnvironment {
  const selected = parseHostEnvironmentSelector(selector)
  const p = rpcRecord(value, ['homeDirectory', 'agentWorkspace'], 'CONTROL_PROTOCOL_ERROR')
  const home = parseHostEnvironment({ homeDirectory: p.homeDirectory })
  const workspace = rpcRecord(p.agentWorkspace, ['runtimeId', 'agentSessionId', 'workspacePath'], 'CONTROL_PROTOCOL_ERROR')
  const invalid = (): never => { throw new AgentMuxError('The original Host Agent workspace locator is unconfirmed.', 'CONTROL_PROTOCOL_ERROR') }
  const field = (value: unknown): string => {
    if (typeof value !== 'string') return invalid()
    if (!value || /[\0\r\n]/u.test(value) || new TextEncoder().encode(value).byteLength > 4096) return invalid()
    return value
  }
  const runtimeId = field(workspace.runtimeId), agentSessionId = field(workspace.agentSessionId), workspacePath = field(workspace.workspacePath)
  if (!(workspacePath.startsWith('/') || /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(workspacePath))) invalid()
  if (agentSessionId !== selected.agentSessionId || expectedRuntimeId !== undefined && runtimeId !== expectedRuntimeId) invalid()
  return { ...home, agentWorkspace: { runtimeId, agentSessionId, workspacePath } }
}
