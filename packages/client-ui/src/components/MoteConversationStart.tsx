import type { ReactNode } from 'react'
import type { MoteMainPeriod } from '@agentmux/core/mote-dialogue'
import { SemanticIcon } from '../theme/icons.js'
import '../styles/mote-conversation-start.css'

/** A scene over the original identity, Composer and history owners; no launch or role state lives here. */
export function MoteConversationStart({ name, portrait, brand, composer, history, notice, actions, mode = 'start', active = true }: {
  name: string; portrait: ReactNode; brand?: ReactNode; composer: ReactNode; history?: ReactNode
  notice?: ReactNode; actions?: ReactNode; mode?: 'start' | 'new' | 'unconfirmed'; active?: boolean
}) {
  return <section className="mote-start" data-mode={mode} data-active={active} aria-label={`${name} · 开始对话`}>
    <div className="mote-start__background" aria-hidden="true">
      <div className="mote-start__brand-art">{brand}</div>
      <svg className="mote-start__contour" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid slice">
        <path d="M-120 560C80 120 280 200 445 390S750 740 1120 130" />
        <path d="M-90 610C145 155 310 260 470 430S820 720 1090 185" />
      </svg>
    </div>
    <div className="mote-start__content">
      <header className="mote-start__identity"><span className="mote-start__name">{name}</span><span className="mote-start__wordmark">Mote</span>{actions}</header>
      <div className="mote-start__invitation">
        <div className="mote-start__portrait">{portrait}</div>
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
        <span className="mote-start-history__mark"><SemanticIcon name="object.conversation" size={17} /></span>
        <span className="mote-start-history__copy"><strong>{item.title}</strong><span>{moteConversationPeriodLabel(item.period, item.current, locale)}</span>
          {item.author && <small>{item.author}</small>}{(item.sourceIssue || !item.period || item.period.range.kind !== 'bounded') && <small className="mote-start-history__coverage">{item.sourceIssue ?? '原来源范围未完整记录'}</small>}</span>
        <span className="mote-start-history__reason">{moteConversationTransitionLabel(item.period, item.current)}</span><SemanticIcon name="navigation.disclosure" size={13} />
      </button>
    </li>)}</ol>
    {reading && <p role="status">正在读取原对话历史…</p>}{issue}
  </section>
}
