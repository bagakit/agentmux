import { useEffect, useMemo, useRef, useState } from 'react'
import { ComposerSource } from '@agentmux/client-ui/components/ComposerHost'
import { MoteConversationStart as StartScene, MoteConversationHistory, moteConversationHistoryRows, type MoteConversationHistorySource as Source } from '@agentmux/client-ui/components/MoteConversationStart'
import { MoteFirstMessage, type MoteFirstMessageStage } from '@agentmux/client-ui/components/MoteFirstMessage'
import { useShallow } from 'zustand/react/shallow'
import { agentPromptSubmissionOutcome } from '@agentmux/core/mote-dialogue'
import { mintObjectId } from '@agentmux/core/object-id'
import type { MoteDefaultConversation } from '@agentmux/core/mote-preferences'
import { Button } from '@agentmux/client-ui/components/Button'
import { MoteMainActions, type MoteStartActions } from './MoteMainActions'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { BrandIcon } from './BrandIcon'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { useAppStore } from '../store'
import { checkpointLauncherState, useLauncherState, type LauncherDraft } from '../lib/launcher-state'
import { useMoteDialogueView } from '../lib/mote-dialogue-view'
import { readMoteMainAction, type MoteMainActionResult } from '../lib/mote-main-action'
import type { MoteWorkfaceScope, MoteRolloverStart } from '../lib/mote-workface'
import { sessionPresentationById } from '../lib/session-presentation'
import { moteEntryDraftKey, type MoteHeldEntryInput } from '../lib/mote-entry-hold'
import type { MoteMainDeferredInput } from '@agentmux/core/mote-dialogue'


/** The first message's stage from the original setup receipt alone; no result yet is still sending. */
function desktopFirstMessageStage(result: MoteMainActionResult | null, busy: boolean, operationId: string): MoteFirstMessageStage {
  const query = result?.record?.moteMain?.deferredInput
  if (!result) return busy ? 'sending' : 'unconfirmed'
  if (query?.operationId !== operationId) return 'unconfirmed'
  const outcome = agentPromptSubmissionOutcome(result.deferredInput?.record ?? null)
  return outcome === 'admitted' || outcome === 'terminal-confirmed' ? 'delivered' : 'unconfirmed'
}

