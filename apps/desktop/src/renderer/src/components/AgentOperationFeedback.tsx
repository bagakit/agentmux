import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { SemanticIcon, semanticIconComponent } from '@agentmux/client-ui/icons'
import { useVisibleWork } from '@agentmux/client-ui/use-visible-work'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { useAppStore } from '../store'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { agentOperationKey, dismissAgentOperation, inspectAgentOperation, type AgentOperationFeedback as Operation, type AgentOperationSubject } from '../lib/agent-operation-feedback'
import { stopSessionInBackground } from '../lib/session-stop-background'
import { agentOperationsForSubject, isDurableTakeoverCancellation, isRetainedTakeoverRecord } from '../lib/agent-operation'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { ContentCopyButton } from '@agentmux/client-ui/components/ContentCopyButton'
import { useSessionStop } from './SessionStop'
import { Button } from '@agentmux/client-ui/components/Button'
import { cancelledTakeoverStopTarget, cancelTakeoverOperation, openCancelledTakeoverTarget, TakeoverCancellationOwnerUnconfirmed } from '../lib/session-takeover-cancellation'

const CheckIcon = semanticIconComponent('action.refresh')
const StopIcon = semanticIconComponent('action.stop')
const CloseIcon = semanticIconComponent('action.close')
const MoreIcon = semanticIconComponent('action.more')
const titles = { stop: '停止', takeover: '接手', fork: 'Fork' }
// One original result can be read in a card and Header at once. Decoration in
// either projection must not remove the other projection's open reading surface.
const readers = new Map<string, Set<object>>()
const visibleFeedback = new Map<string, Set<object>>()
function trackFeedback(consumers: Map<string, Set<object>>, key: string, reader: object, active: boolean) {
  const held = consumers.get(key) ?? new Set<object>()
  if (active) { held.add(reader); consumers.set(key, held) }
  else { held.delete(reader); if (!held.size) consumers.delete(key) }
}
function dismissDecoration(operation: Operation) {
  if ((operation.phase === 'succeeded' || operation.kind === 'takeover' && operation.cancellation?.settlingFeedback) &&
      !readers.has(agentOperationKey(operation))) dismissAgentOperation(operation)
}
function dismissOffscreenDecoration(operation: Operation) {
  if (operation.kind === 'takeover' && operation.cancellation?.settlingFeedback && visibleFeedback.has(agentOperationKey(operation))) return
  dismissDecoration(operation)
}
function feedbackPhase(operation: Operation) {
  const cancellation = operation.kind === 'takeover' ? operation.cancellation : undefined
  if (!cancellation) return operation.phase
  if (cancellation.pending) return 'pending'
  return cancellation.result?.outcome === 'cancelled' ? 'cancelled' : cancellation.result?.outcome === 'created' ? 'partial' : 'unconfirmed'
}
function label(operation: Operation) {
  if (operation.kind === 'takeover' && operation.cancellation) {
    const cancellation = operation.cancellation
    if (cancellation.pending) return '取消接手中'
    if (cancellation.result?.outcome === 'cancelled') return '已取消接手'
    if (cancellation.result?.outcome === 'created') return '接手 Agent 已创建'
    if (cancellation.dispatch === 'not-submitted') return '取消尚未提交'
    return '取消未确认'
  }
  if (operation.phase === 'cancelled') return '已取消接手'
  if (operation.phase === 'pending') return `${titles[operation.kind]}中`
  if (operation.phase === 'succeeded') return operation.kind === 'stop' ? '已停止' : '已创建'
  if (operation.phase === 'partial') return `${titles[operation.kind]}部分完成`
  if (operation.phase === 'retired') return `${titles[operation.kind]}目标已关闭`
  return `${titles[operation.kind]}${operation.phase === 'failed' ? '失败' : '未确认'}`
}

/** Both the real card and Region header read these exact original references. */
export function AgentOperationFeedback({ subject, compact = false }: { subject: AgentOperationSubject; compact?: boolean }) {
  const operations = useAppStore(useShallow(state => agentOperationsForSubject(state.agentOperations, subject).filter(operation =>
    !isRetainedTakeoverRecord(operation) &&
    (operation.kind !== 'takeover' || !isDurableTakeoverCancellation(operation.cancellation?.result) || operation.cancellation?.settlingFeedback))))
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
    data-kind={decoration.kind} data-phase={feedbackPhase(decoration)} data-motion-active={visible && feedbackPhase(decoration) === 'pending'}
    style={{ '--operation-phase': `${phase}s` } as CSSProperties} onClick={event => event.stopPropagation()}>
    {operations.map(operation => <OperationFeedbackItem key={agentOperationKey(operation)} operation={operation} compact={compact} active={active} visible={visible} />)}
  </div>
}

