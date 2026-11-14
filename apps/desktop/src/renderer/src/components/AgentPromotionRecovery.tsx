import { useEffect, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { AgentPromotionReceipt, AgentPromotionTarget } from '@agentmux/core/agent-promotion'
import { Button } from '@agentmux/client-ui/components/Button'
import { api } from '../lib/api'

/** Accepted association operations retain their own promise; new work uses shared Takeover. */
export function AgentPromotionRecovery({ target }: { target: AgentPromotionTarget }) {
  const [receipt, setReceipt] = useState<AgentPromotionReceipt | null>(null)
  const [issue, setIssue] = useState<string | null>(null), [busy, setBusy] = useState(false)
  useEffect(() => {
    let current = true
    void api.agentPromotions.call('agent.promote.inspect', { target }).then(result => {
      if (current) { setReceipt(result.promotion); setIssue(null) }
    }, cause => { if (current) setIssue(presentError(cause)) })
    return () => { current = false }
  }, [target.hostId, target.agentSessionId])
  async function continueOriginal() {
    if (!receipt || busy) return
    setBusy(true); setIssue(null)
    const input = { target: receipt.target, source: receipt.source, operationId: receipt.operationId, title: receipt.title }
    try { const result = await api.agentPromotions.call('agent.promote.apply', input); setReceipt(result.promotion) }
    catch (cause) { setIssue(presentError(cause)) }
    finally { setBusy(false) }
  }
  if (!receipt && !issue) return null
  return <details className="session-takeover__retained" aria-label="Earlier accepted Promotion">
    <summary>{receipt?.state === 'complete' ? 'Earlier Promotion completed' : 'Earlier Promotion result'}</summary>
    {receipt ? <><p>{receipt.title} · <code>{receipt.operationId}</code></p><p>{receipt.state === 'complete' ? 'Its original result is retained. This is separate from the new Takeover.' : 'This already accepted operation keeps its original destination and input.'}</p>
      {receipt.unavailable.map((item, index) => <p key={index}>{item.message}</p>)}
      {receipt.state === 'partial' ? <Button type="button" disabled={busy} onClick={() => { void continueOriginal() }}>Continue accepted Promotion</Button> : null}</> : null}
    {issue ? <p role="status">{issue}</p> : null}
  </details>
}
