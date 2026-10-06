import { useEffect, useRef, useState } from 'react'
import { SemanticIcon } from '../theme/icons.js'
import { DeliveryLogDetails } from './DeliveryLogDetails.js'
import { messageDeliveryDiagnosticReport, presentMessageDeliveryFailure, type MessageDeliveryDiagnostic } from '../lib/message-delivery-presentation.js'

export type MessageDeliveryFailureProps = MessageDeliveryDiagnostic & {
  copyText(text: string): Promise<boolean>
  onRetry?: (() => void) | undefined
  onDismiss?: (() => void) | undefined
  /** Host-selected density; facts, eligibility and the complete report are unchanged. */
  compact?: boolean
}

export function MessageDeliveryFailure({ copyText, onRetry, onDismiss, compact = false, ...diagnostic }: MessageDeliveryFailureProps) {
  const summary = presentMessageDeliveryFailure(diagnostic)
  const informational = summary.kind === 'saved-waiting' || summary.kind === 'stopped' || summary.kind === 'admitted'
  const compactCause = 'compactCause' in summary ? summary.compactCause : undefined
  const report = messageDeliveryDiagnosticReport(diagnostic)
  const [copy, setCopy] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const generation = useRef(0)
  const currentReport = useRef(report)
  if (currentReport.current !== report) { currentReport.current = report; ++generation.current }
  useEffect(() => { setCopy('idle') }, [report])
  useEffect(() => () => { ++generation.current }, [])
  async function copyReport() {
    const attempt = ++generation.current
    setCopy('copying')
    let copied = false
    try { copied = await copyText(report) === true } catch { /* The result remains visibly unconfirmed. */ }
    if (generation.current === attempt) setCopy(copied ? 'copied' : 'failed')
  }
  const feedback = copy === 'copied' ? '完整诊断已复制' : copy === 'failed' ? '复制失败，请重试或在详情中选取原文。' : copy === 'copying' ? '正在复制…' : ''
  return <section className="message-delivery-failure" data-compact={compact || undefined} data-kind={summary.kind} aria-label="Message Tool 操作说明">
    <div className="message-delivery-failure__heading" role={compact ? informational ? 'status' : 'alert' : undefined} title={compact ? summary.state : undefined}><SemanticIcon name={informational ? 'status.info' : 'status.warning'} size={15} aria-hidden="true" />
      <strong>{summary.title}{compact && compactCause ? ` · ${compactCause}` : ''}</strong>
    </div>
    {!compact ? <><div className="message-delivery-failure__state" role={informational ? 'status' : 'alert'}>{summary.state}</div>
      <p className="message-delivery-failure__next">{summary.action}</p></> : null}
    <div className="message-delivery-failure__actions">
      {onRetry && !['condition-changed', 'admitted', 'not-applied'].includes(summary.kind) ? <button type="button" onClick={onRetry}>{summary.kind === 'saved-waiting' || summary.kind === 'stopped' ? '继续确认' : compact ? '重试' : '重试此操作'}</button> : null}
      <button type="button" className="message-delivery-failure__copy" onClick={() => void copyReport()} disabled={copy === 'copying'} aria-label="复制完整诊断">
        {copy === 'copied' ? <SemanticIcon name="action.confirm" size={13} aria-hidden="true" /> : <SemanticIcon name="action.copy" size={13} aria-hidden="true" />}{compact ? copy === 'copied' ? '已复制' : copy === 'failed' ? '复制失败' : copy === 'copying' ? '复制中' : '复制诊断' : '复制完整诊断'}</button>
      {onDismiss ? <button type="button" className="message-delivery-failure__dismiss" onClick={onDismiss} aria-label="关闭操作说明" title="关闭操作说明"><SemanticIcon name="action.close" size={14} /></button> : null}
      <span role="status" aria-live="polite" data-copy-state={copy}>{feedback}</span>
    </div>
    <details className="message-delivery-failure__details">
      <summary>{compact ? '详情' : '技术详情'}</summary>
      {compact ? <><p className="message-delivery-failure__state">{summary.state}</p><p className="message-delivery-failure__next">{summary.action}</p></> : null}
      {diagnostic.logId ? <DeliveryLogDetails logId={diagnostic.logId} log={diagnostic.log} copyText={copyText} /> : null}
      <pre tabIndex={0} aria-label="完整诊断原文">{report}</pre>
    </details>
  </section>
}
