import { useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import { ClientUiProvider, expandSemanticReferences } from '@agentmux/client-ui'
import { MoteConversationStart, MoteConversationHistory, moteConversationHistoryRows, type MoteConversationHistorySource as Source } from '@agentmux/client-ui/components/MoteConversationStart'
import { agentPromptSubmissionOutcome, type MoteMainSetupResult, type MoteMainRolloverDecision } from '@agentmux/core/mote-dialogue'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { sameMotePreferencesTarget, type MoteDefaultConversation, type MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { useMobileLocalDrafts } from '../conversation/local-drafts-owner'
import { MobileComposerSource, mobileMoteStartDraftKey, mobileWelcomeComposerSource, useMobileMoteComposer } from '../conversation/mote-composer'
import { getDeviceWorkface } from '../recovery/device-workface'
import type { MobileObjectIdentity } from './MobileIdentity'
import { MobileMoteStartPortrait } from './MobileMoteStartPortrait'
import { MobileMoteMainActions, type MobileMoteMainStartState, type MobileMoteStartQuery } from './MobileMoteMainActions'
import type { MobileMoteDialogue } from '../conversation/MobileMoteConversation'
import { useMobileWebUpdateSafetyOwner } from '../mobile-web/update-safety'
import { BrandIcon } from '@agentmux/client-ui/components/BrandIcon'
import { MoteFirstMessage, type MoteFirstMessageStage } from '@agentmux/client-ui/components/MoteFirstMessage'
import type { AppIconId } from '@agentmux/client-ui/app-icon-catalog'

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

/** The first message's stage from the original setup receipt alone; no result yet is still sending. */
export function mobileMoteFirstMessageStage(result: MoteMainSetupResult | null, busy: boolean, operationId: string): MoteFirstMessageStage {
  const query = result?.record?.moteMain?.deferredInput
  if (!result) return busy ? 'sending' : 'unconfirmed'
  if (query?.operationId !== operationId) return 'unconfirmed'
  const outcome = agentPromptSubmissionOutcome(result.deferredInput?.record ?? null)
  return outcome === 'admitted' || outcome === 'terminal-confirmed' ? 'delivered' : 'unconfirmed'
}

/** Welcome is a view over the existing Device draft and Core setup intent, never a new input queue. */
export function MobileMoteConversationStart({ client, target, identity, platform, visible, appIcon, mode = 'start', dialogue, onConfigure, onBound, onOpenMain, onOpenPeriod, automatic, onAutomaticConsumed, memberName }: {
  client: AgentMuxHostedClient | null; target: MotePreferencesTarget; identity: MobileObjectIdentity; platform: ClientUiPlatform; visible: boolean
  appIcon?: AppIconId | undefined
  memberName?: ((reference: MoteDefaultConversation) => string | undefined) | undefined
  automatic?: AutomaticQuery | undefined; onAutomaticConsumed?(operationId: string): void
  mode?: 'start' | 'new'; dialogue: MobileMoteDialogue; onConfigure(): void; onBound(): void
  onOpenMain(reference: MoteDefaultConversation): void; onOpenPeriod(source: Source): void
}) {
  const composer = useMobileMoteComposer(), pageLocal = useMobileLocalDrafts(), local = composer?.text.local ?? pageLocal
  const [, redrawLocal] = useState(0), [notice, setNotice] = useState(''), [starting, setStarting] = useState(false), submitting = useRef(false)
  const redraw = (change: (value: number) => number) => { redrawLocal(change); composer?.text.notify() }
  // The person's message as sent, shown in place while its Main is created; it is the frozen first message, not a second queue.
  const [sent, setSent] = useState<{ operationId: string; prompt: string; raw: string; key: string } | null>(null)
  const key = composer?.text.key ?? mobileMoteStartDraftKey(client, target), draft = local.drafts.get(key) ?? '', ownEdits = useRef(0), edits = composer?.text.edits ?? ownEdits
  const owner = getDeviceWorkface(), recordId = composer?.text.recordId ?? owner.recordIdentity(), source = useRef({ client, key, visible, recordId })
  source.current = { client, key, visible, recordId }
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const submission = useRef<{ operationId: string; prompt: string; raw: string; creationOperationId?: string | undefined; confirm?: AutomaticQuery['confirm'] | undefined; ownsDraft: boolean; revision: number; source: typeof source.current; released?: boolean; landed?: boolean } | null>(null)
  useMobileWebUpdateSafetyOwner(() => local.hasUnconfirmedSave || local.saveIssue ? '本次主对话草稿尚未确认保存；请保全后再更新网页。' : null)
  const history = moteConversationHistoryRows(dialogue.page?.links ?? [], dialogue.page?.main.roleRevision, memberName)
  async function confirmed(result: MoteMainSetupResult, query: { operationId: string; prompt: string }) {
    const original = submission.current, intent = result.record?.moteMain?.deferredInput
    const outcome = agentPromptSubmissionOutcome(result.deferredInput?.record ?? null)
    if (!original || original.landed || original.operationId !== query.operationId || intent?.operationId !== original.operationId || intent.prompt !== original.prompt ||
      query.prompt !== original.prompt || (outcome !== 'admitted' && outcome !== 'terminal-confirmed') || !result.reference) return
    if (original.creationOperationId && (result.record?.requestId !== original.creationOperationId ||
        result.record.moteMain?.rollover?.creationOperationId !== original.creationOperationId)) return
    if (source.current.client !== original.source.client || source.current.key !== original.source.key || owner.recordIdentity() !== original.source.recordId || (!composer && mobileMoteStartDraftKey(original.source.client, target) !== original.source.key)) return
    await original.confirm?.(result)
    if (!original.ownsDraft) return
    const current = () => mounted.current && source.current.client === original.source.client && source.current.key === original.source.key && source.current.visible &&
      source.current.recordId === original.source.recordId && owner.recordIdentity() === original.source.recordId && edits.current === original.revision
    if (!current() || local.drafts.get(original.source.key) !== (original.released ? '' : original.raw)) return
    // Delivery is confirmed: the person lands in the Main now. Clearing the sent draft is a separate device
    // write; if it is unconfirmed the original text comes back here with a notice, but it never holds the landing.
    local.drafts.set(original.source.key, ''); redraw(value => value + 1); original.landed = true
    onOpenMain(result.reference)
    const saved = await local.save()
    if (!saved) {
      if (local.drafts.get(original.source.key) === '') { local.drafts.set(original.source.key, original.raw); redraw(value => value + 1) }
      setNotice('首条消息已送达，这台手机上的草稿还没清空。')
    }
  }
  async function begin(state: MobileMoteMainStartState, automaticQuery?: AutomaticQuery) {
    if (submitting.current) return
    const raw = automaticQuery?.draft ?? draft, prompt = automaticQuery?.prompt ?? expandSemanticReferences(raw)
    if (!prompt.trim()) return
    const wasEmpty = !local.drafts.get(key)
    const sameTextSource = automaticQuery?.textSource?.key === key && automaticQuery.textSource.recordId === recordId && local.drafts.get(key) === raw
    if (automaticQuery && wasEmpty) { local.drafts.set(key, raw); redraw(value => value + 1) }
    const original: NonNullable<typeof submission.current> = { operationId: automaticQuery?.decision.queryOperationId ?? randomClientRequestId(), prompt, raw,
      creationOperationId: automaticQuery?.decision.creationOperationId,
      confirm: automaticQuery?.confirm, ownsDraft: !automaticQuery || wasEmpty || sameTextSource, revision: edits.current, source: { ...source.current } }
    const query: MobileMoteStartQuery = { operationId: original.operationId, prompt, ...(automaticQuery ? { rollover: automaticQuery.decision } : {}) }
    submission.current = original; submitting.current = true; setStarting(true)
    if (!automaticQuery) setSent({ operationId: original.operationId, prompt, raw, key })
    try {
      if (source.current.client !== original.source.client || source.current.key !== original.source.key || !source.current.visible || owner.recordIdentity() !== original.source.recordId) return
      await state.submit(query, async () => {
        if (!original.ownsDraft || source.current.client !== original.source.client || source.current.key !== original.source.key ||
          owner.recordIdentity() !== original.source.recordId || edits.current !== original.revision || local.drafts.get(key) !== original.raw) return
        // The existing durable Device creation intent now holds the frozen first
        // text. A later draft remains independent of this original operation.
        local.drafts.set(key, ''); original.released = true; redraw(value => value + 1)
        if (!await local.save()) {
          if (local.drafts.get(key) === '') local.drafts.set(key, original.raw)
          original.released = false; redraw(value => value + 1)
          setNotice('原问题已保留，这台手机输入框的保存尚未确认。')
        }
      })
    } finally {
      submitting.current = false
      if (source.current.key === original.source.key && source.current.visible) setStarting(false)
      if (automaticQuery) onAutomaticConsumed?.(automaticQuery.decision.queryOperationId)
    }
  }
  return <MobileMoteMainActions client={client} target={target} visible={visible} onConfigure={onConfigure} onBound={onBound}
    onResult={value => { if (submission.current) void confirmed(value, submission.current) }}
    renderStart={state => <ClientUiProvider platform={platform}><MoteConversationStart name={identity.mote?.name ?? identity.name}
      mode={state.reading?.dialogue.main.status === 'ready' && state.reading.preferences.status === 'ready' ? mode : 'unconfirmed'} active={visible}
      portrait={<MobileMoteStartPortrait identity={identity} client={client} visible={visible} />}
      brand={<BrandIcon icon={appIcon} />}
      drafting={Boolean(draft.trim())}
      pending={(() => {
        const retained = owner.snapshot().record.agentCreates?.find(item => item.runtimeId === client?.runtimeOwnerIdentity?.()?.runtimeId &&
          item.input.moteMain && sameMotePreferencesTarget(item.input.moteMain.target, target) && state.pending.includes(item.input.operationId))
        const query = retained?.input.moteMain?.deferredInput
        const pending = sent?.key === key ? sent : query ? { ...query, raw: query.prompt, key } : null
        return pending ? <MoteFirstMessage messageId={'mote-first:' + pending.operationId} prompt={pending.prompt} name={identity.mote?.name ?? identity.name}
        showPrompt={draft !== pending.raw} stage={mobileMoteFirstMessageStage(state.result, state.busy || starting, pending.operationId)}
        action={state.pending.length ? { label: '核对', disabled: Boolean(state.checking), onClick: () => state.inspect(retained?.input.operationId ?? state.pending[0]!) } : { label: '核对', disabled: Boolean(state.checking), onClick: () => { state.refresh(); dialogue.refresh() } }} /> : undefined
      })()}
      composer={<MobileComposerSource sourceKey={mobileWelcomeComposerSource(mode)}
        value={draft} disabled={false} active={visible} placeholder="写下你想聊的事…"
        onChange={body => { edits.current++; local.drafts.set(key, body); redraw(value => value + 1); void local.save().then(() => redraw(value => value + 1)) }}
        {...(state.ready && !state.busy && !starting && visible && (mode === 'new' || !state.reading?.dialogue.main.current) ? { onSubmit: () => { void begin(state) } } : {})} />}
      notice={<>
        <AutomaticStart state={state} query={automatic} begin={(value, query) => { void begin(value, query) }} />
        {state.issue && <p role="status">这次开始还没确认，可以展开配置核对或选择默认执行器。</p>}{notice && <p role="status">{notice}</p>}
        {mode === 'start' && state.reading?.dialogue.main.current && <p role="status">已有主对话可继续；这份草稿保留，可展开打开主对话，或明确选择新一轮。</p>}
        {state.busy && <p role="status">正在核对这次开始…</p>}
        {state.result && <p role="status">{agentPromptSubmissionOutcome(state.result.deferredInput?.record ?? null) === 'admitted' || agentPromptSubmissionOutcome(state.result.deferredInput?.record ?? null) === 'terminal-confirmed'
          ? '首条消息已送达。' : '这次开始还在核对，不会重复发送。'}</p>}
        {state.result?.issue && <p role="status">{state.result.issue}</p>}
        {local.notice && <p role="status">这台手机还没保存草稿，可以展开复制。</p>}
        <details className="mobile-mote-start-details"><summary>配置与请求{state.pending.length ? ` · ${state.pending.length}` : ''}</summary>
        {state.issue && <p>{state.issue}</p>}{local.notice && <p>{local.notice}</p>}
        {state.result?.record?.moteMain?.deferredInput && <details><summary>首条消息</summary><pre>{state.result.record.moteMain.deferredInput.prompt}</pre></details>}
        {[...new Set([...state.pending, ...(state.result ? [state.result.operationId] : [])])].map(id => <div key={id}><button type="button" disabled={state.checking} onClick={() => state.inspect(id)}>核对这次开始</button>
          <button type="button" disabled={state.busy} onClick={() => state.advance(id)}>继续这次开始</button><details><summary>请求</summary><code>{id}</code></details></div>)}
        {(state.result?.reference ?? state.reading?.dialogue.main.current) && <button type="button" onClick={() => onOpenMain((state.result?.reference ?? state.reading!.dialogue.main.current)!)}>打开主对话</button>}
        <button type="button" onClick={onConfigure}>快捷配置</button><button type="button" disabled={state.busy} onClick={() => { state.refresh(); dialogue.refresh() }}>重新核对</button>
        {draft && <button type="button" onClick={() => { void platform.copyText(draft, error => setNotice(error instanceof Error ? error.message : String(error))) }}>复制本次草稿</button>}
        </details>
      </>}
      history={<MoteConversationHistory items={history.map(value => value.item)} onOpen={item => { const original = history.find(value => value.item.id === item.id); if (original) item.current ? onOpenMain(original.source.reference) : onOpenPeriod(original.source) }}
        reading={dialogue.loading} onMore={dialogue.page?.next ? () => { void dialogue.older() } : undefined} issue={dialogue.issue ? <p role="status">{dialogue.issue}</p> : undefined} />}
    /></ClientUiProvider>} />
}


/** A pending original start never covers the healthy current reader or Composer. */
export function MobileMoteStartRecovery({ client, target, visible, onConfigure, onBound, onOpenMain }: {
  client: AgentMuxHostedClient | null; target: MotePreferencesTarget; visible: boolean; onConfigure(): void; onBound(): void
  onOpenMain(reference: MoteDefaultConversation): void
}) {
  return <MobileMoteMainActions client={client} target={target} visible={visible} onConfigure={onConfigure} onBound={onBound}
    renderStart={state => !state.pending.length ? null : <details className="mobile-mote-start-details"><summary>开始请求待核对 · {state.pending.length}</summary>
      <p>当前对话仍可使用，这里只核对上次开始，不会另开对话。</p>
      {state.issue && <p>{state.issue}</p>}{state.result?.issue && <p>{state.result.issue}</p>}
      {state.result?.record?.moteMain?.deferredInput && <details><summary>首条消息</summary><pre>{state.result.record.moteMain.deferredInput.prompt}</pre></details>}
      {state.pending.map(id => <div key={id}><button type="button" disabled={state.busy} onClick={() => state.inspect(id)}>核对这次开始</button>
        <button type="button" disabled={state.busy} onClick={() => state.advance(id)}>继续这次开始</button></div>)}
      {state.result?.reference && <button type="button" onClick={() => onOpenMain(state.result!.reference!)}>打开主对话</button>}
    </details>} />
}
