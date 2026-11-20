import type { AgentProvider } from '../agent-provider.js'

/** The original StopFailure hook can arrive even if the native transcript stopped advancing. */
export function withGrokFailureNotice(provider: AgentProvider): AgentProvider {
  return { ...provider, normalizeHook(envelope, context) {
    const event = provider.normalizeHook(envelope, context)
    if (event.eventName !== 'stop_failure' || !event.mainSubject) return event
    const payload = envelope.payload
    const nativeCode = typeof payload?.error === 'string' ? payload.error.trim().slice(0, 128) : ''
    const value = payload?.errorDetails ?? payload?.lastAssistantMessage
    const detail = typeof value === 'string' ? value.replace(/\0/gu, '').trim().slice(0, 2048) : ''
    const message = detail || (nativeCode === 'rate_limit' ? 'Grok reached a service limit for this request.'
      : 'The original Grok request failed. Its exact reason was not supplied.')
    const nativeTurnId = event.nativeTurnId
    if (!nativeTurnId) return { ...event, status: { ...event.status, detail: message } }
    const failure = { code: 'AGENT_PROVIDER_ERROR', nativeTurnId, message,
      ...(nativeCode && !nativeCode.includes('\0') ? { nativeCode } : {}),
      publicMessage: 'Grok could not finish this request.',
      recovery: 'Open the original conversation to inspect the failure and your available Executors.' }
    const previous = context?.previousHookReceipt?.nativeTurnId
    return { ...event, ...(previous && previous !== nativeTurnId ? {} : { status: { ...event.status, failure, detail: message } }),
      timeline: event.timeline.map(change => change.type === 'update' ? change : {
        ...change, item: { ...change.item, turnOutcome: { status: 'failed' as const, failure } }
      }) }
  } }
}
