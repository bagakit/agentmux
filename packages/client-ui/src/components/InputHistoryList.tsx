import type { InputMailboxDisplayRow } from './InputMailboxRecords.js'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentSessionUserMessage } from '@agentmux/core'
import { describeConversationInputSource } from '../lib/conversation-input-source.js'
import { isImeOwnedKeyboardEvent } from '../lib/ime-keyboard-event.js'
import { semanticIconComponent } from '../theme/icons.js'
import type { useAgentInputHistory } from '../lib/use-agent-input-history.js'

const SearchIcon = semanticIconComponent('action.search')
const RefreshIcon = semanticIconComponent('action.refresh')
const FillIcon = semanticIconComponent('action.paste')

export type InputHistoryView = ReturnType<typeof useAgentInputHistory>
export type InputHistoryLocalEntry = { id: string; text: string; inputOrigin?: { hostId: string; key: import('@agentmux/core/prompt-condition').AgentPromptInputKey } }

/** Pure presentation: query and actions are injected from the original read/draft owners. */
export function InputHistoryList({ history, localEntries = [], onRead, onFill, onCopy, onFillLocal, beforeRecords, renderRecords, additionalRecords = [], onRefresh, refreshing, coverage, relatedMessages, relatedContent, onReadingChange }: {
  history: InputHistoryView; localEntries?: readonly InputHistoryLocalEntry[]
  additionalRecords?: readonly InputMailboxDisplayRow[]
  /** Core-confirmed contributions to a primary input, preserving each original action target. */
  relatedMessages?: ReadonlyMap<string, readonly AgentSessionUserMessage[]>
  relatedContent?: ReadonlyMap<string, ReactNode>
  onReadingChange?(message: AgentSessionUserMessage | null): void
  beforeRecords?: ReactNode
  onRefresh?(): void
  refreshing?: boolean
  /** Combined source coverage belongs to the containing reader. */
  coverage?: ReactNode
  renderRecords?(messages: readonly AgentSessionUserMessage[]): ReactNode
  onRead?(message: AgentSessionUserMessage): ReactNode
  onFill?(message: AgentSessionUserMessage): Promise<string | void>
  onCopy(message: AgentSessionUserMessage): Promise<boolean>
  onFillLocal?(entry: InputHistoryLocalEntry): void | Promise<void>
}) {
  const [action, setAction] = useState<{ id: string; pending: boolean; message: string } | null>(null)
  const [readingId, setReadingId] = useState<string | null>(null)
  const generation = useRef(0)
  useEffect(() => { ++generation.current; setAction(null); setReadingId(null); onReadingChange?.(null); return () => { ++generation.current } }, [history.scope])
  const perform = async (message: AgentSessionUserMessage, copy: boolean) => {
    if (action?.pending) return
    const original = generation.current
    setAction({ id: message.id, pending: true, message: copy ? '读取完整正文…' : '准备正文…' })
    try {
      if (copy) {
        const copied = await onCopy(message)
        if (original !== generation.current) return
        setAction({ id: message.id, pending: false, message: copied ? '已复制正文' : '复制未完成，原记录保留' })
      } else {
        const notice = await onFill?.(message)
        if (original !== generation.current) return
        setAction({ id: message.id, pending: false, message: notice ?? '已填入草稿，尚未发送' })
      }
    } catch (error) { if (original === generation.current) setAction({ id: message.id, pending: false, message: error instanceof Error ? error.message : String(error) }) }
  }
  const local = localEntries.filter(entry => !history.query || entry.text.includes(history.query))
  const fillLocal = async (entry: InputHistoryLocalEntry) => {
    const original = generation.current
    setAction({ id: entry.id, pending: true, message: '' })
    try {
      await onFillLocal?.(entry)
      if (original === generation.current) setAction({ id: entry.id, pending: false, message: '已填入草稿，尚未发送' })
    } catch (error) { if (original === generation.current) setAction({ id: entry.id, pending: false, message: error instanceof Error ? error.message : String(error) }) }
  }
  const records: Array<{ key: string; time: number | undefined } & ({ message: AgentSessionUserMessage } | { message: null; node: ReactNode })> = [
    ...history.messages.map(message => ({ key: `history:${message.id}`, time: message.recordedAt, message })),
    ...additionalRecords.map(row => ({ ...row, message: null }))
  ].sort((a,b) => a.time === undefined ? b.time === undefined ? 0 : 1 : b.time === undefined ? -1 : b.time-a.time)
  return <div className="input-history" data-custom-records={renderRecords ? true : undefined}>
    <form className="input-history__search" onSubmit={event => { event.preventDefault(); history.search() }}>
      <input type="search" aria-label="查询当前 Agent 输入历史" placeholder="查询输入历史" value={history.draftQuery}
        onChange={event => history.setDraftQuery(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && isImeOwnedKeyboardEvent(event)) event.preventDefault()
        }} />
      <button type="submit" className={renderRecords ? 'composer-tool' : undefined} aria-label="查询当前 Agent 输入历史" title="查询当前 Agent 输入历史">{renderRecords ? <SearchIcon size={14} /> : '查询'}</button>
      {onRefresh ? <button type="button" className={renderRecords ? 'composer-tool' : undefined} aria-label="Refresh inputs" title="Refresh inputs" disabled={refreshing} onClick={onRefresh}><RefreshIcon size={14} /></button> : null}
    </form>
    <div className="input-history__coverage" role="status">{coverage ?? <>{history.loading ? '正在读取… ' : ''}
      {history.complete ? '已查完可用记录（本次读取）' : '当前为已读取范围'}{history.examined ? ` · 已检查 ${history.examined} 条` : ''}</>}</div>
    {beforeRecords}
    {renderRecords ? renderRecords(history.messages) : records.length ? <ol className="input-history__records" aria-label="当前 Agent 输入历史">
      {records.map(record => {
        if (!record.message) return <Fragment key={record.key}>{record.node}</Fragment>
        const message = record.message
        return <li key={record.key} data-input-history-id={message.id}>
        <p className="input-history__excerpt">{message.content.slice(0, 320) || '包含资源的输入记录'}</p>
        <div className="input-history__meta"><span title={describeConversationInputSource(message.source).title}>{describeConversationInputSource(message.source).caption}</span>
          {message.recordedAt !== undefined && Number.isFinite(message.recordedAt) && Math.abs(message.recordedAt) <= 8.64e15 ? <time dateTime={new Date(message.recordedAt).toISOString()}>{new Date(message.recordedAt).toLocaleString()}</time> : <span>时间未记录</span>}</div>
        {onRead ? <details open={readingId === message.id} onToggle={event => {
          if (event.currentTarget.open) { setReadingId(message.id); onReadingChange?.(message) }
          else if (readingId === message.id) { setReadingId(null); onReadingChange?.(null) }
        }}><summary>查看原文</summary>{readingId === message.id ? <>{onRead(message)}
          <InputHistoryOriginalRecords messages={(relatedMessages?.get(message.id) ?? []).filter(original => original !== message)}
            onRead={onRead} onCopy={onCopy} {...(onFill ? { onFill } : {})} />
          {relatedContent?.get(message.id)}
        </> : null}</details> : null}
        <div className="input-history__actions"><button type="button" disabled={action?.pending} onClick={() => void perform(message, true)}>复制正文</button>
          {onFill ? <button type="button" disabled={action?.pending} onClick={() => void perform(message, false)}>填入草稿</button> : null}</div>
        {action?.id === message.id ? <p className="input-history__notice" role="status">{action.message}</p> : null}
      </li>})}
    </ol> : <p className="input-history__empty">{history.loading ? '正在查找记录…' : history.complete ? '可用记录中没有匹配项' : '已读取范围内没有匹配项，可继续查找更早记录'}</p>}
    <div className="input-history__sources">{history.pages.map(page => <div key={page.source}>
      {page.error ? <p role="status">{page.source === 'native' ? '原生记录' : '发送记录'}：{page.error}</p> : null}
      {page.cursor || page.error ? <button type="button" disabled={page.loading} onClick={() => history.loadMore(page.source)}>
        {page.error ? '重试读取' : `继续查找${page.source === 'native' ? '原生' : '发送'}记录`}</button> : null}
    </div>)}</div>
    {local.length ? <details className="input-history__local"><summary>编辑回忆 · {local.length}</summary><p>仅保存了输入正文，不代表已经发送；时间和入口未记录。</p>
      {local.map(entry => <div key={entry.id}><p>{entry.text.slice(0, 320)}</p>{onFillLocal ? <button type="button" disabled={action?.pending} aria-label="填入草稿" title="插入草稿，不发送" onClick={() => void fillLocal(entry)}>{renderRecords ? <FillIcon size={14} /> : '填入草稿'}</button> : null}
        {action?.id === entry.id ? <p role="status">{action.message}</p> : null}</div>)}</details> : null}
  </div>
}