function OperationFeedbackItem({ operation, compact, active, visible }: { operation: Operation; compact: boolean; active: boolean; visible: boolean }) {
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const [preparingCancel, setPreparingCancel] = useState(false)
  const [cancelIssue, setCancelIssue] = useState<Error | null>(null)
  const stop = useSessionStop(active)
  const reader = useRef({}), latest = useRef(operation)
  const trigger = useRef<HTMLElement>(null), content = useRef<HTMLDivElement>(null)
  const panelId = useId()
  latest.current = operation
  const key = agentOperationKey(operation)
  const cancellation = operation.kind === 'takeover' ? operation.cancellation : undefined
  const created = cancellation?.result?.outcome === 'created'
  const phase = feedbackPhase(operation)
  const takeover = operation.kind === 'takeover' ? operation : null
  const request = takeover?.takeoverSource.coreRequest
  const report = takeover?.report
  const recordedCreation = report?.requestId === operation.operationId && (report.outcome === 'opened' || report.outcome === 'partial' || report.outcome === 'retired')
    ? report.agent : null
  const recordedRetirement = report?.requestId === operation.operationId && report.outcome === 'retired'
  const hasRequest = request?.operationId === operation.operationId && request?.content.kind === 'takeover-agent'
  const canCancel = hasRequest && !['succeeded', 'retired', 'cancelled'].includes(operation.phase) &&
    (!cancellation || cancellation.dispatch === 'not-submitted')
  const retainedOnly = Boolean(takeover && !hasRequest && !cancellation && ['unconfirmed', 'failed', 'partial'].includes(phase))
  const cancelPreparationIssue = canCancel && !cancellation ? cancelIssue : null
  const cancelPreparationReason = cancelPreparationIssue instanceof TakeoverCancellationOwnerUnconfirmed
    ? '未能确认原工作区。' : '未能准备取消请求。'
  const showSaveGap = cancellation?.result?.outcome !== 'unconfirmed' && cancellation?.result?.diskDurability === 'unconfirmed'
  function changeOpen(next: boolean) {
    if (!next && !compact && content.current?.contains(content.current.ownerDocument.activeElement)) trigger.current?.focus({ preventScroll: true })
    trackFeedback(readers, key, reader.current, next)
    setOpen(next)
    if (!next) dismissDecoration(operation)
  }
  useEffect(() => () => { trackFeedback(readers, key, reader.current, false); dismissOffscreenDecoration(latest.current) }, [key])
  useEffect(() => { trackFeedback(readers, key, reader.current, open); return () => trackFeedback(readers, key, reader.current, false) }, [key, open])
  const settlementVisible = Boolean(takeover && visible)
  useLayoutEffect(() => {
    trackFeedback(visibleFeedback, key, reader.current, settlementVisible)
    return () => trackFeedback(visibleFeedback, key, reader.current, false)
  }, [key, settlementVisible])
  // Offscreen completion needs no decorative wait; open readers and unresolved references remain.
  useEffect(() => { if (!visible) dismissOffscreenDecoration(operation) }, [operation, visible])
  const statusText = cancellation?.pending ? label(operation) : preparingCancel ? '正在提交取消'
    : checking ? '正在检查' : continuing ? '正在继续接手' : cancelPreparationIssue ? '取消未提交' : label(operation)
  const busy = preparingCancel || checking || continuing || phase === 'pending'
  const status = <><SemanticIcon name={busy ? 'status.loading' : created || phase === 'succeeded' || phase === 'cancelled' ? 'action.confirm' : phase === 'failed' ? 'status.failed' : 'status.unknown'}
    size={12} {...(visible && busy ? { animation: 'spin' as const } : {})} aria-hidden="true" /><span role="status" data-text={statusText}>{statusText}</span></>
  const onAnimationEnd = (event: { animationName: string }) => {
    if (event.animationName === 'agent-operation-settle') dismissDecoration(operation)
  }
  function check() {
    setChecking(true)
    void inspectAgentOperation(operation).finally(() => setChecking(false))
  }
  function cancel(continueOriginal = false) {
    if (!takeover) return
    setCancelIssue(null)
    setPreparingCancel(true)
    void cancelTakeoverOperation(takeover, { continueOriginal })
      .catch(cause => setCancelIssue(cause instanceof Error ? cause : new Error(String(cause))))
      .finally(() => setPreparingCancel(false))
  }
  const canContinueCancel = cancellation?.result?.outcome === 'unconfirmed' && !cancellation.pending
  const quickActions = takeover ? <>
    {created ? <Button data-operation-action="view" onClick={() => {
      void openCancelledTakeoverTarget(takeover).catch(cause => useAppStore.getState().reportError(cause))
    }}>查看 Agent</Button> : null}
    <Button data-operation-action="check" disabled={checking} aria-busy={checking} aria-label={cancellation ? '检查取消结果' : '检查结果'}
      onClick={check}>检查</Button>
    {canCancel || canContinueCancel || cancellation?.pending ? <Button data-operation-action="cancel"
      disabled={preparingCancel || cancellation?.pending} aria-busy={preparingCancel || cancellation?.pending}
      onClick={() => cancel(Boolean(canContinueCancel))}>
      {canContinueCancel ? '继续取消' : cancelPreparationIssue || cancellation?.dispatch === 'not-submitted' ? '重试取消' : '取消接手'}
    </Button> : null}
  </> : null
  const detail = <div ref={content} id={panelId} className="agent-operation-feedback__detail" inert={!open} aria-hidden={!open}>
    {takeover ? <p className="agent-operation-feedback__summary">{phase === 'cancelled' ? '原会话与草稿已保留。'
      : created ? cancellation?.result?.initialInput === 'held' ? '新 Agent 已创建。尚未发送的接手步骤已撤销。' : '新 Agent 已保留。首条输入按原回执核对。'
      : cancellation?.pending ? '等待原工作区确认取消。'
      : cancellation ? '取消结果仍待确认。可以检查原请求。'
      : phase === 'retired' || recordedRetirement ? '接手 Agent 已创建，后来关闭了。'
      : recordedCreation ? recordedCreation.initialPrompt === 'confirmed' ? '接手 Agent 已创建，首条交接已确认。'
        : recordedCreation.initialPrompt === 'not-requested' ? '接手 Agent 已创建，尚无首条交接记录。' : '接手 Agent 已创建，首条交接待确认。'
      : hasRequest ? '取消会撤销尚未执行的接手步骤，原会话和草稿会保留。' : '旧记录缺少完整请求，只能检查结果。'}</p>
      : operation.message ? <p>{operation.message}</p> : null}
    {cancelPreparationIssue ? <p className="agent-operation-feedback__action-note" role="status">{cancelPreparationIssue.message}</p> : null}
    {showSaveGap ? <p className="agent-operation-feedback__save-notice">取消结果已核对，原保存回执待确认。</p> : null}
    <div className="agent-operation-feedback__actions">
      {takeover ? compact || retainedOnly ? quickActions : null : <Button disabled={checking} aria-busy={checking} onClick={check}><CheckIcon size={12} />核对原操作</Button>}
      {operation.kind === 'stop' && operation.canContinue && operation.phase !== 'succeeded' ? <Button onClick={() => {
        void stopSessionInBackground({ control: operation.control, operationId: operation.operationId }, { continueOriginal: true })
      }}><StopIcon size={12} />继续同次停止</Button> : null}
      {takeover && !cancellation && hasRequest && ['partial', 'unconfirmed', 'failed'].includes(operation.phase) ? <Button className="agent-operation-feedback__quiet" disabled={checking || continuing || preparingCancel} aria-busy={continuing} onClick={() => {
        setContinuing(true)
        void import('../lib/session-takeover').then(({ continueTakeoverOperation }) => continueTakeoverOperation(takeover))
          .catch(cause => useAppStore.getState().reportError(cause)).finally(() => setContinuing(false))
      }}>继续原接手</Button> : null}
      {takeover && created ? <Button className="agent-operation-feedback__quiet" onClick={event => {
          const origin = event.currentTarget
          void cancelledTakeoverStopTarget(takeover).then(({ session, agent }) => {
            stop.requestStop(session, session.label ?? agent.agentSessionId, origin)
          }).catch(cause => useAppStore.getState().reportError(cause))
        }}>停止接手 Agent…</Button> : null}
      {operation.kind !== 'takeover' && (!compact || operation.phase === 'succeeded') ? <Button onClick={() => changeOpen(false)}>收起</Button> : null}
    </div>
    <details className="agent-operation-feedback__technical"><summary>{takeover ? '技术信息' : '操作详情'}</summary>
      {operation.kind === 'takeover' && operation.message ? <p>原接手反馈：{operation.message}</p> : null}
      <div className="agent-operation-feedback__reference"><code>{operation.operationId}</code><ContentCopyButton text={operation.operationId} identity={key} label="复制原操作编号" actionLabel="复制" /></div>
      {operation.kind === 'stop' ? <p>原 Run：{operation.control.run.runId}</p> : null}
      {operation.callerOperationIds?.length ? <p>原请求：{operation.callerOperationIds.join(' · ')}</p> : null}
      {operation.report?.agent ? <p>Agent {operation.report.agent.agentSessionId}</p> : null}
      {cancellation ? <>
        <div className="agent-operation-feedback__reference"><code>{cancellation.input.operationId}</code><ContentCopyButton text={cancellation.input.operationId} identity={key} label="复制取消操作编号" actionLabel="复制" /></div>
        {cancellation.issue ? <p>取消检查：{cancellation.issue}</p> : null}
        {cancellation.result ? <p>取消记录保存：{cancellation.result.diskDurability === 'confirmed' ? '已确认' : '尚未确认'} · 原输入：{cancellation.result.initialInput === 'held' ? '未派发步骤已保留' : cancellation.result.initialInput === 'already-dispatched' ? '已派发' : '尚未确认'}</p> : null}
        {cancellation.result?.agent ? <p>接手 Agent：{cancellation.result.agent.agentSessionId}</p> : null}
      </> : null}
    </details>
  </div>
  if (compact || takeover) return <>
    <div className={`agent-operation-feedback__item${!compact ? ' agent-operation-feedback__takeover' : ''}`}
      data-kind={operation.kind} data-phase={phase} data-detail-open={open} data-takeover-created={created || undefined}
      data-result-settling={cancellation?.settlingFeedback}>
      <div className="agent-operation-feedback__rail">
        {!compact && !retainedOnly ? <span className="agent-operation-feedback__label agent-operation-feedback__readout" onAnimationEnd={onAnimationEnd}>{status}</span> : null}
        <div className="agent-operation-feedback__quick-actions">
          {!compact && !retainedOnly ? quickActions : null}
          <CompactOperationDetail operation={operation} active={active} open={open} onOpenChange={changeOpen} status={status}
            iconOnly={!compact} retainedOnly={retainedOnly} onAnimationEnd={onAnimationEnd}>{detail}</CompactOperationDetail>
        </div>
      </div>
      {!compact && (cancelPreparationIssue || showSaveGap) ? <span className="agent-operation-feedback__action-note" role="status">
        {cancelPreparationIssue ? cancelPreparationReason : '原保存回执待确认'}
      </span> : null}
    </div>
    {stop.dialog}
  </>
  return <><details className="agent-operation-feedback__item" data-kind={operation.kind} data-phase={phase} data-detail-open={open} open={open}>
    <summary ref={trigger} className="agent-operation-feedback__label" onAnimationEnd={onAnimationEnd} aria-controls={panelId} aria-expanded={open}
      onClick={event => { event.preventDefault(); changeOpen(!open) }}>{status}</summary>
    {detail}
  </details>{stop.dialog}</>
}

