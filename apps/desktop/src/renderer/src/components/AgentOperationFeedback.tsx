import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { SemanticIcon, semanticIconComponent } from '@agentmux/client-ui/icons'
import { useVisibleWork } from '@agentmux/client-ui/use-visible-work'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { useAppStore } from '../store'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { agentOperationKey, dismissAgentOperation, inspectAgentOperation, type AgentOperationFeedback as Operation, type AgentOperationSubject } from '../lib/agent-operation-feedback'
import { stopSessionInBackground } from '../lib/session-stop-background'
import { agentOperationsForSubject } from '../lib/agent-operation'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import type { FocusListActivity } from '../lib/focus-list-activity'

const CheckIcon = semanticIconComponent('action.refresh')
const StopIcon = semanticIconComponent('action.stop')
const CloseIcon = semanticIconComponent('action.close')
const titles = { stop: '停止', takeover: '接手', fork: 'Fork' }
const activityLabels = { sent: '观察到发送', received: '观察到接收', self: '观察到自发自收', updated: '派发记录更新' }

export const FocusCommunicationFeedback = memo(function FocusCommunicationFeedback({ activity }: { activity: FocusListActivity }) {
  const active = useWorkbenchPresentationActive()
  const { ref, visible } = useVisibleWork<HTMLDivElement>(active)
  const delay = useMemo(() => Math.min(0, activity.pulse.startedAt - Date.now()), [activity.pulse, visible])
  return <div ref={ref} className="focus-communication-feedback" role="status" data-activity-id={activity.pulse.id}
    data-kind={activity.pulse.kind} data-direction={activity.direction} data-motion-active={visible}
    style={{ '--activity-delay': `${delay}ms` } as CSSProperties}>
    <span key={activity.pulse.id} className="focus-communication-feedback__mark" aria-hidden="true">
      <SemanticIcon name={activity.direction === 'updated' ? 'action.refresh' : activity.direction === 'received' ? 'navigation.back' : 'action.send'} size={12} />
    </span><span>{activityLabels[activity.direction]}</span>
  </div>
})
// One original result can be read in a card and Header at once. Decoration in
// either projection must not remove the other projection's open reading surface.
const readers = new Map<string, Set<object>>()
function setReading(key: string, reader: object, open: boolean) {
  const held = readers.get(key) ?? new Set<object>()
  if (open) { held.add(reader); readers.set(key, held) }
  else { held.delete(reader); if (!held.size) readers.delete(key) }
}
function dismissDecoration(operation: Operation) {
  if (operation.phase === 'succeeded' && !readers.has(agentOperationKey(operation))) dismissAgentOperation(operation)
}
function label(operation: Operation) {
  if (operation.phase === 'pending') return `${titles[operation.kind]}中`
  if (operation.phase === 'succeeded') return operation.kind === 'stop' ? '已停止' : '已创建'
  if (operation.phase === 'partial') return `${titles[operation.kind]}部分完成`
  if (operation.phase === 'retired') return `${titles[operation.kind]}目标已关闭`
  return `${titles[operation.kind]}${operation.phase === 'failed' ? '失败' : '未确认'}`
}

/** Both the real card and Region header read these exact original references. */
export function AgentOperationFeedback({ subject, compact = false }: { subject: AgentOperationSubject; compact?: boolean }) {
  const operations = useAppStore(useShallow(state => agentOperationsForSubject(state.agentOperations, subject)))
  const active = useWorkbenchPresentationActive()
  if (!operations.length) return null
  return <AgentOperationFeedbackBody operations={operations} compact={compact} active={active} />
}

