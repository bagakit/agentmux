import type { ReactNode } from 'react'
import type { MoteDialogueLink, MoteMainPeriod } from '@agentmux/core/mote-dialogue'
import { SemanticIcon } from '../theme/icons.js'
import '../styles/mote-conversation-start.css'

/** A scene over the original identity, Composer and history owners; no launch or role state lives here.
 * The backdrop is pure CSS around this Mote's portrait: no decoded artwork, no paint containment band,
 * and at most one composited layer in motion. The app brand stays a small mark beside the wordmark. */
export function MoteConversationStart({ name, portrait, brand, composer, history, notice, actions, mode = 'start', active = true, drafting = false }: {
  name: string | undefined; portrait: ReactNode; brand?: ReactNode; composer: ReactNode; history?: ReactNode
  notice?: ReactNode; actions?: ReactNode; mode?: 'start' | 'new' | 'unconfirmed'; active?: boolean
  /** True while the host's draft has text; the scene recedes without searching the composer subtree. */
  drafting?: boolean
}) {
  // A Topic whose title is still being read has no name yet; the scene keeps the Mote wordmark alone.
  const label = typeof name === 'string' ? name.trim() : ''
  return <section className="mote-start" data-mode={mode} data-active={active} data-drafting={drafting || undefined} aria-label={label ? `${label} · 开始对话` : '开始对话'}>
    <div className="mote-start__backdrop" aria-hidden="true"><span className="mote-start__aura" /><span className="mote-start__grid" /></div>
    <div className="mote-start__content">
      <header className="mote-start__identity">{brand ? <span className="mote-start__brand-art" aria-hidden="true">{brand}</span> : null}
        {label ? <span className="mote-start__name">{label}</span> : null}{label.toLowerCase() === 'mote' ? null : <span className="mote-start__wordmark">Mote</span>}{actions}</header>
      <div className="mote-start__invitation">
        <div className="mote-start__portrait"><span className="mote-start__halo" aria-hidden="true" />{portrait}</div>
        <div className="mote-start__greeting"><span className="mote-start__eyebrow">{mode === 'new' ? '同一个伙伴，新的一轮' : '你的想法，从这里开始'}</span>
          <h1>{mode === 'unconfirmed' ? '想法先写在这里。' : mode === 'new' ? '接下来，想聊点什么？' : '今天，想一起做点什么？'}</h1>
        </div>
      </div>
      <div className="mote-start__composer">{composer}</div>
      {notice && <div className="mote-start__notice">{notice}</div>}
      {history && <div className="mote-start__history">{history}</div>}
    </div>
  </section>
}

export type MoteConversationHistoryItem = {
  id: string; title: string; author?: string | undefined; period?: MoteMainPeriod | undefined
  current?: boolean; sourceIssue?: string | undefined
}
export type MoteConversationHistorySource = Extract<MoteDialogueLink, { kind: 'main' }>
export type MoteConversationHistoryRow = { item: MoteConversationHistoryItem; source: MoteConversationHistorySource }

/** One row per original Main tenure; the row at the current role revision is the live Main, not an ended period. */
export function moteConversationHistoryRows(links: readonly MoteDialogueLink[], roleRevision: string | null | undefined,
  author?: (reference: MoteConversationHistorySource['reference']) => string | undefined): MoteConversationHistoryRow[] {
  const rows = new Map<string, MoteConversationHistoryRow>()
  for (const source of links) if (source.kind === 'main') {
    const id = source.period?.id ?? JSON.stringify(['legacy-main', source.roleRevision, source.operationId])
    if (!rows.has(id)) rows.set(id, { source, item: { id, title: '主对话', author: author?.(source.reference), period: source.period,
      current: roleRevision != null && source.roleRevision === roleRevision,
      sourceIssue: source.period?.range.kind === 'unconfirmed' ? source.period.range.issue : undefined } })
  }
  return [...rows.values()]
}

function time(value: number | null | undefined, locale?: string): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) return null
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value)
}
/** Times and reasons come only from the original period; associatedAt/Session age are never substitutes. */
export function moteConversationPeriodLabel(period: MoteMainPeriod | undefined, current = false, locale?: string): string {
  const from = time(period?.startedAt, locale), through = time(period?.endedAt, locale)
  if (!from && !through) return current ? '当前承接 · 起始时间未记录' : '起止时间未记录'
  return `${from ?? '起始未记录'} — ${current ? '当前' : through ?? '结束未记录'}`
}
export function moteConversationTransitionLabel(period: MoteMainPeriod | undefined, current = false): string {
  if (current) return '当前对话'
  switch (period?.end?.kind) {
    case 'automatic': return '自动流转'
    case 'manual-takeover': return '主动接替'
    case 'selection': return '更换承接者'
    case 'clear': return '结束承接'
    default: return '流转来源未记录'
  }
}

/** Rows retain period identities, including different tenures of the same original Agent. */
export function MoteConversationHistory({ items, onOpen, onMore, reading = false, issue, locale }: {
  items: readonly MoteConversationHistoryItem[]; onOpen(item: MoteConversationHistoryItem): void
  onMore?: (() => void) | undefined; reading?: boolean; issue?: ReactNode; locale?: string
}) {
  if (!items.length && !reading && !issue) return null
  return <section className="mote-start-history" aria-label="主对话历史">
    <header><h2>之前的对话</h2>{onMore && <button type="button" onClick={onMore}>查看更早<SemanticIcon name="navigation.disclosure" size={12} /></button>}</header>
    <ol>{items.map(item => <li key={item.id} data-mote-period={item.id} data-current={item.current || undefined}>
      <button type="button" className="mote-start-history__open" onClick={() => onOpen(item)}>
        <span className="mote-start-history__mark" aria-hidden="true" />
        <span className="mote-start-history__copy"><strong>{item.title}{item.author ? <span className="mote-start-history__author"> · {item.author}</span> : null}</strong>
          <span className="mote-start-history__time">{moteConversationPeriodLabel(item.period, item.current, locale)}</span>
          {item.sourceIssue ? <small className="mote-start-history__coverage">{item.sourceIssue}</small> : null}</span>
        <span className="mote-start-history__reason" data-reason={item.current ? 'current' : item.period?.end?.kind ?? 'unknown'}>{moteConversationTransitionLabel(item.period, item.current)}</span>
        <SemanticIcon className="mote-start-history__chevron" name="navigation.disclosure" size={13} />
      </button>
    </li>)}</ol>
    {reading && <p role="status">正在读取原对话历史…</p>}{issue}
  </section>
}