/** Disclosure only. Every body/resource and action still belongs to its original record. */
export function InputHistoryOriginalRecords({ messages, ...actions }: {
  messages: readonly AgentSessionUserMessage[]; onRead(message: AgentSessionUserMessage): ReactNode
  onCopy(message: AgentSessionUserMessage): Promise<boolean>
  onFill?(message: AgentSessionUserMessage): Promise<string | void>
}) {
  const [reading, setReading] = useState<{ messages: ReadonlyMap<string, AgentSessionUserMessage>; order: readonly string[] }>(
    () => ({ messages: new Map(), order: [] }))
  const originals = new Map(messages.map(message => [message.id, message]))
  // This is the open reading selection, not a second history window. New versions
  // and withdrawn relations apply after the reader releases the original body.
  for (const [id, message] of reading.messages) originals.set(id, message)
  // Moving a retained DOM node can empty a browser Range. Keep every open row
  // in its displayed order; opening a new row captures its current position too.
  const retained = new Set(reading.order)
  const order = [...reading.order.filter(id => originals.has(id)), ...[...originals.keys()].filter(id => !retained.has(id))]
  return <>{order.map(id => {
    const message = originals.get(id)!
    return <OriginalHistoryContribution key={message.id} message={message}
    open={reading.messages.has(message.id)} onOpenChange={open => setReading(current => {
      if (current.messages.has(message.id) === open) return current
      const next = new Map(current.messages)
      if (open) next.set(message.id, message)
      else next.delete(message.id)
      return { messages: next, order: next.size ? order : [] }
    })} {...actions} />})}</>
}