function CompactOperationDetail({ operation, active, open, onOpenChange, status, iconOnly, retainedOnly, onAnimationEnd, children }: {
  operation: Operation; active: boolean; open: boolean; onOpenChange(open: boolean): void; status: ReactNode;
  iconOnly: boolean; retainedOnly: boolean; onAnimationEnd(event: { animationName: string }): void; children: ReactNode
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
  return <Dialog.Root modal={false} open={open && active} onOpenChange={next => { focusOnPlace.current = next; onOpenChange(next) }}>
      <Dialog.Trigger asChild><button ref={setAnchor} type="button" data-operation-action="details"
        className={retainedOnly ? 'agent-button' : iconOnly ? 'icon-button agent-operation-feedback__more' : 'agent-operation-feedback__label'} onAnimationEnd={onAnimationEnd}
        aria-label={retainedOnly ? '查看原接手记录' : `${label(operation)}，查看操作详情`} title={iconOnly && !retainedOnly ? '操作详情' : undefined}>
        {retainedOnly ? '查看原接手记录' : iconOnly ? <MoreIcon size={14} /> : status}
      </button></Dialog.Trigger>
      <DocumentOverlayPortal component={Dialog.Portal}>
        <Dialog.Content ref={attach} className="agent-operation-feedback__popover" data-kind={operation.kind} data-phase={feedbackPhase(operation)}
          style={{ visibility: 'hidden' }} aria-describedby={undefined} tabIndex={-1}
          onOpenAutoFocus={event => event.preventDefault()}
          onCloseAutoFocus={event => {
            const owner = anchor?.ownerDocument ?? surface.current?.ownerDocument, focused = owner?.activeElement
            if (focused && focused !== owner?.body && focused !== anchor && !surface.current?.contains(focused)) event.preventDefault()
          }}>
          <div className="agent-operation-feedback__popover-header">
            <Dialog.Title className="agent-operation-feedback__popover-title">{retainedOnly ? '原接手记录' : `${titles[operation.kind]}操作详情`}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="关闭操作详情"><CloseIcon size={14} /></Dialog.Close>
          </div>
          {retainedOnly && <p className="agent-operation-feedback__summary">{status}</p>}
          {children}
        </Dialog.Content>
      </DocumentOverlayPortal>
  </Dialog.Root>
}
