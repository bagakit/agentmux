import { AgentMuxError } from '@agentmux/core'

/** Only the original resolver's structured failures are safe credential facts. */
export function credentialLookupFailure(error: unknown): 'credential-format-unsupported' | 'credential-unavailable' | undefined {
  if (!(error instanceof AgentMuxError)) return
  if (error.code === 'CONNECTION_CREDENTIAL_FORMAT_UNSUPPORTED') return 'credential-format-unsupported'
  if (error.code === 'CONNECTION_CREDENTIAL_UNAVAILABLE' || error.code === 'CONNECTION_CREDENTIAL_UNCONFIRMED') return 'credential-unavailable'
}