function OriginalHistoryContribution({ message, open, onOpenChange, onRead, onFill, onCopy }: {
  message: AgentSessionUserMessage; onRead(message: AgentSessionUserMessage): ReactNode
  open: boolean; onOpenChange(open: boolean): void
  onCopy(message: AgentSessionUserMessage): Promise<boolean>
  onFill?(message: AgentSessionUserMessage): Promise<string | void>
}) {
  const [action, setAction] = useState<{ pending: boolean; message: string } | null>(null)
  const generation = useRef(0)
  useEffect(() => { ++generation.current; setAction(null); return () => { ++generation.current } }, [open])
  async function perform(copy: boolean) {
    if (action?.pending) return
    const current = ++generation.current
    setAction({ pending: true, message: copy ? '读取完整正文…' : '准备正文…' })
    try {
      const result = copy ? await onCopy(message) : await onFill?.(message)
      if (generation.current === current) setAction({ pending: false, message: copy
        ? result ? '已复制正文' : '复制未完成，原记录保留' : typeof result === 'string' ? result : '已填入草稿，尚未发送' })
    } catch (error) {
      if (generation.current === current) setAction({ pending: false, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return <details className="input-history__original" open={open} onToggle={event => onOpenChange(event.currentTarget.open)}>
    <summary>{describeConversationInputSource(message.source).caption} · 原记录</summary>
    {open ? <>{onRead(message)}<div className="input-history__actions">
      <button type="button" disabled={action?.pending} onClick={() => void perform(true)}>复制正文</button>
      {onFill ? <button type="button" disabled={action?.pending} onClick={() => void perform(false)}>填入草稿</button> : null}
    </div>{action ? <p role="status">{action.message}</p> : null}</> : null}
  </details>
}