/** The welcome uses the existing durable Launcher draft and original Main setup admission. */
export function MoteConversationStart({ scope, active, mode, onConfigure, onOpenMain, onOpenCreated, onOpenPeriod, automatic, held, onHeldSettled }: {
  scope: MoteWorkfaceScope; active: boolean; mode: 'start' | 'new'; onConfigure(invoker?: HTMLElement | null): void
  onOpenMain(reference: MoteDefaultConversation): void; onOpenCreated?(reference: MoteDefaultConversation): void; onOpenPeriod(source: Source): void
  automatic?: MoteRolloverStart | undefined
  /** A message held while the role owner was read; once it confirms no Main, it is this welcome's first message. */
  held?: MoteHeldEntryInput | null | undefined; onHeldSettled?: ((operationId: string, delivered?: boolean) => void) | undefined
}) {
  const dialogue = useMoteDialogueView(), bindings = useAppStore(state => state.spaceZoneBindings)
  const iconTarget = useMemo(() => topicSpaceIconTarget(scope.workspace, scope.topic, bindings), [scope.workspace, scope.topic, bindings])
  const icon = useAppStore(state => iconTarget ? state.spaceObjectIcons[iconTarget.key] ?? null : null)
  const key = moteEntryDraftKey(scope)
  const draft = useLauncherState(state => state.drafts[key]?.prompt ?? ''), persistenceIssue = useLauncherState(state => state.persistenceIssue)
  const [notice, setNotice] = useState<string | null>(null)
  const source = useRef({ key, active }); source.current = { key, active }
  const lifetime = useRef({})
  useEffect(() => { lifetime.current = {}; return () => { lifetime.current = {} } }, [key, active])
  const submission = useRef<(MoteMainDeferredInput & { draft: LauncherDraft | undefined; lifetime: object; released?: boolean; releasedDraft?: LauncherDraft | undefined; landed?: boolean }) | null>(null)
  const automaticSettling = useRef<string | null>(null)
  const rows = moteConversationHistoryRows(dialogue?.page?.links ?? [], dialogue?.page?.main.roleRevision)
  // Only the history rows' own Sessions are read, so an unrelated Session update does not redraw the welcome.
  const labels = useAppStore(useShallow(state => {
    const index = sessionPresentationById(state.sessions)
    return rows.map(row => {
      const candidate = index.get(row.source.reference.sessionId)
      return candidate?.kind === 'agent' && candidate.control.hostId === row.source.reference.hostId ? candidate.label : undefined
    })
  }))
  const history = rows.map((row, index) => ({ ...row, item: { ...row.item, ...(labels[index] ? { title: labels[index]! } : {}) } }))
  // The person's message as sent, shown in place while its Main is created; the frozen first message, not a queue.
  const [sent, setSent] = useState<{ operationId: string; prompt: string; key: string } | null>(null)
  function restoreDraft(original: NonNullable<typeof submission.current>) {
    const drafts = useLauncherState.getState()
    if (drafts.drafts[key] !== original.releasedDraft) return
    if (original.focusTask) drafts.setTaskDraft(key, { prompt: original.prompt, focusTask: original.focusTask }, { draft: original.releasedDraft })
    else drafts.setDraft(key, 'prompt', original.prompt)
  }
  async function releaseDraft(query: MoteMainDeferredInput) {
    const original = submission.current
    if (!original || original.operationId !== query.operationId || original.prompt !== query.prompt || JSON.stringify(original.focusTask) !== JSON.stringify(query.focusTask) || source.current.key !== key ||
      useLauncherState.getState().drafts[key] !== original.draft || original.lifetime !== lifetime.current || useLauncherState.getState().drafts[key]?.prompt !== original.prompt) return
    // The existing creation reference now durably holds this caller's text; later
    // draft edits have their own custody and must never be cleared by its receipt.
    if (!useLauncherState.getState().setDraft(key, 'prompt', '')) return
    original.released = true; original.releasedDraft = useLauncherState.getState().drafts[key]
    try { await checkpointLauncherState() }
    catch {
      restoreDraft(original)
      original.released = false
      setNotice('原问题已保留，输入框的保存尚未确认。')
    }
  }
  // Binding, input admission and draft custody are separate facts. Landing changes only the body; later text stays in the same editor.
  async function confirmed(result: MoteMainActionResult, query: MoteMainDeferredInput, mayNavigate: () => boolean) {
    const original = submission.current, canonical = result.record?.moteMain?.deferredInput
    const outcome = agentPromptSubmissionOutcome(result.deferredInput?.record ?? null)
    const inLifetime = () => source.current.key === key && source.current.active && original?.lifetime === lifetime.current
    const draftUnchanged = () => useLauncherState.getState().drafts[key] === (original?.released ? original.releasedDraft : original?.draft)
    if (!original || query.operationId !== original.operationId || canonical?.operationId !== original.operationId || canonical.prompt !== original.prompt ||
      query.prompt !== original.prompt || JSON.stringify(canonical.focusTask) !== JSON.stringify(original.focusTask) ||
      JSON.stringify(query.focusTask) !== JSON.stringify(original.focusTask) || !inLifetime()) return
    if (['admitted', 'terminal-confirmed'].includes(outcome) && draftUnchanged() && !original.released) {
      const saved = useLauncherState.getState().setDraft(key, 'prompt', '')
      if (saved) { original.released = true; original.releasedDraft = useLauncherState.getState().drafts[key] }
      if (!saved || useLauncherState.getState().persistenceIssue) {
        if (draftUnchanged()) restoreDraft(original)
        setNotice('原消息已确认投递；草稿保存尚未确认，原文保留。')
      }
    }
    if (original.landed || result.binding !== 'confirmed' || !result.reference || !mayNavigate()) return
    const fresh = await readMoteMainAction(scope).catch(() => null)
    if (inLifetime() && !original.landed && mayNavigate() && fresh && JSON.stringify(fresh.dialogue.main.current) === JSON.stringify(result.reference)) {
      original.landed = true; onOpenMain(result.reference)
    }
  }
  async function confirmAutomatic(result: MoteMainActionResult, mayNavigate: () => boolean) {
    if (!automatic || automaticSettling.current === automatic.query.operationId || !result.reference) return
    const canonical = result.record?.moteMain?.deferredInput
    if (result.record?.requestId !== automatic.decision.creationOperationId || JSON.stringify(result.record.moteMain?.rollover) !== JSON.stringify(automatic.decision) ||
      canonical?.operationId !== automatic.query.operationId || canonical.prompt !== automatic.query.prompt || JSON.stringify(canonical.focusTask) !== JSON.stringify(automatic.query.focusTask)) return
    automaticSettling.current = automatic.query.operationId
    try {
      const fresh = await readMoteMainAction(scope)
      // Consume the existing same-operation inspection after its worker, independently of binding/landing.
      const observed = fresh.previousCreation?.operationId === result.operationId ? fresh.previousCreation : result
      const input = observed.record?.moteMain?.deferredInput
      const accepted = agentPromptSubmissionOutcome(observed.deferredInput?.record ?? null)
      const entry = useAppStore.getState().agentSteerQueues[automatic.sessionId]?.find(item => item.operationId === automatic.query.operationId)
      if (observed.record?.requestId === automatic.decision.creationOperationId && JSON.stringify(observed.record.moteMain?.rollover) === JSON.stringify(automatic.decision) &&
        input?.operationId === automatic.query.operationId && input.prompt === automatic.query.prompt && JSON.stringify(input.focusTask) === JSON.stringify(automatic.query.focusTask) && ['admitted', 'terminal-confirmed'].includes(accepted) &&
        entry?.mainRollover?.creationOperationId === automatic.decision.creationOperationId && entry.text === automatic.query.prompt && JSON.stringify(entry.focusTask) === JSON.stringify(automatic.query.focusTask))
        await useAppStore.getState().archiveAgentSteer(automatic.sessionId, entry.operationId, entry.text, true)
      if (source.current.key === key && source.current.active && mayNavigate() && result.binding === 'confirmed' && JSON.stringify(fresh.dialogue.main.current) === JSON.stringify(result.reference)) onOpenMain(result.reference)
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (automaticSettling.current === automatic.query.operationId) automaticSettling.current = null }
  }

  return <MoteMainActions scope={scope} active={active} onConfigure={onConfigure} onOpenCreated={onOpenCreated} onRefresh={dialogue?.refresh}
    onResult={(result, mayNavigate) => { void confirmAutomatic(result, mayNavigate); if (submission.current) void confirmed(result, submission.current, mayNavigate) }}
    renderStart={state => <><AutomaticStart automatic={automatic} state={state} active={active} />
      <HeldStart held={held} state={state} active={active && !automatic && mode === 'start' && !persistenceIssue} onStart={query => {
        // The held text becomes this welcome's ordinary first message: back in the draft, then the same submit, confirm and clear.
        onHeldSettled?.(query.operationId)
        submission.current = { ...query, draft: useLauncherState.getState().drafts[key], lifetime: lifetime.current }; setSent({ ...query, key })
        void state.submit(query, undefined, releaseDraft)
      }} />
      <StartScene name={scope.topic.title} active={active}
      mode={state.reading && !state.reading.issue ? mode : 'unconfirmed'}
      portrait={<SpaceObjectIcon kind="mote" name={scope.topic.title} manualIcon={icon} avatarObjectKey={iconTarget?.key}
        avatarWorkspaceId={scope.workspace.id} avatarTopicId={scope.topic.id} visible={active} />}
      brand={<BrandIcon size={128} />}
      drafting={Boolean(draft.trim())}
      pending={(() => {
        const pending = sent?.key === key ? sent : state.retainedInput ? { ...state.retainedInput, key } : null
        return pending ? <MoteFirstMessage messageId={'mote-first:' + pending.operationId} prompt={pending.prompt} name={scope.topic.title}
        showPrompt={draft !== pending.prompt} stage={desktopFirstMessageStage(state.result, state.busy, pending.operationId)}
        action={{ label: '核对', disabled: Boolean(state.checking), onClick: () => {
          // Check the creation request itself, never the first message's own id; with none known yet, reread.
          const request = state.retainedInput?.creationOperationId ?? state.pending[0] ?? state.result?.operationId ?? state.reading?.operationId
          if (request) state.inspect(request); else state.refresh()
        } }} /> : undefined
      })()}
      actions={<button type="button" className="mote-start__settings" onClick={event => onConfigure(event.currentTarget)} aria-label="Mote 快捷配置">设置</button>}
      composer={<ComposerSource ownerKey={key} sourceKey="welcome" value={draft} disabled={false} active={active} placeholder="写下你想聊的事…"
        onChange={value => { useLauncherState.getState().setDraft(key, 'prompt', value) }}
        {...(state.ready && !state.busy && active && !persistenceIssue && !automatic && (mode === 'new' || !state.reading?.dialogue.main.current) ? { onSubmit: () => {
          const draft = useLauncherState.getState().drafts[key]
          const query = { operationId: mintObjectId(), prompt: draft?.prompt ?? '', ...(draft?.focusTask ? { focusTask: draft.focusTask } : {}), draft, lifetime: lifetime.current }
          submission.current = query; setSent({ operationId: query.operationId, prompt: query.prompt, key })
          void state.submit({ operationId: query.operationId, prompt: query.prompt, ...(query.focusTask ? { focusTask: query.focusTask } : {}) }, undefined, releaseDraft)
        } } : {})} />}
      notice={<>{mode === 'new' ? <p>新一轮只接收你明确发送的新消息；旧对话和未确认的消息留在原处，不会重发。</p> : null}
        {state.pending.length ? <div className="mote-main-recovery__actions" data-main-original-request>
          <span>原开始请求已保留，创建与交接分别核对。</span>
          {state.pending.map(id => <Button key={id} type="button" disabled={state.checking} onClick={() => state.inspect(id)}>核对原开始请求</Button>)}
          {state.openOriginal ? <Button type="button" onClick={state.openOriginal}>查看原开始位置</Button> : null}
        </div> : null}{state.issue && <p role="status">{state.issue}
        {state.reading?.preferences.status === 'ready' && !state.reading.executor && (mode === 'new' || !state.reading.dialogue.main.current)
          ? <> <Button type="button" onClick={event => onConfigure(event.currentTarget)}>配置 Agent</Button></> : null}
      </p>}{notice && <p role="status">{notice}</p>}{persistenceIssue && <p role="status">{persistenceIssue}</p>}
        {automatic && <div role="status">{automatic.decision.policy.kind === 'executor-change' ? '这条新问题将由所选 Agent 承接。' : automatic.decision.policy.kind === 'continuity-unavailable' ? '保存的接续策略为这条新问题选择新对话；旧消息留在原处。' : '这条新问题按保存的空闲策略接续；旧消息留在原处。'}<details><summary>这条新问题</summary><p>{automatic.query.prompt}</p></details></div>}
        {mode !== 'new' && state.reading?.dialogue.main.current && <p role="status">已有当前主对话，这里不会另建主 Agent；草稿保留，可从「对话选项」返回当前主对话。</p>}
        {state.busy && !(sent && sent.key === key) && <p role="status">正在接通这次对话…</p>}
        <details><summary>{state.pending.length ? '原开始请求待核对' : '对话选项'}</summary>
          <button type="button" onClick={event => onConfigure(event.currentTarget)}>快捷配置</button><button type="button" disabled={state.busy} onClick={state.refresh}>重新核对</button>
          {state.retainedInput ? <button type="button" disabled={state.restoringInput} onClick={() => { void state.restoreInput?.().then(saved => { if (saved) setSent(null) }) }}>移回草稿</button> : null}
          {state.reading?.dialogue.main.current && <button type="button" onClick={() => onOpenMain(state.reading!.dialogue.main.current!)}>返回当前主对话</button>}
          {state.pending.map(id => <div key={id}><button type="button" disabled={state.checking} onClick={() => state.inspect(id)}>核对原开始请求</button><button type="button" disabled={state.busy} onClick={() => state.advance(id)}>继续原开始请求</button><code>{id}</code></div>)}
          {state.result && <p>{state.result.issue ?? '原请求已保留，绑定和消息投递分别核对。'} <code>{state.result.operationId}</code></p>}
        </details></>}
      history={<MoteConversationHistory items={history.map(row => row.item)} reading={Boolean(dialogue?.loading)} onOpen={item => {
        const row = history.find(value => value.item.id === item.id); if (row) item.current ? onOpenMain(row.source.reference) : onOpenPeriod(row.source)
      }} onMore={dialogue?.page?.next ? dialogue.older : undefined} />}
    /></>} />
}

