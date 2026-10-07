import type { AgentMuxContinuityOperation } from '@agentmux/core'

/** Presents a Core decision; never grants or denies recovery. */
export function agentContinuityDetail(decision?: AgentMuxContinuityOperation): string {
  if (!decision) return 'The original Session is kept. Core will check its exact Run before restoring; you can send your next request or use Resume.'
  switch (decision.reason) {
    case 'runtime-unverified': return 'The original Run is unverified. Keep this Session and check the original Host again.'
    case 'active-manual': return 'Automatic recovery of interrupted work is disabled. Use Resume or send your next request.'
    case 'active-delay': return 'Interrupted work is waiting for the configured recovery delay. You can restore it now.'
    case 'idle-window-expired': return 'The confirmed idle window has expired. Your next request or Resume restores this Session.'
    case 'idle-unknown': return 'Idle time is unknown. Your next request or Resume restores this Session.'
    case 'not-active': return 'No interrupted work or recent idle completion is confirmed. Use Resume or send your next request.'
    case 'resume-disabled': return 'Automatic resume after an ended Run is disabled. Use Resume or send your next request.'
    case 'provider-unverified': return 'The Provider recovery check is unconfirmed. The original Session is kept; check it again or restore manually.'
    case 'operation-unconfirmed': return 'The original recovery result is unconfirmed. Check the same Session again; no new start or unknown input is replayed.'
    default: return decision.error ?? 'The original Session is kept. Use Resume or send your next request.'
  }
}
