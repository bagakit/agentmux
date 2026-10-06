import { useEffect, useRef, useState } from 'react'
import { SemanticIcon } from '../theme/icons.js'
import { DeliveryLogDetails } from './DeliveryLogDetails.js'
import { messageDeliveryDiagnosticExport, messageDeliveryDiagnosticReport, presentMessageDeliveryFailure, type MessageDeliveryDiagnostic } from '../lib/message-delivery-presentation.js'

export type MessageDeliveryFailureProps = MessageDeliveryDiagnostic & {
  copyText(text: string): Promise<boolean>
  onRetry?: (() => void) | undefined
  onDismiss?: (() => void) | undefined
  /** Host-selected density; facts, eligibility and the complete report are unchanged. */
  compact?: boolean
}

export function MessageDeliveryFailure({ copyText, onRetry, onDismiss, compact = false, ...diagnostic }: MessageDeliveryFailureProps) {
  const summary = presentMessageDeliveryFailure(diagnostic)
  const informational = summary.kind === 'saved-waiting' || summary.kind === 'stopped' || summary.kind === 'admitted' || summary.kind === 'terminal-confirmed'
  const compactCause = 'compactCause' in summary ? summary.compactCause : undefined
  const report = messageDeliveryDiagnosticReport(diagnostic)
  const fullReport = messageDeliveryDiagnosticExport(diagnostic)
  const [copy, setCopy] = useState<{ kind: 'summary' | 'full'; state: 'idle' | 'copying' | 'copied' | 'failed' }>({ kind: 'summary', state: 'idle' })
  const generation = useRef(0)
  const currentReport = useRef(fullReport)
  if (currentReport.current !== fullReport) { currentReport.current = fullReport; ++generation.current }
  useEffect(() => { setCopy({ kind: 'summary', state: 'idle' }) }, [fullReport])
  useEffect(() => () => { ++generation.current }, [])
  async function copyReport(kind: 'summary' | 'full') {
    const attempt = ++generation.current
    setCopy({ kind, state: 'copying' })
    let copied = false
    try { copied = await copyText(kind === 'summary' ? report : fullReport) === true } catch { /* Visible failure; no Input replay. */ }
    if (generation.current === attempt) setCopy({ kind, state: copied ? 'copied' : 'failed' })
  }
  const copyLabel = (kind: 'summary' | 'full') => copy.kind === kind && copy.state !== 'idle'
    ? copy.state === 'copied' ? '已复制' : copy.state === 'failed' ? '复制失败' : '复制中' : kind === 'summary' ? '复制诊断' : '复制完整资料'
  const feedback = copy.state === 'copied' ? `${copy.kind === 'summary' ? '诊断摘要' : '完整资料'}已复制`
    : copy.state === 'failed' ? '复制失败，请重试或在详情中选取原文。' : copy.state === 'copying' ? '正在复制…' : ''
  return <section className="message-delivery-failure" data-compact={compact || undefined} data-kind={summary.kind} aria-label="Message Tool 操作说明">
    <div className="message-delivery-failure__heading" role={compact ? informational ? 'status' : 'alert' : undefined} title={compact ? summary.state : undefined}><SemanticIcon name={informational ? 'status.info' : 'status.warning'} size={15} aria-hidden="true" />
      <strong>{summary.title}{compact && compactCause ? ` · ${compactCause}` : ''}</strong>
    </div>
    {!compact ? <><div className="message-delivery-failure__state" role={informational ? 'status' : 'alert'}>{summary.state}</div>
      <p className="message-delivery-failure__next">{summary.action}</p></> : null}
    <div className="message-delivery-failure__actions">
      {onRetry && !['condition-changed', 'terminal-confirmed', 'admitted', 'not-applied'].includes(summary.kind) ? <button type="button" onClick={onRetry}>{summary.kind === 'saved-waiting' || summary.kind === 'stopped' ? '继续确认' : compact ? '重试' : '重试此操作'}</button> : null}
      <button type="button" className="message-delivery-failure__copy" onClick={() => void copyReport('summary')} disabled={copy.kind === 'summary' && copy.state === 'copying'} aria-label="复制诊断摘要">
        <SemanticIcon name={copy.kind === 'summary' && copy.state === 'copied' ? 'action.confirm' : 'action.copy'} size={13} aria-hidden="true" />{copyLabel('summary')}</button>
      {onDismiss ? <button type="button" className="message-delivery-failure__dismiss" onClick={onDismiss} aria-label="关闭操作说明" title="关闭操作说明"><SemanticIcon name="action.close" size={14} /></button> : null}
      <span role="status" aria-live="polite" data-copy-state={copy.state} data-copy-kind={copy.kind}>{feedback}</span>
    </div>
    <details className="message-delivery-failure__details">
      <summary>{compact ? '详情' : '技术详情'}</summary>
      {compact ? <><p className="message-delivery-failure__state">{summary.state}</p><p className="message-delivery-failure__next">{summary.action}</p></> : null}
      {diagnostic.logId ? <DeliveryLogDetails logId={diagnostic.logId} log={diagnostic.log} copyText={copyText} /> : null}
      <pre tabIndex={0} aria-label="诊断摘要">{report}</pre>
      <details className="message-delivery-failure__original">
        <summary>完整技术资料</summary>
        <button type="button" onClick={() => void copyReport('full')} disabled={copy.kind === 'full' && copy.state === 'copying'} aria-label="复制完整资料"><SemanticIcon name="action.copy" size={13} aria-hidden="true" />{copyLabel('full')}</button>
        <span role="status" aria-live="polite" data-full-copy-state={copy.kind === 'full' ? copy.state : 'idle'}>{copy.kind === 'full' ? feedback : ''}</span>
        <pre tabIndex={0} aria-label="完整诊断原文">{fullReport}</pre>
      </details>
    </details>
  </section>
}
