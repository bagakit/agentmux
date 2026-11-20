import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { agentPromptSubmissionOutcome, type MoteMainDeferredInput, type MoteMainRolloverDecision } from '@agentmux/core/mote-dialogue'
import type { MoteDefaultConversation } from '@agentmux/core/mote-preferences'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { Button } from '@agentmux/client-ui/components/Button'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import { useMoteDialogueView } from '../lib/mote-dialogue-view'
import { moteConnectionTarget } from '../lib/mote-connection-default'
import { createMoteMain, continueMoteMainAction, inspectMoteMainAction, readMoteMainAction,
  moveMoteMainFirstInputToDraft, originalMainCreationRetainsInput, readMoteMainStartPosition, type MoteMainActionReading, type MoteMainActionResult } from '../lib/mote-main-action'
import { useAppStore } from '../store'
import { DocumentOverlayPortal } from './WindowOverlayHost'

const STAGE: Record<string, string> = { confirmed: '已确认', unconfirmed: '待核对', refused: '未接受', 'not-needed': '无需' }

/** Explicit Main actions. Reading/hover never creates; the original owners retain every operation. */
export type MoteStartActions = { reading: MoteMainActionReading | null; result: MoteMainActionResult | null; issue: string | null; busy: boolean
  checking?: boolean; ready: boolean; pending: string[];
  retainedInput?: { operationId: string; prompt: string; creationOperationId: string } | undefined;
  originalPosition?: { operationId:string; reference:MoteDefaultConversation } | null; openOriginal?():void;
  restoringInput?: boolean; restoreInput?(): Promise<boolean>;
  submit(query: MoteMainDeferredInput, rollover?: MoteMainRolloverDecision, onRetained?: (query: MoteMainDeferredInput) => void | Promise<void>): Promise<void>;
  inspect(id: string): void; advance(id: string): void; refresh(): void }
