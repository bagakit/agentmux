import { useEffect, useMemo, useRef, useState } from 'react'
import { AgentComposer } from '@agentmux/client-ui/components/AgentComposer'
import { MoteConversationStart as StartScene, MoteConversationHistory, type MoteConversationHistoryItem } from '@agentmux/client-ui/components/MoteConversationStart'
import { agentPromptSubmissionOutcome, type MoteDialogueLink } from '@agentmux/core/mote-dialogue'
import { mintObjectId } from '@agentmux/core/object-id'
import type { MoteDefaultConversation } from '@agentmux/core/mote-preferences'
import { MoteMainActions, type MoteStartActions } from './MoteMainActions'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import brandArt from '../../../../brand/icon-source.png'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { useAppStore } from '../store'
import { useLauncherState } from '../lib/launcher-state'
import { useMoteDialogueView } from '../lib/mote-dialogue-view'
import { readMoteMainAction, type MoteMainActionResult } from '../lib/mote-main-action'
import type { MoteWorkfaceScope, MoteRolloverStart } from '../lib/mote-workface'
import { sessionPresentationById } from '../lib/session-presentation'

type Source = Extract<MoteDialogueLink, { kind: 'main' }>
export function desktopMoteStartHistory(links: readonly MoteDialogueLink[], roleRevision?: string | null) {
  const rows = new Map<string, { item: MoteConversationHistoryItem; source: Source }>()
  for (const source of links) if (source.kind === 'main') {
    const id = source.period?.id ?? JSON.stringify([source.roleRevision, source.operationId])
    if (!rows.has(id)) rows.set(id, { source, item: { id, title: '主对话', period: source.period,
      current: source.roleRevision === roleRevision, sourceIssue: source.period?.range.kind === 'unconfirmed' ? source.period.range.issue : undefined } })
  }
  return [...rows.values()]
}

