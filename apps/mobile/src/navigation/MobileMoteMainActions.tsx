import { useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { moteQuickBaseline, parseMotePreferencesReadResult, sameMotePreferencesTarget, sameMoteQuickDefaults, type MotePreferencesTarget, type MoteQuickPreferencesReadResult } from '@agentmux/core/mote-preferences'
import { moteMainBaseline, pendingMoteMainCreation } from '@agentmux/core/spatial-graph'
import { parseMoteDialogueResult, type MoteDialoguePage, type MoteMainSetupResult } from '@agentmux/core/mote-dialogue'
import { getDeviceWorkface } from '../recovery/device-workface'
import type { MobileAgentCreateIntent } from '../recovery/agent-create-intents'
import { useMobileWebUpdateSafetyOwner } from '../mobile-web/update-safety'
import './mote-threads.css'

type Reading = { preferences: MoteQuickPreferencesReadResult; dialogue: MoteDialoguePage; pending: string | null }
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
/** Thin original-operation consumer. Creation, source recording and binding all remain Core-owned. */
export function MobileMoteMainActions({ client, target, visible, onConfigure, onBound, onOpenMain }: {
  client: AgentMuxHostedClient | null; target: MotePreferencesTarget; visible: boolean
  onConfigure(): void; onBound(): void; onOpenMain?: (() => void) | undefined
}) {
  const [reading, setReading] = useState<Reading | null>(null), [outcome, setOutcome] = useState<{ client: AgentMuxHostedClient; target: MotePreferencesTarget; value: MoteMainSetupResult } | null>(null)
  const result = outcome?.client === client && sameMotePreferencesTarget(outcome.target, target) ? outcome.value : null
  const [issue, setIssue] = useState(''), [busy, setBusy] = useState(false), [revision, refresh] = useState(0)
  const source = useRef({ client, target, visible }); source.current = { client, target, visible }
  const flight = useRef(false), owner = getDeviceWorkface()
  useMobileWebUpdateSafetyOwner(() => flight.current ? '原 Main 创建或核对仍在进行，请完成后再更新网页。' : null)
  useEffect(() => {
    if (!visible || !client?.forwardRpc) return
    let live = true
    setReading(null); setIssue('')
    const runtime = client.runtimeOwnerIdentity?.()
    void Promise.all([client.forwardRpc('space.mote.preferences.read', { kind: 'quick', target }),
      client.forwardRpc('space.mote.dialogue.read', { target, kind: 'main' }), client.forwardRpc('space.state', {})]).then(async ([raw, dialogue, spatial]) => {
      const current = client.runtimeOwnerIdentity?.()
      if (!live) return
      if (runtime?.runtimeId !== current?.runtimeId || runtime?.ownerInstanceId !== current?.ownerInstanceId) throw Error('原 Mac 归属已变化；保留原创建，刷新核对。')
      const preferences = parseMotePreferencesReadResult(raw, { kind: 'quick', target })
      const device = owner.snapshot().record
      const original = (device.agentCreates ?? []).filter(item => item.runtimeId === runtime?.runtimeId && item.deviceHostId === (device.host?.hostId ?? null) && item.input.moteMain && sameMotePreferencesTarget(item.input.moteMain.target, target)).at(-1)
      const pending = spatial.state ? pendingMoteMainCreation(spatial.state.graph, target)?.requestId ?? null : null
      const id = pending ?? original?.input.operationId
      const input = id ? { target, creation: { hostId: 'local', operationId: id } } : null
      const setup = input ? parseMoteDialogueResult('space.mote.dialogue.setup.inspect', await client.forwardRpc!('space.mote.dialogue.setup.inspect', input), input) : null
      const returned = client.runtimeOwnerIdentity?.()
      if (!live || runtime?.runtimeId !== returned?.runtimeId || runtime?.ownerInstanceId !== returned?.ownerInstanceId) return
      if (setup) setOutcome({ client, target, value: setup })
      setReading({ preferences, dialogue, pending: setup?.binding === 'unconfirmed' ? setup.operationId : null })
    }).catch(cause => { if (live) setIssue(message(cause)) })
    return () => { live = false }
  }, [client, target.spaceId, target.zoneId, target.expectedResource.hostId, target.expectedResource.workspaceId, target.expectedResource.workspacePath, visible, revision])
  const runtimeId = client?.runtimeOwnerIdentity?.()?.runtimeId, deviceHostId = owner.snapshotIdentity().host?.hostId ?? null
  const retained = (owner.snapshot().record.agentCreates ?? []).filter(item => item.runtimeId === runtimeId && item.deviceHostId === deviceHostId && item.input.moteMain && sameMotePreferencesTarget(item.input.moteMain.target, target))
  const operationId = result?.operationId ?? reading?.pending ?? retained.find(item => item.phase !== 'confirmed')?.input.operationId
  const baseline = reading && moteQuickBaseline(reading.preferences)
  const executor = reading?.preferences.choices.executors.find(item => item.id === reading.preferences.defaults?.executorId)
  const readIssue = !reading ? null : reading.preferences.status !== 'ready' || !baseline || reading.preferences.issue
    ? reading.preferences.issue ?? '原 MOTE 配置尚未确认，请刷新。'
    : reading.dialogue.main.status !== 'ready' || reading.dialogue.main.documentRevision !== (baseline.document?.revision ?? null) || !sameMoteQuickDefaults(reading.dialogue.main.current ? { conversation: reading.dialogue.main.current } : {}, baseline.defaults.conversation ? { conversation: baseline.defaults.conversation } : {})
      ? '原主角色与配置尚未确认为同一修订，请刷新。'
      : !executor ? '先配置此 Mote 的默认 Executor，再新建 Main Agent。' : null
  async function run(action: 'create' | 'inspect' | 'advance') {
    if (!client?.forwardRpc || flight.current || !visible) return
    const original = source.current, recordId = owner.recordIdentity(), runtime = client.runtimeOwnerIdentity?.()
    const current = () => source.current.client === original.client && source.current.visible && sameMotePreferencesTarget(source.current.target, target) && owner.recordIdentity() === recordId &&
      runtime?.runtimeId === client.runtimeOwnerIdentity?.()?.runtimeId && runtime?.ownerInstanceId === client.runtimeOwnerIdentity?.()?.ownerInstanceId && (owner.snapshotIdentity().host?.hostId ?? null) === deviceHostId
    flight.current = true; setBusy(true); setIssue('')
    let id = operationId, intent: MobileAgentCreateIntent | undefined
    try {
      if (!runtime?.runtimeId) throw Error('原 Mac 运行身份尚未确认；原会话与请求保留。')
      if (action === 'create') {
        if (!reading || readIssue || !baseline || !executor) throw Error(readIssue ?? '请先核对原配置。')
        const record = owner.snapshot().record
        const ownsDraft = (scope: { runtimeId: string; deviceHostId: string | null; origin: string }) => scope.runtimeId === runtime.runtimeId && scope.deviceHostId === deviceHostId && scope.origin === (record.host?.origin || record.hostUrl || location.origin)
        if ((record.moteFileDrafts ?? []).some(item => ownsDraft(item.scope) && item.scope.spaceId === target.spaceId && item.scope.path === 'MOTE.md' && item.scope.resource.hostId === target.expectedResource.hostId && item.scope.resource.workspaceId === target.expectedResource.workspaceId && item.scope.resource.workspacePath === target.expectedResource.workspacePath && (item.body !== (item.baseline?.status === 'read' ? item.baseline.content : '') || item.blockedAttemptId)) ||
          (record.moteQuickDrafts ?? []).some(item => ownsDraft(item.scope) && sameMotePreferencesTarget(item.scope.target, target) && (!sameMoteQuickDefaults(item.values, item.baseline?.defaults ?? {}) || item.blockedAttemptId))) throw Error('此 Mote 有未保存配置或待核对请求；请保全并核对后再更换 Main。')
        const state = (await client.forwardRpc('space.state', {})).state
        const pending = state && pendingMoteMainCreation(state.graph, target)
        if (pending) id = pending.requestId
        else {
          id = randomClientRequestId()
          intent = { runtimeId: runtime.runtimeId, deviceHostId, input: { operationId: id, content: { kind: 'new-agent', executorId: executor.id },
            destination: { spaceId: target.spaceId, zoneId: target.zoneId, newTab: true }, focus: false,
            moteMain: { target, baseline: moteMainBaseline(baseline), expectedRoleRevision: reading.dialogue.main.roleRevision, sourceOperationId: id + ':source', bindOperationId: id + ':bind' } }, phase: 'sending' }
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
      if (value.binding === 'confirmed') { setReading(null); onBound(); refresh(value => value + 1) }
    } catch (cause) {
      if (intent) { try { await owner.retainAgentCreate({ ...intent, phase: 'unknown' }, recordId) } catch { /* Original sending intent is retained; never create again on this failure. */ } }
      if (current()) setIssue(message(cause) + ' 原请求与会话保留；核对同一操作，不重复创建。')
    } finally { flight.current = false; if (current()) setBusy(false) }
  }
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
