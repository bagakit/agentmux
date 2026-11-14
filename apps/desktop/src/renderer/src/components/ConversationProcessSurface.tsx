import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ConversationProcessProps } from '@agentmux/client-ui/components/ConversationRecordSequence'
import { NativeProcessObservation } from '@agentmux/client-ui/components/NativeProcessObservation'
import { ObservedProcessDock, type RecordedProcessObservation } from '@agentmux/client-ui/components/WorkflowObservation'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { conversationItemRef } from '@agentmux/core/conversation'
import type { RevealConversationItem } from '../lib/mailbox-message-navigation'

// This is placement within one work surface, never a Reader or a record store.
const ProcessPlacement = createContext<{ target: HTMLDivElement | null; setTarget: (node: HTMLDivElement | null) => void } | null>(null)

export function ConversationProcessSurface({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null)
  const placement = useMemo(() => ({ target, setTarget }), [target])
  return <ProcessPlacement.Provider value={placement}>{children}</ProcessPlacement.Provider>
}

/** The existing Composer owns its position; the original process owns its summary. */
export function ConversationProcessDockSlot() {
  const placement = useContext(ProcessPlacement)
  return placement ? <div ref={placement.setTarget} data-conversation-process-dock-slot="" style={{ display: 'contents' }} /> : null
}

export function ConversationProcessObservation({ process, scope, selected, onSelect, onLocate, active }: {
  process: ConversationProcessProps
  scope: string
  selected: string | null
  onSelect: (key: string | null) => void
  onLocate: RevealConversationItem
  active: boolean
}) {
  const placement = useContext(ProcessPlacement)
  const pin = useRef<HTMLButtonElement>(null)
  const [locateNotice, setLocateNotice] = useState<string | null>(null)
  // A presentation group is only meaningful within its exact original reading source.
  const sources = [...new Set(process.records.map(record => JSON.stringify([
    record.executionHostId, record.agentSessionId, record.sourceHostId,
    record.source.kind === 'native' ? ['native', record.source.providerId, record.source.nativeSessionId] : ['captured']
  ])))]
  const key = JSON.stringify([scope, process.id])
  const pinned = selected === key
  const sourceKinds = new Set(process.records.map(record => record.source.kind))
  const sourceLabel = sourceKinds.size > 1 ? '原生与已捕获记录' : sourceKinds.has('native') ? '原生会话记录' : '已捕获记录'
  const close = () => {
    const returnFocus = placement?.target?.contains(placement.target.ownerDocument.activeElement)
    onSelect(null)
    if (returnFocus && pin.current?.isConnected) pin.current.focus({ preventScroll: true })
  }
  const reference = process.records[0] && conversationItemRef(process.records[0])
  const locate = async () => {
    if (!reference) return
    setLocateNotice(null)
    process.disclosure?.onExpandedChange(true)
    const result = await onLocate(reference)
    if (result.kind === 'unavailable') setLocateNotice(result.message)
  }
  const summary = (observation: RecordedProcessObservation) => pinned && active && observation.stepCount > 0 && placement?.target
    ? createPortal(<ObservedProcessDock title={observation.title ?? observation.label ?? '过程摘要'}
      source={<span title={sources.join('\n')}>{sourceLabel} · 仅限当前已加载范围{observation.recordedTime
        ? <span title={observation.recordedTime.offset}> · {observation.recordedTime.from}{observation.recordedTime.to !== observation.recordedTime.from ? ` – ${observation.recordedTime.to}` : ''}</span> : null}</span>}
      summary={<><span>{observation.stepCount} 条记录</span>{observation.metrics}
        {observation.status === 'failed' ? <span>记录标记为失败</span> : null}
        {observation.status === 'running' ? <span>最近记录：进行中</span> : null}
        {observation.status === 'interrupted' ? <span>记录标记为中断</span> : null}
        {locateNotice ? <span role="status">{locateNotice}</span> : null}</>}
      action={reference ? <button type="button" className="small-button" onClick={() => void locate()}>查看过程</button> : undefined}
      onClose={close} />, placement.target, key)
    : null
  return <>
    <NativeProcessObservation {...process} compact
      actions={placement && active ? <button ref={pin} type="button" className="small-button"
        aria-label={pinned ? '取消固定过程摘要' : '固定过程摘要到输入框上方'} aria-pressed={pinned}
        title={pinned ? '取消固定过程摘要' : '固定过程摘要到输入框上方'}
        onClick={() => { setLocateNotice(null); pinned ? close() : onSelect(key) }}><SemanticIcon name={pinned ? 'action.unpin' : 'action.pin'} size={12} />{pinned ? <span>已固定</span> : null}</button> : undefined}
      renderSummary={summary} />
  </>
}
