import { useEffect, useRef, useState } from 'react'
import { formatAmuxObjectLink } from '@agentmux/core/sharing'
import { mintObjectId } from '@agentmux/core/object-id'
import { parseCapsuleRpcResult, type CapsuleOpenResult } from '@agentmux/core/capsule'
import type { ToolkitCapsuleReference, ToolkitExecution } from '@agentmux/core/control'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { deliveryFailure } from '@agentmux/core/delivery-attempt'
import { api } from '../../lib/api'

type Source = { toolId: string; execution: ToolkitExecution }
type Attempt = { capsuleId: string; label: string; source: Source; operationId: string
  phase: 'pending' | 'unknown' | 'committed' | 'failed'; message: string }

/** References are inert; only explicit actions call the original Capsule owner. */
export function ToolkitCapsuleResults({ references, source }: { references: readonly ToolkitCapsuleReference[]; source: Source | null }) {
  const [attempts, setAttempts] = useState<Record<string, Attempt>>({})
  const [copies, setCopies] = useState<Record<string, string>>({})
  const busy = useRef(new Set<string>()), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const put = (attempt: Attempt) => { if (mounted.current) setAttempts(current => ({ ...current, [attempt.capsuleId]: attempt })) }
  function confirmed(attempt: Attempt, result: CapsuleOpenResult) {
    put({ ...attempt, phase: 'committed', message: result.rendering.status === 'available'
      ? 'Opened in the original Browser workface.' : result.rendering.reason })
  }
  async function open(page: ToolkitCapsuleReference, origin: Source) {
    const phase = attempts[page.capsuleId]?.phase
    if (busy.current.has(page.capsuleId) || phase === 'pending' || phase === 'unknown') return
    const attempt: Attempt = { ...page, source: origin, operationId: mintObjectId(), phase: 'pending', message: '' }
    busy.current.add(page.capsuleId); put(attempt)
    try { confirmed(attempt, await api.capsules.call('capsule.open', { capsuleId: page.capsuleId, operationId: attempt.operationId })) }
    catch (error) {
      const failure = deliveryFailure(error).controlFailure
      const notApplied = failure?.disposition === 'not_applied' && failure.confirmedInputBytes === 0
      put({ ...attempt, phase: notApplied ? 'failed' : 'unknown', message: notApplied
        ? `The original open was not applied. You can open the page again. ${presentError(error)}` : presentError(error) })
    }
    finally { busy.current.delete(page.capsuleId) }
  }
  async function inspect(original: Attempt) {
    if (busy.current.has(original.capsuleId) || original.phase !== 'unknown') return
    busy.current.add(original.capsuleId); put({ ...original, phase: 'pending' })
    try {
      const { operation } = await api.capsules.call('capsule.operation.inspect', { operationId: original.operationId })
      if (operation?.status === 'committed') confirmed(original, parseCapsuleRpcResult('capsule.open', operation.result, { capsuleId: original.capsuleId, operationId: original.operationId }))
      else put({ ...original, phase: operation?.status === 'failed' ? 'failed' : 'unknown', message: operation?.status === 'failed'
        ? operation.issue?.message ?? 'The original open failed. Review the page before opening again.'
        : 'The original open is still unconfirmed. Checking does not open another page.' })
    } catch (error) { put({ ...original, phase: 'unknown', message: presentError(error) }) }
    finally { busy.current.delete(original.capsuleId) }
  }
  const pages = source ? references.map(page => ({ ...page, source })) : []
  // A new tool result cannot discard an uncertain open of its earlier page.
  for (const attempt of Object.values(attempts)) if ((attempt.phase === 'pending' || attempt.phase === 'unknown') && !pages.some(page => page.capsuleId === attempt.capsuleId)) pages.push(attempt)
  if (!pages.length) return null
  return <section className="toolkit-capsules" aria-label="Capsule page results">
    {pages.map(page => {
      const attempt = attempts[page.capsuleId], locked = attempt?.phase === 'pending' || attempt?.phase === 'unknown'
      const execution = page.source.execution
      return <div className="toolkit-capsules__row" key={page.capsuleId} data-toolkit-capsule={page.capsuleId}>
        <div className="toolkit-capsules__main"><span><strong>{page.label || 'Capsule page'}</strong><small>Persistent page · availability checked when opened</small></span>
          <button type="button" className="small-button" disabled={locked} onClick={() => void open(page, page.source)}>{attempt?.phase === 'pending' ? 'Opening…' : 'Open page'}</button>
          <button type="button" className="small-button" onClick={() => { void api.ui.writeClipboardText(formatAmuxObjectLink({ kind: 'capsule', capsuleId: page.capsuleId })).then(() => { if (mounted.current) setCopies(current => ({ ...current, [page.capsuleId]: 'Capsule link copied.' })) }, error => { if (mounted.current) setCopies(current => ({ ...current, [page.capsuleId]: presentError(error) })) }) }}>Copy Capsule link</button>
        </div>
        {copies[page.capsuleId] ? <p role="status">{copies[page.capsuleId]}</p> : null}
        {attempt ? <div className="toolkit-capsules__receipt" role={attempt.phase === 'unknown' || attempt.phase === 'failed' ? 'alert' : 'status'}>
          <span>{attempt.phase === 'pending' ? 'Waiting for the original open…' : attempt.message}</span>
          {attempt.phase === 'unknown' ? <button type="button" className="small-button" onClick={() => void inspect(attempt)}>Check original open</button> : null}
          {attempt.phase === 'unknown' || attempt.phase === 'failed' ? <small>Operation <code>{attempt.operationId}</code> · execution <code>{attempt.source.execution.executionId}</code></small> : null}
        </div> : null}
        <details className="toolkit-result__details"><summary>Page and result source</summary><dl>
          <dt>Capsule</dt><dd><code>{page.capsuleId}</code></dd><dt>Tool</dt><dd>{execution.definition.name} · <code>{page.source.toolId}</code></dd>
          <dt>Execution</dt><dd><code>{execution.executionId}</code></dd><dt>Configuration</dt><dd>{execution.definition.revision}</dd>
          <dt>Result time</dt><dd><time dateTime={new Date('endedAt' in execution ? Number(execution.endedAt) : execution.startedAt).toISOString()}>{new Date('endedAt' in execution ? Number(execution.endedAt) : execution.startedAt).toLocaleString()}</time></dd>
        </dl></details>
      </div>
    })}
  </section>
}
