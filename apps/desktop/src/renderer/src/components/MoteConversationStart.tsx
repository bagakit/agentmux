import { useEffect, useMemo, useRef, useState } from 'react'
import { AgentComposer } from '@agentmux/client-ui/components/AgentComposer'
import { MoteConversationStart as StartScene, MoteConversationHistory, moteConversationHistoryRows, type MoteConversationHistorySource as Source } from '@agentmux/client-ui/components/MoteConversationStart'
import { MoteFirstMessage, type MoteFirstMessageStage } from '@agentmux/client-ui/components/MoteFirstMessage'
import { useShallow } from 'zustand/react/shallow'
import { agentPromptSubmissionOutcome } from '@agentmux/core/mote-dialogue'
import { mintObjectId } from '@agentmux/core/object-id'
import type { MoteDefaultConversation } from '@agentmux/core/mote-preferences'
import { MoteMainActions, type MoteStartActions } from './MoteMainActions'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { BrandIcon } from './BrandIcon'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { useAppStore } from '../store'
import { checkpointLauncherState, useLauncherState } from '../lib/launcher-state'
import { useMoteDialogueView } from '../lib/mote-dialogue-view'
import { readMoteMainAction, type MoteMainActionResult } from '../lib/mote-main-action'
import type { MoteWorkfaceScope, MoteRolloverStart } from '../lib/mote-workface'
import { sessionPresentationById } from '../lib/session-presentation'
import { moteEntryDraftKey, type MoteHeldEntryInput } from '../lib/mote-entry-hold'


/** The first message's stage from the original setup receipt alone; no result yet is still sending. */
function desktopFirstMessageStage(result: MoteMainActionResult | null, busy: boolean, operationId: string): MoteFirstMessageStage {
  const query = result?.record?.moteMain?.deferredInput
  if (!result) return busy ? 'sending' : 'unconfirmed'
  if (query?.operationId !== operationId) return 'unconfirmed'
  const outcome = agentPromptSubmissionOutcome(result.deferredInput?.record ?? null)
  return outcome === 'admitted' || outcome === 'terminal-confirmed' ? 'delivered' : 'unconfirmed'
}