function AgentOperationFeedbackBody({ operations, compact, active }: { operations: Operation[]; compact: boolean; active: boolean }) {
  const { ref, visible } = useVisibleWork<HTMLDivElement>(active)
  const decoration = useMemo(() => operations.find(operation => operation.phase === 'pending' && operation.kind === 'stop') ??
    operations.find(operation => operation.phase === 'pending') ?? operations.at(-1)!, [operations])
  const phase = (decoration.startedAt % 3200) / -1000
  return <div ref={ref} className={`agent-operation-feedback${compact ? ' agent-operation-feedback--compact' : ''}`}
    data-kind={decoration.kind} data-phase={decoration.phase} data-motion-active={visible && decoration.phase === 'pending'}
    style={{ '--operation-phase': `${phase}s` } as CSSProperties} onClick={event => event.stopPropagation()}>
    {operations.map(operation => <OperationFeedbackItem key={agentOperationKey(operation)} operation={operation} compact={compact} active={active} visible={visible} />)}
  </div>
}

function OperationFeedbackItem({ operation, compact, active, visible }: { operation: Operation; compact: boolean; active: boolean; visible: boolean }) {
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const reader = useRef({}), latest = useRef(operation)
  const trigger = useRef<HTMLElement>(null), content = useRef<HTMLDivElement>(null)
  const panelId = useId()
  latest.current = operation
  const key = agentOperationKey(operation)
  function changeOpen(next: boolean) {
    if (!next && !compact && content.current?.contains(content.current.ownerDocument.activeElement)) trigger.current?.focus({ preventScroll: true })
    setReading(key, reader.current, next)
    setOpen(next)
    if (!next) dismissDecoration(operation)
  }
  useEffect(() => () => { setReading(key, reader.current, false); dismissDecoration(latest.current) }, [key])
  // Offscreen completion needs no decorative wait; open readers and unresolved references remain.
  useEffect(() => { if (!visible) dismissDecoration(operation) }, [operation, visible])
  const status = <><SemanticIcon name={operation.phase === 'pending' ? 'status.loading' : operation.phase === 'succeeded' ? 'action.confirm' : operation.phase === 'failed' ? 'status.failed' : 'status.unknown'}
    size={12} {...(visible && operation.phase === 'pending' ? { animation: 'spin' as const } : {})} aria-hidden="true" /><span role="status" data-text={label(operation)}>{label(operation)}</span></>
  const onAnimationEnd = (event: { animationName: string }) => {
    if (event.animationName === 'agent-operation-settle') dismissDecoration(operation)
  }
  const detail = <div ref={content} id={panelId} className="agent-operation-feedback__detail" inert={!open} aria-hidden={!open}>
    {operation.message ? <p>{operation.message}</p> : null}
    <p><code>{operation.operationId}</code></p>
    {operation.kind === 'stop' ? <p>原 Run：{operation.control.run.runId}</p> : null}
    {operation.callerOperationIds?.length ? <p>原请求：{operation.callerOperationIds.join(' · ')}</p> : null}
    {operation.report?.agent ? <p>Agent {operation.report.agent.agentSessionId}</p> : null}
    <div className="agent-operation-feedback__actions">
      <button type="button" disabled={checking} onClick={() => {
        setChecking(true)
        void inspectAgentOperation(operation).finally(() => setChecking(false))
      }}><CheckIcon size={12} />核对原操作</button>
      {operation.kind === 'stop' && operation.canContinue && operation.phase !== 'succeeded' ? <button type="button" onClick={() => {
        void stopSessionInBackground({ control: operation.control, operationId: operation.operationId }, { continueOriginal: true })
      }}><StopIcon size={12} />继续同次停止</button> : null}
      {operation.kind === 'takeover' && operation.takeoverSource.coreRequest && ['partial', 'unconfirmed', 'failed'].includes(operation.phase) ? <button type="button" disabled={checking} onClick={() => {
        setChecking(true)
        void import('../lib/session-takeover').then(({ continueTakeoverOperation }) => continueTakeoverOperation(operation))
          .catch(cause => useAppStore.getState().reportError(cause)).finally(() => setChecking(false))
      }}>继续原接手</button> : null}
      {!compact || operation.phase === 'succeeded' ? <button type="button" onClick={() => changeOpen(false)}>收起</button> : null}
    </div>
  </div>
  if (compact) return <CompactOperationDetail operation={operation} active={active} open={open} onOpenChange={changeOpen} status={status} onAnimationEnd={onAnimationEnd}>{detail}</CompactOperationDetail>
  return <details className="agent-operation-feedback__item" data-kind={operation.kind} data-phase={operation.phase} data-detail-open={open} open={open}>
    <summary ref={trigger} className="agent-operation-feedback__label" onAnimationEnd={onAnimationEnd} aria-controls={panelId} aria-expanded={open}
      onClick={event => { event.preventDefault(); changeOpen(!open) }}>{status}</summary>
    {detail}
  </details>
}

