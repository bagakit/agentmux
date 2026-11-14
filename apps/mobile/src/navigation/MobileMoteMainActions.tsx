import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { moteQuickBaseline, parseMotePreferencesReadResult, sameMotePreferencesTarget, sameMoteQuickDefaults, type MotePreferencesTarget, type MoteQuickPreferencesReadResult } from '@agentmux/core/mote-preferences'
import { moteMainBaseline, pendingMoteMainCreation, pendingMoteMainStarts, spatialAgentOpenRecord } from '@agentmux/core/spatial-graph'
import { parseMoteDialogueResult, type MoteDialoguePage, type MoteMainSetupResult, type MoteMainRolloverDecision } from '@agentmux/core/mote-dialogue'
import { getDeviceWorkface } from '../recovery/device-workface'
import type { MobileAgentCreateIntent } from '../recovery/agent-create-intents'
import { useMobileWebUpdateSafetyOwner } from '../mobile-web/update-safety'
import './mote-threads.css'

export type MobileMoteStartQuery = { operationId: string; prompt: string; rollover?: MoteMainRolloverDecision }
export type MobileMoteMainReading = { preferences: MoteQuickPreferencesReadResult; dialogue: MoteDialoguePage; pending: string[]; creationPending: string[] }
export type MobileMoteMainStartState = { reading: MobileMoteMainReading | null; result: MoteMainSetupResult | null; issue: string | null; busy: boolean;
  checking?: boolean; ready: boolean; pending: string[]; submit(query: MobileMoteStartQuery, onRetained?: () => void | Promise<void>): Promise<void>;
  inspect(id: string): void; advance(id: string): void; refresh(): void }

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
/** Device intent custody is separate from the Core's Agent creation fact. */
function mainIntentCustodyConfirmed(intent: MobileAgentCreateIntent, setup: MoteMainSetupResult): boolean {
  if (setup.creation !== 'confirmed') return false
  const query = intent.input.moteMain?.deferredInput, main = setup.record?.moteMain, original = main?.deferredInput
  return !query || setup.record?.requestId === intent.input.operationId &&
    main !== undefined && sameMotePreferencesTarget(main.target, intent.input.moteMain!.target) &&
    original?.operationId === query.operationId && original.prompt === query.prompt
}
/** Thin original-operation consumer. Creation, source recording and binding all remain Core-owned. */
export function MobileMoteMainActions({ client, target, visible, onConfigure, onBound, onOpenMain, renderStart, onQueryResult, onResult }: {
  client: AgentMuxHostedClient | null; target: MotePreferencesTarget; visible: boolean
  onConfigure(): void; onBound(): void; onOpenMain?: (() => void) | undefined
  renderStart?: ((state: MobileMoteMainStartState) => ReactNode) | undefined
  onQueryResult?: ((result: MoteMainSetupResult, query: MobileMoteStartQuery) => void) | undefined
  onResult?: ((result: MoteMainSetupResult) => void) | undefined
}) {
  const [reading, setReading] = useState<MobileMoteMainReading | null>(null), [outcome, setOutcome] = useState<{ client: AgentMuxHostedClient; target: MotePreferencesTarget; value: MoteMainSetupResult } | null>(null)
  const result = outcome?.client === client && sameMotePreferencesTarget(outcome.target, target) ? outcome.value : null
  const [issue, setIssue] = useState(''), [busy, setBusy] = useState(false), [revision, refresh] = useState(0), [intentRevision, reloadIntents] = useState(0)
  const [checking, setChecking] = useState(false), inspection = useRef(false)
  const source = useRef({ client, target, visible }); source.current = { client, target, visible }
  const flight = useRef(false), owner = getDeviceWorkface()
  useMobileWebUpdateSafetyOwner(() => flight.current ? '主 Agent 设置还在进行，请完成后再更新网页。' : null)
  useEffect(() => { setIssue('') }, [client, target.spaceId, target.zoneId, target.expectedResource.hostId, target.expectedResource.workspaceId, target.expectedResource.workspacePath])
  useEffect(() => {
    if (!visible || !client?.forwardRpc) return
    let live = true
    setReading(null)
    const runtime = client.runtimeOwnerIdentity?.(), recordId = owner.recordIdentity()
    void Promise.all([client.forwardRpc('space.mote.preferences.read', { kind: 'quick', target }),
      client.forwardRpc('space.mote.dialogue.read', { target, kind: 'main' }), client.forwardRpc('space.state', {})]).then(async ([raw, dialogue, spatial]) => {
      const current = client.runtimeOwnerIdentity?.()
      if (!live) return
      if (runtime?.runtimeId !== current?.runtimeId || runtime?.ownerInstanceId !== current?.ownerInstanceId) throw Error('Mac 连接已变化，请刷新后核对。')
      const preferences = parseMotePreferencesReadResult(raw, { kind: 'quick', target })
      const page = parseMoteDialogueResult('space.mote.dialogue.read', dialogue, { target, kind: 'main' })
      const device = owner.snapshot().record
      const original = (device.agentCreates ?? []).filter(item => item.runtimeId === runtime?.runtimeId && item.deviceHostId === (device.host?.hostId ?? null) && item.input.moteMain && sameMotePreferencesTarget(item.input.moteMain.target, target) && item.phase !== 'confirmed')
      const unfinished = spatial.state ? pendingMoteMainCreation(spatial.state.graph, target, page.main.roleRevision) : null
      const starts = spatial.state ? pendingMoteMainStarts(spatial.state.graph, target) : []
      const pending = [...new Set([...starts.map(item => item.requestId), ...(unfinished ? [unfinished.requestId] : []), ...original.map(item => item.input.operationId), ...(result ? [result.operationId] : [])])]
      const id = pending.length === 1 ? pending[0] : undefined
      const input = id ? { target, creation: { hostId: 'local', operationId: id } } : null
      const setup = input ? parseMoteDialogueResult('space.mote.dialogue.setup.inspect', await client.forwardRpc!('space.mote.dialogue.setup.inspect', input), input) : null
      const returned = client.runtimeOwnerIdentity?.()
      if (!live || runtime?.runtimeId !== returned?.runtimeId || runtime?.ownerInstanceId !== returned?.ownerInstanceId) return
      const local = original.find(item => item.input.operationId === setup?.operationId)
      if (setup && local && owner.recordIdentity() === recordId) {
        await owner.retainAgentCreate({ ...local, phase: mainIntentCustodyConfirmed(local, setup) ? 'confirmed' : 'unknown', ...(setup.reference ? { agentSessionId: setup.reference.sessionId } : {}) }, recordId)
      }
      if (!live || owner.recordIdentity() !== recordId) return
      if (setup) { setOutcome({ client, target, value: setup }); onResult?.(setup) }
      const corePending = new Set([...starts.map(item => item.requestId), ...(unfinished ? [unfinished.requestId] : [])])
      const settled = setup && (local ? mainIntentCustodyConfirmed(local, setup) : setup.creation === 'confirmed')
      // A retained first question is not another pending Agent creation. Only
      // original operations that can still claim this exact role fence conflict.
      const creationPending = [...new Set([...(unfinished ? [unfinished.requestId] : []), ...original.filter(item => {
        if (item.input.moteMain!.expectedRoleRevision !== page.main.roleRevision) return false
        if (setup?.operationId === item.input.operationId && setup.creation === 'confirmed' && setup.binding !== 'unconfirmed') return false
        const record = spatial.state && spatialAgentOpenRecord(spatial.state.graph, item.input.operationId)
        return !record?.moteMain || !sameMotePreferencesTarget(record.moteMain.target, target) || unfinished?.requestId === item.input.operationId
      }).map(item => item.input.operationId)])]
      setReading({ preferences, dialogue: page, creationPending, pending: pending.filter(id => id !== setup?.operationId || !settled || corePending.has(id)) })
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
    ? reading.preferences.issue ?? 'MOTE 配置还没确认，请刷新。'
    : reading.dialogue.main.status !== 'ready' || reading.dialogue.main.documentRevision !== (baseline.document?.revision ?? null) || !sameMoteQuickDefaults(reading.dialogue.main.current ? { conversation: reading.dialogue.main.current } : {}, baseline.defaults.conversation ? { conversation: baseline.defaults.conversation } : {})
      ? '主角色与配置的版本还没对上，请刷新。'
      : !executor ? '先配置此 Mote 的默认 Executor，再新建 Main Agent。' : null
  async function run(action: 'create' | 'advance', query?: MobileMoteStartQuery, selectedOperationId?: string, onRetained?: () => void | Promise<void>) {
    if (!client?.forwardRpc || flight.current || !visible) return
    const original = source.current, recordId = owner.recordIdentity(), runtime = client.runtimeOwnerIdentity?.()
    const current = () => source.current.client === original.client && source.current.visible && sameMotePreferencesTarget(source.current.target, target) && owner.recordIdentity() === recordId &&
      runtime?.runtimeId === client.runtimeOwnerIdentity?.()?.runtimeId && runtime?.ownerInstanceId === client.runtimeOwnerIdentity?.()?.ownerInstanceId && (owner.snapshotIdentity().host?.hostId ?? null) === deviceHostId
    flight.current = true; setBusy(true); setIssue('')
    let id = selectedOperationId ?? operationId, intent: MobileAgentCreateIntent | undefined
    try {
      if (!runtime?.runtimeId) throw Error('Mac 还没确认，请稍后重试。')
      if (action === 'create') {
        if (!reading || readIssue || !baseline || !executor) throw Error(readIssue ?? '请先核对配置。')
        if (query && !query.prompt.trim()) return
        const record = owner.snapshot().record
        const ownsDraft = (scope: { runtimeId: string; deviceHostId: string | null; origin: string }) => scope.runtimeId === runtime.runtimeId && scope.deviceHostId === deviceHostId && scope.origin === (record.host?.origin || record.hostUrl || location.origin)
        if ((record.moteFileDrafts ?? []).some(item => ownsDraft(item.scope) && item.scope.spaceId === target.spaceId && item.scope.path === 'MOTE.md' && item.scope.resource.hostId === target.expectedResource.hostId && item.scope.resource.workspaceId === target.expectedResource.workspaceId && item.scope.resource.workspacePath === target.expectedResource.workspacePath && (item.body !== (item.baseline?.status === 'read' ? item.baseline.content : '') || item.blockedAttemptId)) ||
          (record.moteQuickDrafts ?? []).some(item => ownsDraft(item.scope) && sameMotePreferencesTarget(item.scope.target, target) && (!sameMoteQuickDefaults(item.values, item.baseline?.defaults ?? {}) || item.blockedAttemptId))) throw Error('此 Mote 有未保存配置或待核对请求；请保全并核对后再更换 Main。')
        id = query?.rollover?.creationOperationId ?? randomClientRequestId()
        intent = { runtimeId: runtime.runtimeId, deviceHostId, input: { operationId: id, content: { kind: 'new-agent', executorId: executor.id },
          destination: { spaceId: target.spaceId, zoneId: target.zoneId, newTab: true }, focus: false,
          moteMain: { target, baseline: moteMainBaseline(baseline), expectedRoleRevision: reading.dialogue.main.roleRevision, sourceOperationId: id + ':source', bindOperationId: id + ':bind', ...(query ? { deferredInput: { operationId: query.operationId, prompt: query.prompt }, ...(query.rollover ? { rollover: query.rollover } : {}) } : {}), ...(baseline.defaults.conversation ? { handover: true as const } : {}) } }, phase: 'sending' }
        await owner.retainAgentCreate(intent, recordId)
        reloadIntents(value => value + 1)
        await onRetained?.()
        if (!current()) return
        // The exact device intent holds the first text before any Core read can
        // wait. A competing original admission is inspected, never replaced.
        const state = (await client.forwardRpc('space.state', {})).state
        const pending = state && pendingMoteMainCreation(state.graph, target, reading.dialogue.main.roleRevision)
        if (pending && pending.requestId !== id) throw Error('这个 Mote 有一次原开始待核对；本条问题已保留，未再次启动或发送。')
        if (!pending) await client.forwardRpc('agent.open', intent.input)
      }
      if (!id) throw Error('创建还没确认，请刷新。')
      if (!current()) return
      const input = { target, creation: { hostId: 'local', operationId: id } }
      const method = 'space.mote.dialogue.setup.advance'
      const value = parseMoteDialogueResult(method, await client.forwardRpc(method, input), input)
      const localIntent = intent ?? retained.find(item => item.input.operationId === id)
      if (localIntent) await owner.retainAgentCreate({ ...localIntent, phase: mainIntentCustodyConfirmed(localIntent, value) ? 'confirmed' : 'unknown', ...(value.reference ? { agentSessionId: value.reference.sessionId } : {}) }, recordId)
      if (!current()) return
      setOutcome({ client, target, value })
      onResult?.(value)
      if (query) onQueryResult?.(value, query)
      if (value.binding === 'confirmed') onBound()
    } catch (cause) {
      if (intent) { try { await owner.retainAgentCreate({ ...intent, phase: 'unknown' }, recordId) } catch { /* Original sending intent is retained; never create again on this failure. */ } }
      if (current()) setIssue(message(cause) + ' 可以核对这次创建，不会重复创建。')
    } finally {
      flight.current = false
      if (current()) {
        // A creation/advance attempt invalidates the previous eligibility read,
        // including a lost reply. Retire it before releasing the submit flight.
        setReading(null); refresh(value => value + 1)
        setBusy(false); reloadIntents(value => value + 1)
      }
    }
  }
  async function inspectOriginal(id: string) {
    if (!client?.forwardRpc || !visible || inspection.current) return
    const original = source.current, recordId = owner.recordIdentity(), runtime = client.runtimeOwnerIdentity?.()
    const frozen = retained.find(item => item.input.operationId === id)?.input.moteMain?.target ?? target
    const current = () => source.current.client === original.client && source.current.visible && sameMotePreferencesTarget(source.current.target, original.target) &&
      owner.recordIdentity() === recordId && runtime?.runtimeId === client.runtimeOwnerIdentity?.()?.runtimeId && runtime?.ownerInstanceId === client.runtimeOwnerIdentity?.()?.ownerInstanceId
    inspection.current = true; setChecking(true)
    try {
      const input = { target: frozen, creation: { hostId: 'local', operationId: id } }
      const value = parseMoteDialogueResult('space.mote.dialogue.setup.inspect', await client.forwardRpc('space.mote.dialogue.setup.inspect', input), input)
      if (!current()) return
      setOutcome({ client, target: frozen, value }); setIssue(value.issue ?? ''); onResult?.(value)
    } catch (cause) { if (current()) setIssue(message(cause)) }
    finally { inspection.current = false; setChecking(false) }
  }
  if (renderStart) return renderStart({ reading, result, issue: issue || readIssue, busy, checking, ready: Boolean(reading && !readIssue && !reading.creationPending.length), pending: pendingIds,
    submit: (query, retained) => run('create', query, undefined, retained), inspect: id => { void inspectOriginal(id) }, advance: id => { void run('advance', undefined, id) }, refresh: () => refresh(value => value + 1) })
  return <section className="mobile-mote-setup" aria-label="Main Agent">
    <h3>{reading?.dialogue.main.current ? '轮转 Main Agent' : '开始主对话'}</h3>
    <p>{reading?.dialogue.main.current ? '由新的主 Agent 承接同一个 Mote，已有 Agent 与对话不受影响。' : '为同一个 Mote 创建承接主对话的 Main Agent。'}</p>
    {(!reading && !issue) && <p role="status">正在核对主对话与配置…</p>}
    {readIssue && <p role="status">{readIssue}</p>}
    {issue && <p role="status">{issue}</p>}
    {retained.filter(item => pendingIds.includes(item.input.operationId) && item.input.moteMain?.deferredInput).map(item => <details key={item.input.operationId}>
      <summary>本设备保留的问题</summary><p>{item.input.moteMain!.deferredInput!.prompt}</p><p>仍按原请求核对，不会改投或重复发送。</p></details>)}
    {result && <p role="status">{result.binding === 'confirmed' ? 'Main 已绑定，可回到主对话。' : '主 Agent 已创建，绑定还没确认。'}</p>}
    {result?.issue && <p role="status">{result.issue}</p>}
    {operationId && (!result || result.binding === 'unconfirmed') ? <div><button type="button" disabled={checking} onClick={() => void inspectOriginal(operationId)}>核对主 Agent 创建</button><button type="button" disabled={busy} onClick={() => void run('advance')}>继续设置主 Agent</button></div>
      : reading && !readIssue && <button type="button" disabled={busy} onClick={() => void run('create')}>{busy ? '正在处理…' : reading.dialogue.main.current ? '新建并轮转 Main Agent' : '新建 Main Agent'}</button>}
    {result?.binding === 'confirmed' && <details><summary>本次设置请求</summary><code>{result.operationId}</code><div>
      <button type="button" disabled={checking} onClick={() => void inspectOriginal(result.operationId)}>核对主 Agent 创建</button>
      <button type="button" disabled={busy} onClick={() => void run('advance', undefined, result.operationId)}>继续设置主 Agent</button>
    </div></details>}
    {result?.binding === 'confirmed' && onOpenMain && <button type="button" onClick={onOpenMain}>打开主对话</button>}
    <button type="button" onClick={onConfigure}>配置默认 Executor</button><button type="button" disabled={busy} onClick={() => refresh(value => value + 1)}>刷新主对话配置</button>
  </section>
}
