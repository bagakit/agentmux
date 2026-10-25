import { createHash } from 'node:crypto'
import { delimiter, dirname, join } from 'node:path'
import { CTXMUX_VERSION } from './ctxmux-run-adapter.js'
import { AgentMuxError } from './errors.js'
import { removeHostColorSignals } from './terminal-environment-policy.js'
import { defaultAgentMuxMessageQueuePath, defaultAgentMuxStateDirectory, resolveCoreBinPath } from './runtime-paths.js'
import type { AgentProviderId, AgentMuxAgentSession, AgentMuxRunRef, AgentTerminalHandshake } from './types.js'
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const AGENTMUX_CLI_PATH = resolveCoreBinPath('amux')
export function runRef(runId: string): AgentMuxRunRef {
  return { runId }
}

export function safeId(value: string, name: string): string {
  if (!SAFE_ID.test(value)) {
    throw new AgentMuxError(`${name} must contain only letters, numbers, underscore, or dash.`, 'INVALID_SESSION_ID')
  }
  return value
}

export function hookBindingIdentity(operationId: string): string {
  return createHash('sha256').update(operationId).digest('base64url')
}

export function terminalHandshakeOperationIdentity(
  providerId: AgentProviderId,
  runId: string,
  handshake: AgentTerminalHandshake,
  frontendId?: string
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'agentmux-terminal-handshake-v1',
      providerId,
      runId,
      handshake.query,
      handshake.response,
      ...(frontendId ? [frontendId] : [])
    ]))
    .digest('base64url')
}

export function terminalInitialPromptReadinessIdentity(
  session: AgentMuxAgentSession,
  handshakeOperationId: string
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'agentmux-terminal-prompt-readiness-v1',
      'initial-composer',
      session.providerId,
      session.run.runId,
      handshakeOperationId
    ]))
    .digest('base64url')
}

export function terminalEnvironment(
  environment: Readonly<Record<string, string>>,
  agentSessionStorePath?: string
): Record<string, string> {
  const inheritedPath = environment.PATH ?? process.env.PATH ?? ''
  const resolved: Record<string, string> = {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'AgentMux',
    // Bound to the SHA-verified vendored runtime version, not a hand-copied literal — see
    // CTXMUX_VERSION in ctxmux-run-adapter.ts. Bumping the vendored artifact must not leave this
    // TERM_PROGRAM_VERSION frozen at a stale string.
    TERM_PROGRAM_VERSION: CTXMUX_VERSION,
    FORCE_HYPERLINK: '1',
    ...environment,
    PATH: [dirname(AGENTMUX_CLI_PATH), inheritedPath].filter(Boolean).join(delimiter),
    AGENTMUX_ENV: '1',
    AGENTMUX_CLI: AGENTMUX_CLI_PATH,
    AGENTMUX_STATE_DIRECTORY: defaultAgentMuxStateDirectory(),
    // Tell every process AgentMux spawns where the Agent Session store lives, so the CLI an Agent runs
    // resolves sessions out of the SAME file this Client writes rather than another default scope.
    // The path's authority is whoever constructed the store (the desktop points it at userData).
    ...(agentSessionStorePath ? {
      AGENTMUX_AGENT_SESSION_STORE: agentSessionStorePath
    } : {}),
    AGENTMUX_MESSAGE_QUEUE_PATH: defaultAgentMuxMessageQueuePath(
      agentSessionStorePath ?? null, environment.AGENTMUX_MESSAGE_QUEUE_PATH ?? process.env.AGENTMUX_MESSAGE_QUEUE_PATH
    )
  }
  // `environment` is the last merge before the PTY boundary. A desktop process can carry
  // NO_COLOR/CLICOLOR=0 from the shell that launched it, and passing those values through here makes
  // Provider behavior diverge: Claude follows them and turns its TUI monochrome while Codex may keep
  // emitting ANSI. The Runtime baseline removes the same signals for daemon startup; repeat that
  // invariant at the final Agent/Terminal launch boundary so a stale daemon or executor snapshot cannot
  // reintroduce them.
  removeHostColorSignals(resolved)
  return resolved
}