export function MoteMainActions({ scope, active, entryToken, onConfigure, onCreated, onRefresh, onOpenWorkspace, onOpenCreated, presentation, renderStart, onQueryResult, onStartNew, onResult, onPendingCreation, onInspectRecovery }: {
  scope: MoteWorkfaceScope; active: boolean; presentation?: 'menu' | 'setup' | undefined; entryToken?: string | undefined
  onConfigure(invoker?: HTMLElement | null): void; onCreated?(reference: MoteDefaultConversation): void; onOpenCreated?: ((reference: MoteDefaultConversation) => void) | undefined; onRefresh?: (() => void) | undefined; onOpenWorkspace?: (() => void) | undefined
  onStartNew?: (() => void) | undefined; renderStart?: ((state: MoteStartActions) => ReactNode) | undefined
  onQueryResult?: ((result: MoteMainActionResult, query: MoteMainDeferredInput, mayNavigate: () => boolean) => void) | undefined
  onResult?: ((result: MoteMainActionResult, mayNavigate: () => boolean) => void) | undefined
  onPendingCreation?: ((operationIds: string[]) => void) | undefined
  onInspectRecovery?: (() => void) | undefined
}) {
  const model = useMoteDialogueView()
  const [reading, setReading] = useState<MoteMainActionReading | null>(null), [result, setResult] = useState<MoteMainActionResult | null>(null)
  const [issue, setIssue] = useState<string | null>(null), [busy, setBusy] = useState(false), [generation, setGeneration] = useState(0)
  const [originalPosition, setOriginalPosition] = useState<Awaited<ReturnType<typeof readMoteMainStartPosition>>>(null)
  const [checking, setChecking] = useState(false), inspection = useRef(false)
  const [restoringInput, setRestoringInput] = useState(false), restoring = useRef(false)
  const identity = JSON.stringify(moteConnectionTarget(scope, useAppStore.getState().spaceZoneBindings))
  const retained = useAppStore(state => state.moteMainCreationReferences[identity])
  const lifetime = useRef({}), flight = useRef(false)
  const current = model?.page?.main.current ?? reading?.dialogue.main.current
  const settingsVersion = scope.topic.quickMode?.status === 'saved' ? scope.topic.quickMode.version : scope.topic.quickMode?.status
  const observedSettings = useRef(settingsVersion)
  useEffect(() => {
    if (observedSettings.current === settingsVersion) return
    observedSettings.current = settingsVersion
    // A role write from this original setup must not invalidate its own in-flight
    // input receipt. That operation rereads the canonical settings when it settles.
    if (!flight.current) setGeneration(value => value + 1)
  }, [settingsVersion])
  useEffect(() => {
    const token = {}; lifetime.current = token
    setReading(null); setResult(null); setOriginalPosition(null); setIssue(null); setBusy(false)
    if (!active) return
    void readMoteMainAction(scope).then(async source => {
      if (lifetime.current !== token) return
      setReading(source); setIssue(source.issue)
      const prior = source.previousCreation
      if (prior) { setResult(prior); setIssue(prior.issue ?? source.issue); onResult?.(prior, () => lifetime.current === token) }
    }).catch(cause => { if (lifetime.current === token) setIssue(presentError(cause)) })
    return () => { if (lifetime.current === token) lifetime.current = {} }
  }, [identity, active, generation, entryToken])
  // The Main menu is the shared non-modal popover: Escape, outside press and focus return belong to it.
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuTrigger, setMenuTrigger] = useState<HTMLButtonElement | null>(null), [menuPanel, setMenuPanel] = useState<HTMLDivElement | null>(null)
  useEffect(() => { if (!active) setMenuOpen(false) }, [active])
  useLayoutEffect(() => {
    if (!menuOpen || !menuTrigger || !menuPanel) return
    let current = true
    const update = async () => {
      const result = await computePosition(menuTrigger, menuPanel, { strategy: 'fixed', placement: 'bottom-end',
        middleware: [offset(4), flip(), shift({ padding: 10 }), size({ padding: 10, apply: ({ availableHeight, availableWidth }) => {
          if (current) Object.assign(menuPanel.style, { maxHeight: Math.max(0, availableHeight) + 'px', maxWidth: Math.max(0, availableWidth) + 'px' })
        } })] })
      if (current) Object.assign(menuPanel.style, { left: result.x + 'px', top: result.y + 'px', visibility: 'visible' })
    }
    const release = autoUpdate(menuTrigger, menuPanel, () => { void update() })
    return () => { current = false; release() }
  }, [menuOpen, menuTrigger, menuPanel])
  async function run(operation: () => Promise<MoteMainActionResult>, token = lifetime.current, navigate = false, query?: MoteMainDeferredInput) {
    if (flight.current) return
    flight.current = true; setBusy(true); setIssue(null)
    try {
      const value = await operation()
      if (lifetime.current !== token) return
      setResult(value); setIssue(value.issue)
      // Landing belongs to this view's lifetime: leaving this Mote's Discussion ends it, and the host guards its
      // own draft edits. Reading, scrolling, clicking elsewhere or switching apps while waiting does not cancel it.
      const mayNavigate = () => lifetime.current === token
      onResult?.(value, mayNavigate)
      if (query) onQueryResult?.(value, query, mayNavigate)
      if (value.binding === 'confirmed') {
        model?.refresh(); onRefresh?.()
        const fresh = await readMoteMainAction(scope)
        if (lifetime.current === token) setReading(fresh)
        if (navigate && value.reference && onCreated) {
          if (lifetime.current === token && JSON.stringify(fresh.dialogue.main.current) === JSON.stringify(value.reference)) onCreated(value.reference)
        }
      }
    } catch (cause) { if (lifetime.current === token) setIssue(presentError(cause)) }
    // The flight is over whichever view lifetime is current: a remount during it must not keep busy forever.
    finally { flight.current = false; setBusy(false) }
  }
  // Read the frozen original operation even while a creation/setup reply is pending.
  // This read never advances that mutation or clears its single-flight guard.
  async function inspectOriginal(id: string) {
    if (inspection.current || !active) return
    inspection.current = true; setChecking(true)
    const token = lifetime.current
    try {
      // The role journal can wait independently of its already retained spatial position.
      // This optional read neither gates the original setup inspection nor claims binding.
      void readMoteMainStartPosition(scope, id).then(position => {
        if (lifetime.current === token) setOriginalPosition(position)
      }).catch(cause => { if (lifetime.current === token) setIssue(presentError(cause)) })
      const value = await inspectMoteMainAction(scope, id)
      if (lifetime.current !== token) return
      setResult(value); setIssue(value.issue)
      onResult?.(value, () => lifetime.current === token)
    } catch (cause) { if (lifetime.current === token) setIssue(presentError(cause)) }
    finally { inspection.current = false; setChecking(false) }
  }
  async function restoreInput() {
    if (!retained?.deferredInput || restoring.current) return false
    const token = lifetime.current
    restoring.current = true; setRestoringInput(true)
    try { await moveMoteMainFirstInputToDraft(scope, retained); return true }
    catch (cause) { if (lifetime.current === token) setIssue(presentError(cause)); return false }
    finally { restoring.current = false; setRestoringInput(false) }
  }
  const pendingCreations = [...new Set([...(reading?.pendingOperationId ? [reading.pendingOperationId] : []), ...(result?.binding === 'unconfirmed' ? [result.operationId] : []),
    ...(retained && (!result || result.operationId !== retained.operationId || result.binding === 'unconfirmed') ? [retained.operationId] : [])])]
  // Bound first-message custody stays inspectable; it is not another creation intent.
  const pending = [...new Set([...(reading?.pendingStarts ?? []), ...pendingCreations])]
  const pendingCreationKey = JSON.stringify(pendingCreations)
  useEffect(() => { if (active) onPendingCreation?.(pendingCreations) }, [active, identity, pendingCreationKey, onPendingCreation])
  if (!active) return null
  const notice = [issue, retained?.deferredInputIssue].filter(Boolean).join('\n') || null
  const retainedInput = retained?.deferredInput && !originalMainCreationRetainsInput(retained, result) ? { ...retained.deferredInput, creationOperationId: retained.operationId } : undefined
  if (renderStart) return renderStart({ reading, result, issue: notice, busy, checking, pending, originalPosition,
    ...(originalPosition && onOpenCreated ? { openOriginal: () => onOpenCreated(originalPosition.reference) } : {}), retainedInput, restoringInput, restoreInput, ready: Boolean(reading && !reading.issue && !pendingCreations.length),
    submit: async (query, rollover, retained) => { if (reading) await run(() => createMoteMain(scope, reading, query, rollover, retained), undefined, false, query) },
    inspect: id => { void inspectOriginal(id) }, advance: id => { void run(() => continueMoteMainAction(scope, id)) }, refresh: () => setGeneration(value => value + 1) })
  const queryOutcome = result?.deferredInput?.input?.status === 'not-applied' ? 'not-applied' : agentPromptSubmissionOutcome(result?.deferredInput?.record ?? null)
  const queryPending = Boolean(result?.record?.moteMain?.deferredInput && !['admitted','terminal-confirmed','not-applied'].includes(queryOutcome))
  const menu = Boolean(current) || presentation === 'menu'
  const leave = (action: () => void) => () => { setMenuOpen(false); action() }
  const actions = <>
    <Button type="button" disabled={busy || !onStartNew && (!reading || Boolean(reading.issue))}
      onClick={() => { if (onStartNew) leave(onStartNew)(); else if (reading) void run(() => createMoteMain(scope, reading), undefined, true) }}>{busy ? '正在核对…' : current ? '开始新一轮对话' : '开始对话'}</Button>
    <Button type="button" onClick={event => { const invoker = menu ? menuTrigger : event.currentTarget; setMenuOpen(false); onConfigure(invoker) }}>设置 Executor 优先级</Button>
    {current && onOpenWorkspace ? <Button type="button" onClick={leave(onOpenWorkspace)}>在工作区打开</Button> : null}
    {onInspectRecovery ? <Button type="button" onClick={leave(onInspectRecovery)}>核对恢复进度</Button> : null}
    <Button type="button" disabled={busy} onClick={() => setGeneration(value => value + 1)}>重新核对</Button>
  </>
  const status = <>
    {notice ? <p role="status" className="mote-details__issue">{notice}</p> : null}
    {retainedInput ? <details><summary>本设备保留的问题</summary><p>{retainedInput.prompt}</p><p>原问题保留在本设备，可移回草稿。</p>
      <Button type="button" disabled={restoringInput} onClick={() => { void restoreInput() }}>移回草稿</Button></details> : null}
    {result ? <details><summary>原主 Agent 请求 · {queryPending ? '首条消息待核对' : result.binding === 'confirmed' ? '绑定已确认' : '待核对'}</summary>
      <p>创建：{STAGE[result.creation]} · 原来源：{STAGE[result.source]} · 主角色绑定：{STAGE[result.binding]}</p>
      <code>{result.operationId}</code>
      {result.reference ? <p>{result.reference.hostId} / {result.reference.sessionId}</p> : null}
      {result.creation === 'confirmed' && result.binding !== 'confirmed' && result.reference && onOpenCreated ? <Button type="button"
        onClick={() => { setMenuOpen(false); onOpenCreated(result.reference!) }}>打开已创建的 Agent</Button> : null}
      <Button type="button" disabled={checking} onClick={() => void inspectOriginal(result.operationId)}>核对原请求</Button>
      {result.record?.moteMain?.deferredInput ? <details><summary>原首条消息</summary><p>{result.record.moteMain.deferredInput.prompt}</p>
        <p>{queryOutcome === 'not-applied' ? '首条消息未投递，原文保留。' : queryPending ? '首条消息尚未确认，不重复发送。' : '首条消息已确认接收。'}</p></details> : null}
      {(result.binding === 'unconfirmed' || queryPending) && result.creation === 'confirmed' ? <Button type="button" disabled={busy}
        onClick={() => void run(() => continueMoteMainAction(scope, result.operationId), undefined, true)}>继续原开始请求</Button> : null}
    </details> : null}
    {pending.length > 1 || retained?.deferredInputIssue ? <details><summary>待核对的开始请求 · {pending.length}</summary>{pending.map(id => <div key={id}><code>{id}</code>
      <button type="button" disabled={checking} onClick={() => void inspectOriginal(id)}>核对原请求</button>
      <button type="button" disabled={busy} onClick={() => void run(() => continueMoteMainAction(scope, id))}>继续原请求</button></div>)}</details> : null}
  </>
  return <div className="mote-main-actions" data-presentation={presentation ?? (current ? 'menu' : 'setup')} aria-label="主 Agent 操作" aria-busy={busy}>
    {menu ? <Dialog.Root modal={false} open={menuOpen && active} onOpenChange={setMenuOpen}>
      <Dialog.Trigger asChild><button type="button" ref={setMenuTrigger} className="mote-main-actions__trigger">主 Agent</button></Dialog.Trigger>
      <DocumentOverlayPortal component={Dialog.Portal}>
        <Dialog.Content ref={setMenuPanel} className="mote-main-actions__menu" style={{ visibility: 'hidden' }} aria-describedby={undefined} aria-busy={busy}>
          <Dialog.Title className="mote-main-actions__title">主 Agent</Dialog.Title>
          <div>{actions}</div><p className="mote-details__hint">新的主 Agent 会接手这个 Mote 的主对话，原对话及其运行中的工作都保留。</p>{status}
        </Dialog.Content>
      </DocumentOverlayPortal>
    </Dialog.Root>
      : <div>{!reading && !issue ? <p role="status">正在读取原主 Agent 设置…</p> : null}{actions}{status}</div>}
  </div>
}
