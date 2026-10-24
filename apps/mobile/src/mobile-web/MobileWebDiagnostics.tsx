import { useEffect, useRef, useState } from 'react'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { MobileNotice } from '../notices/MobileNotice'
import type { MobileWebPageObservation } from './use-mobile-web-observation'

/** An on-demand view of original page/Host observations; it never reloads the document. */
export function MobileWebDiagnostics({ observation: value, copyText }: {
  observation: MobileWebPageObservation; copyText: ClientUiPlatform['copyText']
}) {
  const [expanded, expand] = useState(false), [feedback, setFeedback] = useState<{ text: string; attempt: number; reference: string } | null>(null)
  const loaded = value.loaded.result, inspection = value.inspection.result, target = inspection?.client
  useEffect(() => { if (expanded && loaded) void value.refresh() }, [expanded, loaded, value.refresh])
  const joined = loaded?.accepted && inspection?.hostInstanceId === loaded.hostInstanceId && target?.availability === 'found'
    && target.loaded?.occurrenceId === loaded.occurrenceId && target.loaded.buildId === value.page.buildId
    && target.loaded.namespaceDigest === value.page.namespaceDigest
  const current = joined && value.page.buildId !== null && value.page.namespaceDigest !== null
    && inspection?.active?.buildId === value.page.buildId && inspection.active.digest === value.page.namespaceDigest
  const summary = !value.connected ? '连接中断 · 保留当前页' : value.inspection.pending ? '正在查询原 Host'
    : value.inspection.issue ? '版本查询未确认 · 保留上次观察'
    : !inspection ? '按需查询本页与 Host 版本' : !joined ? '页面版本尚待确认'
      : current ? '本页已载入当前版本' : inspection.active ? '有版本待载入 · 当前页保留' : 'Host 版本尚未确认'
  const reference = JSON.stringify({ page: value.page, loaded,
    inspection: inspection ? { hostId: inspection.hostId, hostInstanceId: inspection.hostInstanceId,
      active: inspection.active, client: inspection.client, coverage: inspection.coverage, observedAt: inspection.observedAt } : null,
    diagnostic: value.reporter.receipt }, null, 2)
  const source = useRef(reference)
  source.current = reference
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const copy = async () => {
    const original = reference
    try {
      const copied = await copyText(original, () => {})
      if (mounted.current && source.current === original) setFeedback(previous => ({ reference: original, text: copied ? '已复制原页面与诊断查询信息。' : '复制未确认，可展开原查询信息后手动复制。', attempt: (previous?.attempt ?? 0) + 1 }))
    } catch { if (mounted.current && source.current === original) setFeedback(previous => ({ reference: original, text: '复制未确认，可展开原查询信息后手动复制。', attempt: (previous?.attempt ?? 0) + 1 })) }
  }
  const issues = [value.loaded.issue, value.inspection.issue, value.reporter.issue].filter(Boolean)
  return <section className="mobile-web-diagnostics">
    <button type="button" className="mobile-menu-row" aria-expanded={expanded} onClick={() => expand(previous => !previous)}>
      <SemanticIcon name="object.network" size={18} /><span>网页版本与诊断<small>{summary}</small></span>
      <SemanticIcon name={expanded ? 'action.collapse' : 'navigation.disclosure'} size={16} />
    </button>
    {expanded && <div className="mobile-web-diagnostics__body">
      <div className="mobile-web-diagnostics__heading"><span>{value.inspection.pending ? '查询中…' : '原版本观察'}</span>
        <button type="button" className="mobile-icon-button" aria-label="刷新页面版本查询" onClick={() => { void value.refresh() }}><SemanticIcon name="action.refresh" size={16} /></button></div>
      <dl><div><dt>本页构建</dt><dd>{value.page.buildId ?? '未确认'}</dd></div>
        <div><dt>Host 提供</dt><dd>{inspection?.active?.buildId ?? '尚未取得'}</dd></div></dl>
      <p>{current ? value.inspection.issue || !value.connected ? '上次查询核到了本页版本报送，当前结果尚待确认。' : '已在原 Host 核到本页版本报送。' : '更新保留当前页。请先保全未发送内容，再重新打开网页载入版本。'}</p>
      {inspection && <p>查询于 {new Date(inspection.observedAt).toLocaleString()}。{value.inspection.issue ? '这是上次取得的观察。' : ''}</p>}
      {target?.namespace === 'not-retained' && <MobileNotice identity={[inspection?.hostInstanceId, value.page.buildId, 'not-retained']}>本页旧资源已超出 Host 的保留范围；当前页面保留。保全未发送内容后，可重新打开网页载入当前版本。</MobileNotice>}
      {issues.length > 0 && <MobileNotice identity={[...issues]}>{issues.map((issue, index) => <p key={index}>{issue}</p>)}</MobileNotice>}
      <div className="mobile-web-diagnostics__report"><span>{value.reporter.inFlight ? '诊断报送中' : value.reporter.queuedCount ? `${value.reporter.queuedCount} 份诊断待报送` : value.reporter.receipt ? '上次诊断已接收 · 持久化待核' : '暂无已接收的诊断回执'}{value.reporter.droppedCount > 0 ? ` · ${value.reporter.droppedCount} 份未保留` : ''}</span>
        {(value.reporter.queuedCount > 0 || value.loaded.issue) && <button type="button" className="mobile-secondary" onClick={value.retryReports}>重试诊断报送</button>}</div>
      <button type="button" className="mobile-menu-row" onClick={() => { void copy() }}><SemanticIcon name="action.copy" size={16} /><span>复制原查询信息</span></button>
      {feedback?.reference === reference && <MobileNotice kind="feedback" identity={[feedback.attempt]}>{feedback.text}</MobileNotice>}
      <details><summary>查看原查询信息</summary><pre>{reference}</pre></details>
    </div>}
  </section>
}
