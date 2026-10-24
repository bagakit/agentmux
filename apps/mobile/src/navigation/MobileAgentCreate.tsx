import { MobileNotice } from '../notices/MobileNotice'
import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { ClientUiPlatform } from '@agentmux/client-ui'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxRpcResult } from '@agentmux/core'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { getDeviceWorkface } from '../recovery/device-workface'
import type { MobileAgentCreateIntent } from '../recovery/agent-create-intents'

export type MobileAgentCreateTarget =
  | { spaceId?: string; zoneId?: string; tabId?: never; regionId?: never }
  | { spaceId: string; zoneId: string; tabId: string; regionId: string }
/** One explicit form calls the original spatial creator. Unknown operations are inspected, never replayed. */
export function MobileAgentCreate({ client, connected, visible, target, platform, onClose, openSession }: {
  client: AgentMuxHostedClient | null; connected: boolean; visible: boolean; target: MobileAgentCreateTarget
  platform: ClientUiPlatform; onClose(): void; openSession(id: string): void
}) {
  const [discovery, setDiscovery] = useState<{ client: AgentMuxHostedClient; catalog: AgentMuxRpcResult<'space.ls'>['catalog'] | null; executors: AgentMuxRpcResult<'settings.executors.ls'>['items'] } | null>(null)
  const catalog = discovery?.client === client ? discovery?.catalog : null
  const executors = discovery?.client === client ? discovery?.executors ?? [] : []
  const [spaceId, setSpace] = useState(''), [zoneId, setZone] = useState(''), [executorId, setExecutor] = useState(''), [prompt, setPrompt] = useState('')
  const [issue, setIssue] = useState(''), [, redraw] = useState(0)
  const launcher = target.tabId !== undefined && target.regionId !== undefined
  const targetKey = JSON.stringify([target.spaceId, target.zoneId, target.tabId, target.regionId, spaceId, zoneId])
  const original = useRef({ client, visible, connected, targetKey }), flights = useRef(new Set<object>())
  if (original.current.client !== client || original.current.visible !== visible || original.current.connected !== connected || original.current.targetKey !== targetKey) original.current = { client, visible, connected, targetKey }
  const form = original.current, busy = flights.current.has(form)
  const owner = getDeviceWorkface(), record = owner.snapshot().record
  const runtimeId = client?.runtimeOwnerIdentity?.()?.runtimeId, deviceHostId = record.host?.hostId ?? null
  const intents = (record.agentCreates ?? []).filter(item => item.runtimeId === runtimeId && item.deviceHostId === deviceHostId)
  const pending = intents.find(item => item.phase !== 'confirmed')
  useEffect(() => {
    if (!visible || !client?.forwardRpc || !connected) return
    let live = true
    setDiscovery(null); setIssue('')
    setSpace(target.spaceId ?? ''); setZone(target.zoneId ?? '')
    void Promise.allSettled([client.forwardRpc('space.ls', { target: {}, presentation: true }), client.forwardRpc('settings.executors.ls', {})]).then(results => {
      if (!live) return
      const [spaces, resources] = results
      setDiscovery({ client, catalog: spaces.status === 'fulfilled' ? spaces.value.catalog : null, executors: resources.status === 'fulfilled' ? resources.value.items : [] })
      setIssue([...(resources.status === 'fulfilled' ? resources.value.issues?.map(issue => `${issue.id}: ${issue.message}`) ?? [] : []), ...results.flatMap(result => result.status === 'rejected' ? [String(result.reason instanceof Error ? result.reason.message : result.reason)] : [])].join('\n'))
    })
    return () => { live = false }
  }, [client, connected, visible, target.spaceId, target.zoneId, target.tabId, target.regionId])
  const boundZones = catalog?.zones.filter(zone => catalog.bindings.some(binding => binding.spaceId === spaceId && binding.zoneId === zone.zoneId)) ?? []
  const targetTab = catalog?.tabs.find(tab => tab.tabId === target.tabId)
  async function run(inspect: MobileAgentCreateIntent | null) {
    if (!client?.forwardRpc || !connected || !visible || flights.current.has(form)) return
    flights.current.add(form); redraw(value => value + 1)
    const source = client, recordId = owner.recordIdentity(), scope = { runtimeId, deviceHostId }
    const current = () => original.current === form && owner.recordIdentity() === recordId &&
      source.runtimeOwnerIdentity?.()?.runtimeId === scope.runtimeId && (owner.snapshot().record.host?.hostId ?? null) === scope.deviceHostId
    let intent = inspect
    try {
      if (!scope.runtimeId) throw new Error('原 Host 运行身份未确认；原创建信息保留。')
      if (!intent) {
        if (!catalog?.spaces.some(space => space.spaceId === spaceId) || !boundZones.some(zone => zone.zoneId === zoneId) || !executors.some(executor => executor.id === executorId)) throw new Error('请明确选择原空间、Zone 与 Executor。')
        intent = { runtimeId: scope.runtimeId, deviceHostId: scope.deviceHostId,
          input: { operationId: randomClientRequestId(), content: { kind: 'new-agent', executorId, ...(prompt ? { prompt } : {}) },
            destination: launcher ? { spaceId: target.spaceId!, zoneId: target.zoneId!, tabId: target.tabId!, regionId: target.regionId! } : { spaceId, zoneId, newTab: true }, focus: false }, phase: 'sending' }
        await owner.retainAgentCreate(intent, recordId)
        if (!current()) return
      }
      const report = inspect ? (await source.forwardRpc!('space.inspect', { target: { operationId: intent.input.operationId } })).request?.report
        : await source.forwardRpc!('agent.open', intent.input)
      if (!report || report.operationId !== intent.input.operationId) throw new Error('原创建回执尚未确认，保留原操作供核对。')
      if (report.agent && (report.agent.executorId !== intent.input.content.executorId || report.agent.createOperationId !== intent.input.operationId)) throw new Error('回执绑定了另一创建操作；未采用该 Agent。')
      const confirmed = report.outcome === 'opened' && report.agent !== null && report.save.diskDurability === 'confirmed'
      await owner.retainAgentCreate({ ...intent, phase: confirmed ? 'confirmed' : 'unknown', ...(report.agent ? { agentSessionId: report.agent.agentSessionId } : {}) }, recordId)
      if (current()) setIssue(confirmed ? 'Agent 已创建。可打开原对话；初始输入与任务进展以原回执为准。' : `原创建：${report.outcome}。${report.save.diskDurability !== 'confirmed' ? '工作面持久化尚未确认。' : ''}${report.issues.map(issue => `${issue.message} ${issue.recovery}`).join('\n')} 保留原操作，可核对。`)
    } catch (error) {
      if (intent && !inspect) { try { await owner.retainAgentCreate({ ...intent, phase: 'unknown' }, recordId) } catch { /* Preserve the replacement record and original in-memory intent. */ } }
      if (current()) setIssue(error instanceof Error ? error.message : String(error))
    } finally { flights.current.delete(form); redraw(value => value + 1) }
  }
  return <Dialog.Root open={visible} onOpenChange={open => { if (!open) onClose() }}><Dialog.Portal container={platform.overlayContainer()}>
    <Dialog.Overlay className="mobile-sheet-backdrop" /><Dialog.Content className="mobile-sheet mobile-agent-create" aria-describedby="mobile-create-description">
      <div className="mobile-sheet-handle" /><div className="mobile-sheet-title"><Dialog.Title>新建 Agent</Dialog.Title><Dialog.Close className="mobile-icon-button" aria-label="关闭新建 Agent"><SemanticIcon name="action.close" size={18} /></Dialog.Close></div>
      <Dialog.Description id="mobile-create-description">{launcher ? '在选定的原启动位中创建 Agent；关闭表单不会创建。' : '选择原工作空间与执行器，在新 Tab 中开始。'}</Dialog.Description>
      {launcher && <div className="mobile-create-target"><strong>{targetTab?.name || '原空启动位'}</strong><details><summary>查看原位置</summary><dl><dt>Space</dt><dd>{target.spaceId}</dd><dt>Zone</dt><dd>{target.zoneId}</dd><dt>Tab</dt><dd>{target.tabId}</dd><dt>Region</dt><dd>{target.regionId}</dd></dl></details></div>}
      <label>空间<select aria-label="新 Agent 空间" disabled={launcher} value={spaceId} onChange={event => { setSpace(event.target.value); setZone('') }}><option value="">选择空间</option>{catalog?.spaces.map(space => <option key={space.spaceId} value={space.spaceId}>{space.name} · {space.hostId}</option>)}</select></label>
      <label>Zone<select aria-label="新 Agent Zone" disabled={launcher} value={zoneId} onChange={event => setZone(event.target.value)}><option value="">选择 Zone</option>{boundZones.map(zone => <option key={zone.zoneId} value={zone.zoneId}>{zone.branch ?? (launcher ? '原工作目录' : zone.directoryPath ?? zone.zoneId)}</option>)}</select></label>
      <label>执行器<select aria-label="新 Agent 执行器" value={executorId} onChange={event => setExecutor(event.target.value)}><option value="">选择执行器</option>{executors.map(executor => <option key={executor.id} value={executor.id}>{typeof executor.value.name === 'string' ? executor.value.name : executor.id}</option>)}</select></label>
      <label>初始指令<textarea aria-label="新 Agent 初始指令" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="可留空" /></label>
      <button className="mobile-primary" disabled={busy || !connected || !client} onClick={() => void run(null)}>{busy ? '正在核对…' : pending ? '另建 Agent（保留待核对项）' : '创建 Agent'}</button>
      {intents.filter(intent => intent.phase !== 'confirmed' || intent === intents.at(-1)).map(intent => <div className="mobile-create-receipt" key={intent.input.operationId}>
        <small>{intent.input.content.executorId} · {intent.input.destination.newTab ? '新 Tab' : catalog?.tabs.find(tab => tab.tabId === intent.input.destination.tabId)?.name || '原启动位'} · {intent.phase === 'confirmed' ? '创建已确认' : '原操作待核对'}</small>
        <details><summary>原创建位置</summary><dl><dt>Space</dt><dd>{intent.input.destination.spaceId}</dd><dt>Zone</dt><dd>{intent.input.destination.zoneId}</dd>{!intent.input.destination.newTab && <><dt>Tab</dt><dd>{intent.input.destination.tabId}</dd><dt>Region</dt><dd>{intent.input.destination.regionId}</dd></>}<dt>Operation</dt><dd>{intent.input.operationId}</dd></dl></details>
        {intent.phase !== 'confirmed' && <button className="mobile-text-button" disabled={busy || !connected} onClick={() => void run(intent)}>核对原创建操作</button>}
        {intent.agentSessionId && <button className="mobile-text-button" onClick={() => { openSession(intent.agentSessionId!); onClose() }}>打开原 Agent 对话</button>}
      </div>)}
      {issue && <MobileNotice kind="feedback" owner={client} identity={[target.spaceId,target.zoneId,target.tabId,target.regionId,pending?.input.operationId,issue]} className="mobile-spatial-notice" role="status">{issue}</MobileNotice>}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