function CompactOperationDetail({ operation, active, open, onOpenChange, status, onAnimationEnd, children }: {
  operation: Operation; active: boolean; open: boolean; onOpenChange(open: boolean): void; status: ReactNode;
  onAnimationEnd(event: { animationName: string }): void; children: ReactNode
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  const surface = useRef<HTMLDivElement | null>(null)
  const focusOnPlace = useRef(false)
  const attach = useCallback((node: HTMLDivElement | null) => { if (node) surface.current = node; setContent(node) }, [])
  useLayoutEffect(() => { if (!active && open) onOpenChange(false) }, [active, open, onOpenChange])
  useLayoutEffect(() => {
    if (!open || !active || !anchor || !content) return
    let current = true
    const position = async () => {
      const result = await computePosition(anchor, content, { strategy: 'fixed', placement: 'bottom-end',
        middleware: [offset(6), flip(), shift({ padding: 12 }), size({ padding: 12, apply: ({ availableHeight, availableWidth }) => {
          if (current) Object.assign(content.style, { maxHeight: Math.max(0, availableHeight) + 'px', maxWidth: Math.max(0, availableWidth) + 'px' })
        } })] })
      if (current) {
        Object.assign(content.style, { left: result.x + 'px', top: result.y + 'px', visibility: 'visible' })
        if (focusOnPlace.current) {
          focusOnPlace.current = false
          const focused = anchor.ownerDocument.activeElement
          if (focused === anchor || focused === anchor.ownerDocument.body) content.focus({ preventScroll: true })
        }
      }
    }
    const release = autoUpdate(anchor, content, () => { void position() })
    return () => { current = false; release() }
  }, [open, active, anchor, content])
  return <div className="agent-operation-feedback__item" data-kind={operation.kind} data-phase={operation.phase} data-detail-open={open}>
    <Dialog.Root modal={false} open={open && active} onOpenChange={next => { focusOnPlace.current = next; onOpenChange(next) }}>
      <Dialog.Trigger asChild><button ref={setAnchor} type="button" className="agent-operation-feedback__label" onAnimationEnd={onAnimationEnd}
        aria-label={`${label(operation)}，查看操作详情`}>{status}</button></Dialog.Trigger>
      <DocumentOverlayPortal component={Dialog.Portal}>
        <Dialog.Content ref={attach} className="agent-operation-feedback__popover" data-kind={operation.kind} data-phase={operation.phase}
          style={{ visibility: 'hidden' }} aria-describedby={undefined} tabIndex={-1}
          onOpenAutoFocus={event => event.preventDefault()}
          onCloseAutoFocus={event => {
            const owner = anchor?.ownerDocument ?? surface.current?.ownerDocument, focused = owner?.activeElement
            if (focused && focused !== owner?.body && focused !== anchor && !surface.current?.contains(focused)) event.preventDefault()
          }}>
          <div className="agent-operation-feedback__popover-header">
            <Dialog.Title className="agent-operation-feedback__popover-title">{titles[operation.kind]}操作详情</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="关闭操作详情"><CloseIcon size={14} /></Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </DocumentOverlayPortal>
    </Dialog.Root>
  </div>
}