/** The welcome uses the existing durable Launcher draft and original Main setup admission. */
export function MoteConversationStart({ scope, active, mode, onConfigure, onOpenMain, onOpenPeriod, automatic, held, onHeldSettled }: {
  scope: MoteWorkfaceScope; active: boolean; mode: 'start' | 'new'; onConfigure(invoker?: HTMLElement | null): void
  onOpenMain(reference: MoteDefaultConversation): void; onOpenPeriod(source: Source): void
  automatic?: MoteRolloverStart | undefined
  /** A message held while the role owner was read; once it confirms no Main, it is this welcome's first message. */
  held?: MoteHeldEntryInput | null | undefined; onHeldSettled?: ((operationId: string, delivered?: boolean) => void) | undefined
}) {
  const dialogue = useMoteDialogueView(), bindings = useAppStore(state => state.spaceZoneBindings)
  const iconTarget = useMemo(() => topicSpaceIconTarget(scope.workspace, scope.topic, bindings), [scope.workspace, scope.topic, bindings])
  const icon = useAppStore(state => iconTarget ? state.spaceObjectIcons[iconTarget.key] ?? null : null)
  const key = moteEntryDraftKey(scope)
  const draft = useLauncherState(state => state.drafts[key]?.prompt ?? ''), persistenceIssue = useLauncherState(state => state.persistenceIssue)
  const [notice, setNotice] = useState<string | null>(null), edits = useRef(0)
  const source = useRef({ key, active }); source.current = { key, active }
  const lifetime = useRef({})
  useEffect(() => { lifetime.current = {}; return () => { lifetime.current = {} } }, [key, active])
  const submission = useRef<{ operationId: string; prompt: string; revision: number; lifetime: object; released?: boolean; landed?: boolean } | null>(null)
  const automaticSettling = useRef<string | null>(null), automaticRevision = useRef(edits.current)
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
  async function releaseDraft(query: { operationId: string; prompt: string }) {
    const original = submission.current
    if (!original || original.operationId !== query.operationId || original.prompt !== query.prompt || source.current.key !== key ||
      edits.current !== original.revision || original.lifetime !== lifetime.current || useLauncherState.getState().drafts[key]?.prompt !== original.prompt) return
    // The existing creation reference now durably holds this caller's text; later
    // draft edits have their own custody and must never be cleared by its receipt.
    if (!useLauncherState.getState().setDraft(key, 'prompt', '')) return
    original.released = true
    try { await checkpointLauncherState() }
    catch {
      if (useLauncherState.getState().drafts[key]?.prompt === '') useLauncherState.getState().setDraft(key, 'prompt', original.prompt)
      original.released = false
      setNotice('原问题已保留，输入框的保存尚未确认。')
    }
  }
  // A remounted view can inspect an old admission, but may never clear this view's new draft from it.
  async function confirmed(result: MoteMainActionResult, query: { operationId: string; prompt: string }, mayNavigate: () => boolean) {
    const original = submission.current, canonical = result.record?.moteMain?.deferredInput
    const outcome = agentPromptSubmissionOutcome(result.deferredInput?.record ?? null)
    const current = () => source.current.key === key && source.current.active && edits.current === original?.revision && original?.lifetime === lifetime.current
    if (!original || original.landed || query.operationId !== original.operationId || canonical?.operationId !== original.operationId || canonical.prompt !== original.prompt ||
      query.prompt !== original.prompt || !['admitted', 'terminal-confirmed'].includes(outcome) || !current() ||
      useLauncherState.getState().drafts[key]?.prompt !== (original.released ? '' : original.prompt) || !result.reference) return
    const saved = original.released || useLauncherState.getState().setDraft(key, 'prompt', '')
    if (!saved || useLauncherState.getState().persistenceIssue) {
      if (current() && !useLauncherState.getState().drafts[key]?.prompt) useLauncherState.getState().setDraft(key, 'prompt', original.prompt)
      setNotice('原消息已确认投递；草稿保存尚未确认，原文保留。'); return
    }
    const fresh = await readMoteMainAction(scope).catch(() => null)
    if (current() && !original.landed && mayNavigate() && fresh && JSON.stringify(fresh.dialogue.main.current) === JSON.stringify(result.reference)) {
      original.landed = true; onOpenMain(result.reference)
    }
  }
  async function confirmAutomatic(result: MoteMainActionResult, mayNavigate: () => boolean) {
    if (!automatic || automaticSettling.current === automatic.query.operationId || !result.reference) return
    const canonical = result.record?.moteMain?.deferredInput, outcome = agentPromptSubmissionOutcome(result.deferredInput?.record ?? null)
    if (result.record?.requestId !== automatic.decision.creationOperationId || JSON.stringify(result.record.moteMain?.rollover) !== JSON.stringify(automatic.decision) ||
      canonical?.operationId !== automatic.query.operationId || canonical.prompt !== automatic.query.prompt || !['admitted','terminal-confirmed'].includes(outcome)) return
    automaticSettling.current = automatic.query.operationId
    try {
      const entry = useAppStore.getState().agentSteerQueues[automatic.sessionId]?.find(item => item.operationId === automatic.query.operationId)
      if (entry?.mainRollover?.creationOperationId === automatic.decision.creationOperationId && entry.text === automatic.query.prompt)
        await useAppStore.getState().archiveAgentSteer(automatic.sessionId, entry.operationId, entry.text, true)
      const fresh = await readMoteMainAction(scope)
      if (source.current.key === key && source.current.active && mayNavigate() && edits.current === automaticRevision.current && JSON.stringify(fresh.dialogue.main.current) === JSON.stringify(result.reference)) onOpenMain(result.reference)
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); automaticSettling.current = null }
  }
  return <MoteMainActions scope={scope} active={active} onConfigure={onConfigure} onRefresh={dialogue?.refresh}
    onResult={(result, mayNavigate) => { void confirmAutomatic(result, mayNavigate); if (submission.current) void confirmed(result, submission.current, mayNavigate) }}
    renderStart={state => <><AutomaticStart automatic={automatic} state={state} active={active} />
      <HeldStart held={held} state={state} active={active && !automatic && mode === 'start' && !persistenceIssue} onStart={query => {
        // The held text becomes this welcome's ordinary first message: back in the draft, then the same submit, confirm and clear.
        onHeldSettled?.(query.operationId)
        submission.current = { ...query, revision: edits.current, lifetime: lifetime.current }; setSent({ ...query, key })
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
      composer={<AgentComposer value={draft} disabled={false} active={active} placeholder="写下你想聊的事…"
        onChange={value => { edits.current++; useLauncherState.getState().setDraft(key, 'prompt', value) }}
        {...(state.ready && !state.busy && active && !persistenceIssue && !automatic && (mode === 'new' || !state.reading?.dialogue.main.current) ? { onSubmit: () => {
          const query = { operationId: mintObjectId(), prompt: draft, revision: edits.current, lifetime: lifetime.current }
          submission.current = query; setSent({ operationId: query.operationId, prompt: query.prompt, key })
          void state.submit({ operationId: query.operationId, prompt: query.prompt }, undefined, releaseDraft)
        } } : {})} />}
      notice={<>{state.issue && <p role="status">{state.issue}
        {state.reading?.preferences.status === 'ready' && !state.reading.executor && (mode === 'new' || !state.reading.dialogue.main.current)
          ? <> <button type="button" className="small-button" onClick={event => onConfigure(event.currentTarget)}>配置 Agent</button></> : null}
      </p>}{notice && <p role="status">{notice}</p>}{persistenceIssue && <p role="status">{persistenceIssue}</p>}
        {automatic && <div role="status">{automatic.decision.policy.kind === 'executor-change' ? '正在用新选择的 Executor 承接本次输入。' : '正在按此 Mote 的空闲策略承接原输入。'}<details><summary>本次输入</summary><p>{automatic.query.prompt}</p></details></div>}
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
  onStart(query: { operationId: string; prompt: string }): void }) {
  const started = useRef<string | null>(null)
  useEffect(() => {
    if (!held || !active || !state.ready || state.busy || state.reading?.dialogue.main.current || started.current === held.operationId) return
    started.current = held.operationId
    onStart({ operationId: held.operationId, prompt: held.prompt })
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