/** The welcome uses the existing durable Launcher draft and original Main setup admission. */
export function MoteConversationStart({ scope, active, mode, onConfigure, onOpenMain, onOpenPeriod, automatic }: {
  scope: MoteWorkfaceScope; active: boolean; mode: 'start' | 'new'; onConfigure(): void
  onOpenMain(reference: MoteDefaultConversation): void; onOpenPeriod(source: Source): void
  automatic?: MoteRolloverStart | undefined
}) {
  const dialogue = useMoteDialogueView(), bindings = useAppStore(state => state.spaceZoneBindings)
  const iconTarget = useMemo(() => topicSpaceIconTarget(scope.workspace, scope.topic, bindings), [scope.workspace, scope.topic, bindings])
  const icon = useAppStore(state => iconTarget ? state.spaceObjectIcons[iconTarget.key] ?? null : null)
  const key = 'mote-main-start:' + JSON.stringify([scope.workspace.hostId, scope.workspace.id, scope.workspace.path, scope.topic.id, scope.rootPath])
  const draft = useLauncherState(state => state.drafts[key]?.prompt ?? ''), persistenceIssue = useLauncherState(state => state.persistenceIssue)
  const [notice, setNotice] = useState<string | null>(null), edits = useRef(0)
  const source = useRef({ key, active }); source.current = { key, active }
  const lifetime = useRef({})
  useEffect(() => { lifetime.current = {}; return () => { lifetime.current = {} } }, [key, active])
  const submission = useRef<{ operationId: string; prompt: string; revision: number; lifetime: object } | null>(null)
  const automaticSettling = useRef<string | null>(null), automaticRevision = useRef(edits.current)
  const sessions = useAppStore(state => state.sessions)
  const history = desktopMoteStartHistory(dialogue?.page?.links ?? [], dialogue?.page?.main.roleRevision).map(row => {
    const candidate = sessionPresentationById(sessions).get(row.source.reference.sessionId)
    const label = candidate?.kind === 'agent' && candidate.control.hostId === row.source.reference.hostId ? candidate.label : undefined
    return { ...row, item: { ...row.item, ...(label ? { title: label } : {}) } }
  })
  // A remounted view can inspect an old admission, but may never clear this view's new draft from it.
  async function confirmed(result: MoteMainActionResult, query: { operationId: string; prompt: string }, mayNavigate: () => boolean) {
    const original = submission.current, canonical = result.record?.moteMain?.deferredInput
    const outcome = agentPromptSubmissionOutcome(result.deferredInput?.record ?? null)
    const current = () => source.current.key === key && source.current.active && edits.current === original?.revision && original?.lifetime === lifetime.current
    if (!original || query.operationId !== original.operationId || canonical?.operationId !== original.operationId || canonical.prompt !== original.prompt ||
      query.prompt !== original.prompt || !['admitted', 'terminal-confirmed'].includes(outcome) || !current() ||
      useLauncherState.getState().drafts[key]?.prompt !== original.prompt || !result.reference) return
    const saved = useLauncherState.getState().setDraft(key, 'prompt', '')
    if (!saved || useLauncherState.getState().persistenceIssue) {
      if (current() && !useLauncherState.getState().drafts[key]?.prompt) useLauncherState.getState().setDraft(key, 'prompt', original.prompt)
      setNotice('原消息已确认投递；草稿保存尚未确认，原文保留。'); return
    }
    const fresh = await readMoteMainAction(scope).catch(() => null)
    if (current() && mayNavigate() && fresh && JSON.stringify(fresh.dialogue.main.current) === JSON.stringify(result.reference)) onOpenMain(result.reference)
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
    onQueryResult={(result, query, mayNavigate) => { void confirmed(result, query, mayNavigate) }}
    renderStart={state => <><AutomaticStart automatic={automatic} state={state} active={active} /><StartScene name={scope.topic.title} active={active}
      mode={state.reading && !state.reading.issue ? mode : 'unconfirmed'}
      portrait={<SpaceObjectIcon kind="mote" name={scope.topic.title} manualIcon={icon} avatarObjectKey={iconTarget?.key}
        avatarWorkspaceId={scope.workspace.id} avatarTopicId={scope.topic.id} visible={active} />}
      brand={<img src={brandArt} alt="" />}
      actions={<button type="button" className="mote-start__settings" onClick={onConfigure} aria-label="Mote 快捷配置">设置</button>}
      composer={<AgentComposer value={draft} disabled={false} active={active} placeholder="写下你想聊的事…"
        onChange={value => { edits.current++; useLauncherState.getState().setDraft(key, 'prompt', value) }}
        {...(state.ready && !state.busy && active && !persistenceIssue && !automatic ? { onSubmit: () => {
          const query = { operationId: mintObjectId(), prompt: draft, revision: edits.current, lifetime: lifetime.current }
          submission.current = query; void state.submit({ operationId: query.operationId, prompt: query.prompt })
        } } : {})} />}
      notice={<>{state.issue && <p role="status">{state.issue}</p>}{notice && <p role="status">{notice}</p>}{persistenceIssue && <p role="status">{persistenceIssue}</p>}
        {automatic && <div role="status">正在按此 Mote 的空闲策略承接原输入。<details><summary>本次输入</summary><p>{automatic.query.prompt}</p></details></div>}
        {state.busy && <p role="status">正在接通这次对话…</p>}
        <details><summary>{state.pending.length ? '原开始请求待核对' : '对话选项'}</summary>
          <button type="button" onClick={onConfigure}>快捷配置</button><button type="button" disabled={state.busy} onClick={state.refresh}>重新核对</button>
          {state.reading?.dialogue.main.current && <button type="button" onClick={() => onOpenMain(state.reading!.dialogue.main.current!)}>返回当前主对话</button>}
          {state.pending.map(id => <div key={id}><button type="button" disabled={state.busy} onClick={() => state.inspect(id)}>核对原开始请求</button><button type="button" disabled={state.busy} onClick={() => state.advance(id)}>继续原开始请求</button><code>{id}</code></div>)}
          {state.result && <p>{state.result.issue ?? '原请求已保留，绑定和消息投递分别核对。'} <code>{state.result.operationId}</code></p>}
        </details></>}
      history={<MoteConversationHistory items={history.map(row => row.item)} reading={Boolean(dialogue?.loading)} onOpen={item => {
        const row = history.find(value => value.item.id === item.id); if (row) item.current ? onOpenMain(row.source.reference) : onOpenPeriod(row.source)
      }} onMore={dialogue?.page?.next ? dialogue.older : undefined} />}
    /></>} />
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
