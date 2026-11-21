import type { AgentConfigurationSet, AgentMuxControlFailure } from '@agentmux/core'

/** The requested operation is known even when transport cannot deliver its receipt. */
export class AgentConfigurationRequestError extends Error {
  readonly code?: string
  readonly controlFailure?: AgentMuxControlFailure
  constructor(readonly request: AgentConfigurationSet, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AgentConfigurationRequestError'
    const source = cause instanceof Error ? cause as Error & { code?: unknown; controlFailure?: AgentMuxControlFailure } : undefined
    if (typeof source?.code === 'string') this.code = source.code
    if (source?.controlFailure) this.controlFailure = source.controlFailure
  }
}
