import { useEffect, useRef, useState } from 'react'
import { SemanticIcon } from '../theme/icons.js'
import { DeliveryLogDetails } from './DeliveryLogDetails.js'
import { messageDeliveryDiagnosticReport, presentMessageDeliveryFailure, type MessageDeliveryDiagnostic } from '../lib/message-delivery-presentation.js'

export type MessageDeliveryFailureProps = MessageDeliveryDiagnostic & {
  copyText(text: string): Promise<boolean>
  onRetry?: (() => void) | undefined
  onDismiss?: (() => void) | undefined
}

export function MessageDeliveryFailure({ copyText, onRetry, onDismiss, ...diagnostic }: MessageDeliveryFailureProps) {
  const summary = presentMessageDeliveryFailure(diagnostic)
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
  return <section className="message-delivery-failure" data-kind={summary.kind} aria-label="Message Tool 操作说明">
    <div className="message-delivery-failure__heading"><SemanticIcon name="status.warning" size={15} aria-hidden="true" />
      <strong>{summary.title}</strong>
    </div>
    <div className="message-delivery-failure__state" role="alert">{summary.state}</div>
    <p className="message-delivery-failure__next">{summary.action}</p>
    <div className="message-delivery-failure__actions">
      {onRetry && summary.kind !== 'condition-changed' ? <button type="button" onClick={onRetry}>重试此操作</button> : null}
      <button type="button" onClick={() => void copyReport()} disabled={copy === 'copying'} aria-label="复制完整诊断">
        {copy === 'copied' ? <SemanticIcon name="action.confirm" size={13} aria-hidden="true" /> : <SemanticIcon name="action.copy" size={13} aria-hidden="true" />}复制完整诊断</button>
      {onDismiss ? <button type="button" className="message-delivery-failure__dismiss" onClick={onDismiss} aria-label="关闭操作说明" title="关闭操作说明"><SemanticIcon name="action.close" size={14} /></button> : null}
      <span role="status" aria-live="polite" data-copy-state={copy}>{feedback}</span>
    </div>
    <details className="message-delivery-failure__details">
      <summary>技术详情</summary>
      {diagnostic.logId ? <DeliveryLogDetails logId={diagnostic.logId} log={diagnostic.log} copyText={copyText} /> : null}
      <pre tabIndex={0} aria-label="完整诊断原文">{report}</pre>
    </details>
  </section>
}