/** Sends a held message once, as the first message, only after the original role owner confirms there is no Main. */
function HeldStart({ held, state, active, onStart }: { held?: MoteHeldEntryInput | null | undefined; state: MoteStartActions; active: boolean
  onStart(query: MoteMainDeferredInput): void }) {
  const started = useRef<string | null>(null)
  useEffect(() => {
    if (!held || !active || !state.ready || state.busy || state.reading?.dialogue.main.current || started.current === held.operationId) return
    started.current = held.operationId
    onStart({ operationId: held.operationId, prompt: held.prompt, ...(held.focusTask ? { focusTask: held.focusTask } : {}),
      ...(held.sourceChannel ? { sourceChannel: held.sourceChannel } : {}), ...(held.inputImages ? { inputImages: held.inputImages } : {}) })
  }, [held, active, state.ready, state.busy, state.reading?.dialogue.main.current])
  return null
}

function AutomaticStart({ automatic, state, active }: { automatic?: MoteRolloverStart | undefined; state: MoteStartActions; active: boolean }) {
  const started = useRef<string | null>(null)
  useEffect(() => {
    if (!automatic || !active || !state.ready || state.busy || started.current === automatic.query.operationId) return
    started.current = automatic.query.operationId
    void state.submit(automatic.query, automatic.decision)
  }, [automatic, active, state.ready, state.busy, state.submit])
  return null
}
