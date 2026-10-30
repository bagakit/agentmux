import { useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import { AgentComposer, ClientUiProvider, expandSemanticReferences } from '@agentmux/client-ui'
import { MoteConversationStart, MoteConversationHistory, type MoteConversationHistoryItem } from '@agentmux/client-ui/components/MoteConversationStart'
import { agentPromptSubmissionOutcome, type MoteDialogueLink, type MoteMainSetupResult, type MoteMainRolloverDecision } from '@agentmux/core/mote-dialogue'
import { deriveObjectId } from '@agentmux/core/object-id'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import type { MoteDefaultConversation, MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { createLocalDrafts } from '../conversation/local-drafts'
import { getDeviceWorkface } from '../recovery/device-workface'
import type { MobileObjectIdentity } from './MobileIdentity'
import { MobileMoteStartPortrait } from './MobileMoteStartPortrait'
import { MobileMoteMainActions, type MobileMoteMainStartState, type MobileMoteStartQuery } from './MobileMoteMainActions'
import type { MobileMoteDialogue } from '../conversation/MobileMoteConversation'
import { useMobileWebUpdateSafetyOwner } from '../mobile-web/update-safety'
import brandIcon from '../assets/dragon.png'

type AutomaticQuery = import('../conversation/mote-main-input').MobileMoteRolloverQuery
function AutomaticStart({ state, query, begin }: { state: MobileMoteMainStartState; query: AutomaticQuery | undefined; begin(state: MobileMoteMainStartState, query: AutomaticQuery): void }) {
  const consumed = useRef<string | null>(null)
  useEffect(() => {
    if (query && state.ready && !state.busy && consumed.current !== query.decision.queryOperationId) {
      consumed.current = query.decision.queryOperationId; begin(state, query)
    }
  }, [query, state.ready, state.busy, begin])
  return null
}

type Source = Extract<MoteDialogueLink, { kind: 'main' }>
/** Device draft address only. It never identifies a Session or grants a launch. */
export function mobileMoteStartDraftKey(client: AgentMuxHostedClient | null, target: MotePreferencesTarget) {
  const owner = getDeviceWorkface(), record = owner.snapshotIdentity()
  return JSON.stringify(['mote-main-start', deriveObjectId('mobile-mote-main-draft', JSON.stringify([record.host?.origin || location.origin,
    client?.runtimeOwnerIdentity?.()?.runtimeId ?? null, record.host?.hostId ?? null, target.spaceId, target.zoneId,
    target.expectedResource.hostId, target.expectedResource.workspaceId, target.expectedResource.workspacePath]))])
}
export function mobileMoteStartHistory(links: readonly MoteDialogueLink[], memberName?: (reference: MoteDefaultConversation) => string | undefined): { item: MoteConversationHistoryItem; source: Source }[] {
  const periods = new Map<string, { item: MoteConversationHistoryItem; source: Source }>()
  for (const source of links) if (source.kind === 'main') {
    const id = source.period?.id ?? JSON.stringify(['legacy-main', source.roleRevision, source.operationId])
    if (!periods.has(id)) periods.set(id, { source, item: { id, title: '主对话', author: memberName?.(source.reference),
      period: source.period, sourceIssue: source.period?.range.kind === 'unconfirmed' ? source.period.range.issue : undefined } })
  }
  return [...periods.values()]
}

/** Welcome is a view over the existing Device draft and Core setup intent, never a new input queue. */
export function MobileMoteConversationStart({ client, target, identity, platform, visible, mode = 'start', dialogue, onConfigure, onBound, onOpenMain, onOpenPeriod, automatic, onAutomaticConsumed, memberName }: {
  client: AgentMuxHostedClient | null; target: MotePreferencesTarget; identity: MobileObjectIdentity; platform: ClientUiPlatform; visible: boolean
  memberName?: ((reference: MoteDefaultConversation) => string | undefined) | undefined
  automatic?: AutomaticQuery | undefined; onAutomaticConsumed?(operationId: string): void
  mode?: 'start' | 'new'; dialogue: MobileMoteDialogue; onConfigure(): void; onBound(): void
  onOpenMain(reference: MoteDefaultConversation): void; onOpenPeriod(source: Source): void
}) {
  const [local] = useState(createLocalDrafts), [, redraw] = useState(0), [notice, setNotice] = useState(''), [starting, setStarting] = useState(false), submitting = useRef(false)
  const key = mobileMoteStartDraftKey(client, target), draft = local.drafts.get(key) ?? '', edits = useRef(0)
  const owner = getDeviceWorkface(), recordId = owner.recordIdentity(), source = useRef({ client, key, visible, recordId })
  source.current = { client, key, visible, recordId }
  const submission = useRef<{ operationId: string; prompt: string; raw: string; confirm?: AutomaticQuery['confirm'] | undefined; ownsDraft: boolean; revision: number; source: typeof source.current } | null>(null)
  useMobileWebUpdateSafetyOwner(() => local.hasUnconfirmedSave || local.saveIssue ? '本次主对话草稿尚未确认保存；请保全后再更新网页。' : null)
  const history = mobileMoteStartHistory(dialogue.page?.links ?? [], memberName)
  async function confirmed(result: MoteMainSetupResult, query: { operationId: string; prompt: string }) {
    const original = submission.current, intent = result.record?.moteMain?.deferredInput
    const outcome = agentPromptSubmissionOutcome(result.deferredInput?.record ?? null)
    if (!original || original.operationId !== query.operationId || intent?.operationId !== original.operationId || intent.prompt !== original.prompt ||
      query.prompt !== original.prompt || (outcome !== 'admitted' && outcome !== 'terminal-confirmed') || !result.reference) return
    if (source.current.client !== original.source.client || source.current.key !== original.source.key || owner.recordIdentity() !== original.source.recordId || mobileMoteStartDraftKey(original.source.client, target) !== original.source.key) return
    await original.confirm?.(result)
    if (!original.ownsDraft) return
    const current = () => source.current.client === original.source.client && source.current.key === original.source.key && source.current.visible &&
      source.current.recordId === original.source.recordId && owner.recordIdentity() === original.source.recordId && edits.current === original.revision
    if (!current() || local.drafts.get(original.source.key) !== original.raw) return
    local.drafts.set(original.source.key, ''); redraw(value => value + 1)
    const saved = await local.save()
    if (!saved) {
      if (current() && local.drafts.get(original.source.key) === '') { local.drafts.set(original.source.key, original.raw); redraw(value => value + 1) }
      setNotice('原首条消息已确认投递；设备清稿回执未确认，本页原稿保留。'); return
    }
    if (current()) onOpenMain(result.reference)
  }
  async function begin(state: MobileMoteMainStartState, automaticQuery?: AutomaticQuery) {
    if (submitting.current) return
    const raw = automaticQuery?.draft ?? draft, prompt = automaticQuery?.prompt ?? expandSemanticReferences(raw)
    if (!prompt.trim()) return
    const wasEmpty = !local.drafts.get(key)
    if (automaticQuery && wasEmpty) { local.drafts.set(key, raw); redraw(value => value + 1) }
    const original = { operationId: automaticQuery?.decision.queryOperationId ?? randomClientRequestId(), prompt, raw,
      confirm: automaticQuery?.confirm, ownsDraft: !automaticQuery || wasEmpty, revision: edits.current, source: { ...source.current } }
    const query: MobileMoteStartQuery = { operationId: original.operationId, prompt, ...(automaticQuery ? { rollover: automaticQuery.decision } : {}) }
    submission.current = original; submitting.current = true; setStarting(true)
    try {
      if (!await local.save()) { setNotice('设备尚未确认保存本次草稿；原文保留，可复制后重新核对。'); return }
      if (source.current.client !== original.source.client || source.current.key !== original.source.key || !source.current.visible || owner.recordIdentity() !== original.source.recordId) return
      await state.submit(query)
    } finally {
      submitting.current = false
      if (source.current.key === original.source.key && source.current.visible) setStarting(false)
      if (automaticQuery) onAutomaticConsumed?.(automaticQuery.decision.queryOperationId)
    }
  }
  return <MobileMoteMainActions client={client} target={target} visible={visible} onConfigure={onConfigure} onBound={onBound} onQueryResult={(value, query) => { void confirmed(value, query) }}
    renderStart={state => <ClientUiProvider platform={platform}><MoteConversationStart name={identity.mote?.name ?? identity.name}
      mode={state.reading?.dialogue.main.status === 'ready' && state.reading.preferences.status === 'ready' ? mode : 'unconfirmed'} active={visible}
      portrait={<MobileMoteStartPortrait identity={identity} client={client} visible={visible} />}
      brand={<img src={brandIcon} alt="" />}
      composer={<AgentComposer value={draft} disabled={false} active={visible} placeholder="写下你想聊的事…"
        onChange={body => { edits.current++; local.drafts.set(key, body); redraw(value => value + 1); void local.save().then(() => redraw(value => value + 1)) }}
        {...(state.ready && !state.busy && !starting && visible && (mode === 'new' || !state.reading?.dialogue.main.current) ? { onSubmit: () => { void begin(state) } } : {})} />}
      notice={<>
        <AutomaticStart state={state} query={automatic} begin={(value, query) => { void begin(value, query) }} />
        {state.issue && <p role="status">本次开始尚未确认；原稿与请求保留。展开配置可核对来源或选择默认 Executor。</p>}{notice && <p role="status">{notice}</p>}
        {mode === 'start' && state.reading?.dialogue.main.current && <p role="status">已有主对话可继续；这份草稿保留，可展开打开主对话，或明确选择新一轮。</p>}
        {state.busy && <p role="status">正在核对这次原开始请求…</p>}
        {state.result && <p role="status">{agentPromptSubmissionOutcome(state.result.deferredInput?.record ?? null) === 'admitted' || agentPromptSubmissionOutcome(state.result.deferredInput?.record ?? null) === 'terminal-confirmed'
          ? '原首条消息已确认投递。' : state.result.issue ?? '原开始意图已保留；绑定和首条消息分别核对，不重复发送。'}</p>}
        {local.notice && <p role="status">本机草稿保存尚未确认；当前原文保留，可展开复制。</p>}
        <details className="mobile-mote-start-details"><summary>配置与原请求{state.pending.length ? ` · ${state.pending.length}` : ''}</summary>
        {state.issue && <p>{state.issue}</p>}{local.notice && <p>{local.notice}</p>}
        {state.result?.record?.moteMain?.deferredInput && <details><summary>原首条消息</summary><pre>{state.result.record.moteMain.deferredInput.prompt}</pre></details>}
        {state.pending.map(id => <div key={id}><button type="button" disabled={state.busy} onClick={() => state.inspect(id)}>核对原开始请求</button>
          <button type="button" disabled={state.busy} onClick={() => state.advance(id)}>继续原开始请求</button><details><summary>原请求</summary><code>{id}</code></details></div>)}
        {(state.result?.reference ?? state.reading?.dialogue.main.current) && <button type="button" onClick={() => onOpenMain((state.result?.reference ?? state.reading!.dialogue.main.current)!)}>打开主对话</button>}
        <button type="button" onClick={onConfigure}>快捷配置</button><button type="button" disabled={state.busy} onClick={() => { state.refresh(); dialogue.refresh() }}>重新核对</button>
        {draft && <button type="button" onClick={() => { void platform.copyText(draft, error => setNotice(error instanceof Error ? error.message : String(error))) }}>复制本次草稿</button>}
        </details>
      </>}
      history={<MoteConversationHistory items={history.map(value => value.item)} onOpen={item => { const original = history.find(value => value.item.id === item.id); if (original) onOpenPeriod(original.source) }}
        reading={dialogue.loading} onMore={dialogue.page?.next ? () => { void dialogue.older() } : undefined} issue={dialogue.issue ? <p role="status">{dialogue.issue}</p> : undefined} />}
    /></ClientUiProvider>} />
}


/** A pending original start never covers the healthy current reader or Composer. */
export function MobileMoteStartRecovery({ client, target, visible, onConfigure, onBound, onOpenMain }: {
  client: AgentMuxHostedClient | null; target: MotePreferencesTarget; visible: boolean; onConfigure(): void; onBound(): void
  onOpenMain(reference: MoteDefaultConversation): void
}) {
  return <MobileMoteMainActions client={client} target={target} visible={visible} onConfigure={onConfigure} onBound={onBound}
    renderStart={state => !state.pending.length ? null : <details className="mobile-mote-start-details"><summary>原开始请求待核对 · {state.pending.length}</summary>
      <p>当前对话与草稿仍可使用。这里仅核对原开始意图，不会新建另一条 Query。</p>
      {state.issue && <p>{state.issue}</p>}{state.result?.issue && <p>{state.result.issue}</p>}
      {state.result?.record?.moteMain?.deferredInput && <details><summary>原首条消息</summary><pre>{state.result.record.moteMain.deferredInput.prompt}</pre></details>}
      {state.pending.map(id => <div key={id}><button type="button" disabled={state.busy} onClick={() => state.inspect(id)}>核对原开始请求</button>
        <button type="button" disabled={state.busy} onClick={() => state.advance(id)}>继续原开始请求</button></div>)}
      {state.result?.reference && <button type="button" onClick={() => onOpenMain(state.result!.reference!)}>打开原主对话</button>}
    </details>} />
}
