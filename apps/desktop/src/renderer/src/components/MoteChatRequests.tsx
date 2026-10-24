import { useState } from 'react'
import type { MoteChatOperation } from '@agentmux/core/mote-chat'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { sameMotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore } from '../store'
import { inspectMoteChatIntent, submitMoteChatIntent } from '../lib/mote-chat-request'
import type { MoteChatIntent } from '../lib/mote-chat-intent'
import type { ConnectionHostingTarget } from '../../../shared/contracts'

export function MoteChatRequests({ target, onConfirmed }: { target: MotePreferencesTarget; onConfirmed(operation: MoteChatOperation, hostingTarget?: ConnectionHostingTarget): void }) {
  const intents = useAppStore(state => state.moteChatIntents)
  const retained = Object.values(intents).filter(intent => sameMotePreferencesTarget(intent.input.target, target))
  const [busy, setBusy] = useState<string | null>(null), [results, setResults] = useState<Record<string, { message: string; absent: boolean }>>({})
  async function check(intent: MoteChatIntent, continueOriginal = false) {
    if (busy) return
    const id = intent.input.operationId
    setBusy(id)
    try {
      const result = continueOriginal ? await submitMoteChatIntent(intent) : await inspectMoteChatIntent(intent)
      if (result) onConfirmed(result, intent.hostingTarget)
      else setResults(current => ({ ...current, [id]: { message: 'No receipt in this reading. The original request remains unconfirmed.', absent: true } }))
    } catch (error) { setResults(current => ({ ...current, [id]: { message: presentError(error), absent: false } })) }
    finally { setBusy(null) }
  }
  if (!retained.length) return null
  return <section className="mote-chat-requests" aria-label="Original chat requests"><h4>Original requests</h4>
    {retained.map(intent => <div key={intent.input.operationId} data-mote-chat-request={intent.input.operationId}>
      <strong>{intent.method === 'space.mote.chat.configure' ? 'Chat settings' : 'Message allowance'} · result not confirmed</strong>
      <p role="status">{results[intent.input.operationId]?.message ?? (!intent.hostingTarget ? 'The original bot hosting owner is unconfirmed. The original request is kept.' : intent.phase === 'not-dispatched' ? 'Original input retained before dispatch.' : 'The original request and its input are kept.')}</p>
      <div className="mote-chat-actions"><button type="button" className="small-button" disabled={busy !== null || !intent.hostingTarget} onClick={() => void check(intent)}>{busy === intent.input.operationId ? 'Checking…' : 'Check original request'}</button>
        {intent.hostingTarget && (intent.phase === 'not-dispatched' || results[intent.input.operationId]?.absent) ? <button type="button" className="small-button" disabled={busy !== null} onClick={() => void check(intent, true)}>Continue original request</button> : null}</div>
      <details><summary>Request reference</summary>{intent.hostingTarget ? <code>{intent.hostingTarget.hostId} · {intent.hostingTarget.runtimeId}</code> : null}<code>{intent.input.operationId}</code></details>
    </div>)}
  </section>
}
