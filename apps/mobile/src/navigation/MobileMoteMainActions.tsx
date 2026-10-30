import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { moteQuickBaseline, parseMotePreferencesReadResult, sameMotePreferencesTarget, sameMoteQuickDefaults, type MotePreferencesTarget, type MoteQuickPreferencesReadResult } from '@agentmux/core/mote-preferences'
import { moteMainBaseline, pendingMoteMainCreation, pendingMoteMainStarts } from '@agentmux/core/spatial-graph'
import { parseMoteDialogueResult, type MoteDialoguePage, type MoteMainSetupResult, type MoteMainRolloverDecision } from '@agentmux/core/mote-dialogue'
import { getDeviceWorkface } from '../recovery/device-workface'
import type { MobileAgentCreateIntent } from '../recovery/agent-create-intents'
import { useMobileWebUpdateSafetyOwner } from '../mobile-web/update-safety'
import './mote-threads.css'

export type MobileMoteStartQuery = { operationId: string; prompt: string; rollover?: MoteMainRolloverDecision }
export type MobileMoteMainReading = { preferences: MoteQuickPreferencesReadResult; dialogue: MoteDialoguePage; pending: string[] }
export type MobileMoteMainStartState = { reading: MobileMoteMainReading | null; result: MoteMainSetupResult | null; issue: string | null; busy: boolean;
  ready: boolean; pending: string[]; submit(query: MobileMoteStartQuery): Promise<void>; inspect(id: string): void; advance(id: string): void; refresh(): void }

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
/** Thin original-operation consumer. Creation, source recording and binding all remain Core-owned. */
export function MobileMoteMainActions({ client, target, visible, onConfigure, onBound, onOpenMain, renderStart, onQueryResult }: {
  client: AgentMuxHostedClient | null; target: MotePreferencesTarget; visible: boolean
  onConfigure(): void; onBound(): void; onOpenMain?: (() => void) | undefined
  renderStart?: ((state: MobileMoteMainStartState) => ReactNode) | undefined
  onQueryResult?: ((result: MoteMainSetupResult, query: MobileMoteStartQuery) => void) | undefined
}) {
  const [reading, setReading] = useState<MobileMoteMainReading | null>(null), [outcome, setOutcome] = useState<{ client: AgentMuxHostedClient; target: MotePreferencesTarget; value: MoteMainSetupResult } | null>(null)
  const result = outcome?.client === client && sameMotePreferencesTarget(outcome.target, target) ? outcome.value : null
  const [issue, setIssue] = useState(''), [busy, setBusy] = useState(false), [revision, refresh] = useState(0), [intentRevision, reloadIntents] = useState(0)
  const source = useRef({ client, target, visible }); source.current = { client, target, visible }
  const flight = useRef(false), owner = getDeviceWorkface()
  useMobileWebUpdateSafetyOwner(() => flight.current ? '原 Main 创建或核对仍在进行，请完成后再更新网页。' : null)
  useEffect(() => {
    if (!visible || !client?.forwardRpc) return
    let live = true
    setReading(null); setIssue('')
    const runtime = client.runtimeOwnerIdentity?.(), recordId = owner.recordIdentity()
    void Promise.all([client.forwardRpc('space.mote.preferences.read', { kind: 'quick', target }),
      client.forwardRpc('space.mote.dialogue.read', { target, kind: 'main' }), client.forwardRpc('space.state', {})]).then(async ([raw, dialogue, spatial]) => {
      const current = client.runtimeOwnerIdentity?.()
      if (!live) return
      if (runtime?.runtimeId !== current?.runtimeId || runtime?.ownerInstanceId !== current?.ownerInstanceId) throw Error('原 Mac 归属已变化；保留原创建，刷新核对。')
      const preferences = parseMotePreferencesReadResult(raw, { kind: 'quick', target })
      const device = owner.snapshot().record
      const original = (device.agentCreates ?? []).filter(item => item.runtimeId === runtime?.runtimeId && item.deviceHostId === (device.host?.hostId ?? null) && item.input.moteMain && sameMotePreferencesTarget(item.input.moteMain.target, target) && item.phase !== 'confirmed')
      const unfinished = spatial.state ? pendingMoteMainCreation(spatial.state.graph, target) : null
      const starts = spatial.state ? pendingMoteMainStarts(spatial.state.graph, target) : []
      const pending = [...new Set([...starts.map(item => item.requestId), ...(unfinished ? [unfinished.requestId] : []), ...original.map(item => item.input.operationId)])]
      const id = pending.length === 1 ? pending[0] : undefined
      const input = id ? { target, creation: { hostId: 'local', operationId: id } } : null
      const setup = input ? parseMoteDialogueResult('space.mote.dialogue.setup.inspect', await client.forwardRpc!('space.mote.dialogue.setup.inspect', input), input) : null
      const returned = client.runtimeOwnerIdentity?.()
      if (!live || runtime?.runtimeId !== returned?.runtimeId || runtime?.ownerInstanceId !== returned?.ownerInstanceId) return
      const local = original.find(item => item.input.operationId === setup?.operationId)
      if (setup && local && owner.recordIdentity() === recordId) {
        await owner.retainAgentCreate({ ...local, phase: setup.creation === 'confirmed' ? 'confirmed' : 'unknown', ...(setup.reference ? { agentSessionId: setup.reference.sessionId } : {}) }, recordId)
      }
      if (!live || owner.recordIdentity() !== recordId) return
      if (setup) setOutcome({ client, target, value: setup })
      const corePending = new Set([...starts.map(item => item.requestId), ...(unfinished ? [unfinished.requestId] : [])])
      setReading({ preferences, dialogue: parseMoteDialogueResult('space.mote.dialogue.read', dialogue, { target, kind: 'main' }), pending: pending.filter(id => id !== setup?.operationId || setup.creation !== 'confirmed' || corePending.has(id)) })
    }).catch(cause => { if (live) setIssue(message(cause)) })
    return () => { live = false }
  }, [client, target.spaceId, target.zoneId, target.expectedResource.hostId, target.expectedResource.workspaceId, target.expectedResource.workspacePath, visible, revision])
  const runtimeId = client?.runtimeOwnerIdentity?.()?.runtimeId, deviceHostId = owner.snapshotIdentity().host?.hostId ?? null
  const retained = useMemo(() => (owner.snapshot().record.agentCreates ?? []).filter(item => item.runtimeId === runtimeId && item.deviceHostId === deviceHostId && item.input.moteMain && sameMotePreferencesTarget(item.input.moteMain.target, target)),
    [owner, runtimeId, deviceHostId, target.spaceId, target.zoneId, target.expectedResource.hostId, target.expectedResource.workspaceId, target.expectedResource.workspacePath, revision, intentRevision, reading, result?.operationId])
  const pendingIds = [...new Set([...(reading?.pending ?? []), ...retained.filter(item => item.phase !== 'confirmed').map(item => item.input.operationId)])]
  const operationId = result?.operationId ?? (pendingIds.length === 1 ? pendingIds[0] : undefined)
  const baseline = reading && moteQuickBaseline(reading.preferences)
  const executor = reading?.preferences.choices.executors.find(item => item.id === reading.preferences.defaults?.executorId)
  const readIssue = !reading ? null : reading.preferences.status !== 'ready' || !baseline || reading.preferences.issue
    ? reading.preferences.issue ?? '原 MOTE 配置尚未确认，请刷新。'
    : reading.dialogue.main.status !== 'ready' || reading.dialogue.main.documentRevision !== (baseline.document?.revision ?? null) || !sameMoteQuickDefaults(reading.dialogue.main.current ? { conversation: reading.dialogue.main.current } : {}, baseline.defaults.conversation ? { conversation: baseline.defaults.conversation } : {})
      ? '原主角色与配置尚未确认为同一修订，请刷新。'
      : !executor ? '先配置此 Mote 的默认 Executor，再新建 Main Agent。' : null
  async function run(action: 'create' | 'inspect' | 'advance', query?: MobileMoteStartQuery, selectedOperationId?: string) {
    if (!client?.forwardRpc || flight.current || !visible) return
    const original = source.current, recordId = owner.recordIdentity(), runtime = client.runtimeOwnerIdentity?.()
    const current = () => source.current.client === original.client && source.current.visible && sameMotePreferencesTarget(source.current.target, target) && owner.recordIdentity() === recordId &&
      runtime?.runtimeId === client.runtimeOwnerIdentity?.()?.runtimeId && runtime?.ownerInstanceId === client.runtimeOwnerIdentity?.()?.ownerInstanceId && (owner.snapshotIdentity().host?.hostId ?? null) === deviceHostId
    flight.current = true; setBusy(true); setIssue('')
    let id = selectedOperationId ?? operationId, intent: MobileAgentCreateIntent | undefined
    try {
      if (!runtime?.runtimeId) throw Error('原 Mac 运行身份尚未确认；原会话与请求保留。')
      if (action === 'create') {
        if (!reading || readIssue || !baseline || !executor) throw Error(readIssue ?? '请先核对原配置。')
        if (query && !query.prompt.trim()) return
        const record = owner.snapshot().record
        const ownsDraft = (scope: { runtimeId: string; deviceHostId: string | null; origin: string }) => scope.runtimeId === runtime.runtimeId && scope.deviceHostId === deviceHostId && scope.origin === (record.host?.origin || record.hostUrl || location.origin)
        if ((record.moteFileDrafts ?? []).some(item => ownsDraft(item.scope) && item.scope.spaceId === target.spaceId && item.scope.path === 'MOTE.md' && item.scope.resource.hostId === target.expectedResource.hostId && item.scope.resource.workspaceId === target.expectedResource.workspaceId && item.scope.resource.workspacePath === target.expectedResource.workspacePath && (item.body !== (item.baseline?.status === 'read' ? item.baseline.content : '') || item.blockedAttemptId)) ||
          (record.moteQuickDrafts ?? []).some(item => ownsDraft(item.scope) && sameMotePreferencesTarget(item.scope.target, target) && (!sameMoteQuickDefaults(item.values, item.baseline?.defaults ?? {}) || item.blockedAttemptId))) throw Error('此 Mote 有未保存配置或待核对请求；请保全并核对后再更换 Main。')
        const state = (await client.forwardRpc('space.state', {})).state
        const pending = state && pendingMoteMainCreation(state.graph, target)
        const starts = state ? pendingMoteMainStarts(state.graph, target) : []
        if (query && (pending || starts.length)) throw Error('此 Mote 有原开始请求待核对；本次草稿保留，请明确核对原操作。')
        if (pending) id = pending.requestId
        else {
          id = query?.rollover?.creationOperationId ?? randomClientRequestId()
          intent = { runtimeId: runtime.runtimeId, deviceHostId, input: { operationId: id, content: { kind: 'new-agent', executorId: executor.id },
            destination: { spaceId: target.spaceId, zoneId: target.zoneId, newTab: true }, focus: false,
            moteMain: { target, baseline: moteMainBaseline(baseline), expectedRoleRevision: reading.dialogue.main.roleRevision, sourceOperationId: id + ':source', bindOperationId: id + ':bind', ...(query ? { deferredInput: { operationId: query.operationId, prompt: query.prompt }, ...(query.rollover ? { rollover: query.rollover } : {}), ...(baseline.defaults.conversation ? { handover: true as const } : {}) } : {}) } }, phase: 'sending' }
          await owner.retainAgentCreate(intent, recordId)
          if (!current()) return
          await client.forwardRpc('agent.open', intent.input)
        }
      }
      if (!id) throw Error('原创建操作尚未确认，请刷新。')
      if (!current()) return
      const input = { target, creation: { hostId: 'local', operationId: id } }
      const method = action === 'inspect' ? 'space.mote.dialogue.setup.inspect' : 'space.mote.dialogue.setup.advance'
      const value = parseMoteDialogueResult(method, await client.forwardRpc(method, input), input)
      const localIntent = intent ?? retained.find(item => item.input.operationId === id)
      if (localIntent) await owner.retainAgentCreate({ ...localIntent, phase: value.creation === 'confirmed' ? 'confirmed' : 'unknown', ...(value.reference ? { agentSessionId: value.reference.sessionId } : {}) }, recordId)
      if (!current()) return
      setOutcome({ client, target, value })
      if (query) onQueryResult?.(value, query)
      if (value.binding === 'confirmed') { onBound(); refresh(value => value + 1) }
    } catch (cause) {
      if (intent) { try { await owner.retainAgentCreate({ ...intent, phase: 'unknown' }, recordId) } catch { /* Original sending intent is retained; never create again on this failure. */ } }
      if (current()) setIssue(message(cause) + ' 原请求与会话保留；核对同一操作，不重复创建。')
    } finally { flight.current = false; if (current()) { setBusy(false); reloadIntents(value => value + 1) } }
  }
  if (renderStart) return renderStart({ reading, result, issue: issue || readIssue, busy, ready: Boolean(reading && !readIssue && !pendingIds.length), pending: pendingIds,
    submit: query => run('create', query), inspect: id => { void run('inspect', undefined, id) }, advance: id => { void run('advance', undefined, id) }, refresh: () => refresh(value => value + 1) })
  return <section className="mobile-mote-setup" aria-label="Main Agent">
    <h3>{reading?.dialogue.main.current ? '轮转 Main Agent' : '开始主对话'}</h3>
    <p>{reading?.dialogue.main.current ? '由新 Main 承接同一个 Mote；已有 Agent 与原对话保留。' : '为同一个 Mote 创建承接主对话的 Main Agent。'}</p>
    {(!reading && !issue) && <p role="status">正在核对原主对话与配置…</p>}
    {readIssue && <p role="status">{readIssue}</p>}
    {issue && <p role="status">{issue}</p>}
    {result && <p role="status">{result.binding === 'confirmed' ? 'Main 已绑定，可回到主对话。' : result.issue ?? '原创建已保留，主角色绑定尚未确认。'}</p>}
    {operationId && (!result || result.binding === 'unconfirmed') ? <div><button type="button" disabled={busy} onClick={() => void run('inspect')}>核对原 Main 创建</button><button type="button" disabled={busy} onClick={() => void run('advance')}>继续原 Main 设置</button></div>
      : reading && !readIssue && <button type="button" disabled={busy} onClick={() => void run('create')}>{busy ? '正在处理…' : reading.dialogue.main.current ? '新建并轮转 Main Agent' : '新建 Main Agent'}</button>}
    {result?.binding === 'confirmed' && onOpenMain && <button type="button" onClick={onOpenMain}>打开主对话</button>}
    <button type="button" onClick={onConfigure}>配置默认 Executor</button><button type="button" disabled={busy} onClick={() => refresh(value => value + 1)}>刷新主对话配置</button>
  </section>
}
