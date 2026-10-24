import { MobileNotice } from '../notices/MobileNotice'
import { useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { formatSessionAddress } from '@agentmux/core/sharing'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { ClientUiPlatform } from '@agentmux/client-ui'
import { getDeviceWorkface } from '../recovery/device-workface'
import type { MobileAgentResumeIntent } from '../recovery/agent-resume-intents'
import { MobileAgentUsage } from './MobileAgentUsage'

/** Explicit actions on the persistent Agent. Reading or reconnecting never submits a recovery. */
export function MobileAgentActions({ client, agentSessionId, connected, copyText, visible = true, beforeAction }: {
  client: AgentMuxHostedClient | null; agentSessionId: string; connected: boolean
  copyText: ClientUiPlatform['copyText']; visible?: boolean; beforeAction?(): boolean
}) {
  const [notice, setNotice] = useState(''), [showLink, setShowLink] = useState(false), [busy, setBusy] = useState(false)
  const [, redraw] = useState(0)
  const flights = useRef(new Map<AgentMuxHostedClient, Set<string>>()), current = useRef({ client, agentSessionId, visible, connected })
  current.current = { client, agentSessionId, visible, connected }
  const owner = getDeviceWorkface(), record = owner.snapshot().record
  const runtimeId = client?.runtimeOwnerIdentity?.()?.runtimeId
  const pending = record.agentResumes?.find(item => item.input.agentSessionId === agentSessionId && item.phase !== 'confirmed' && item.phase !== 'superseded' &&
    item.runtimeId === runtimeId && item.deviceHostId === (record.host?.hostId ?? null))
  useEffect(() => () => { current.current.visible = false }, [])
  useEffect(() => { setNotice(''); setShowLink(false); setBusy(Boolean(client && flights.current.get(client)?.has(agentSessionId))); redraw(value => value + 1) }, [client, agentSessionId])
  const link = formatSessionAddress(agentSessionId)
  async function copy() {
    const source = { client, agentSessionId }, recordId = owner.recordIdentity()
    const unchanged = () => current.current.visible && current.current.client === source.client && current.current.agentSessionId === source.agentSessionId && owner.recordIdentity() === recordId
    try { const copied = await copyText(link, () => {}); if (!unchanged()) return; if (!copied) throw new Error('浏览器未确认复制。'); setNotice('已复制 Agent 身份链接。'); setShowLink(false) }
    catch (error) { if (!unchanged()) return; setShowLink(true); setNotice(`${error instanceof Error ? error.message : String(error)} 可选取下方原链接。`) }
  }
  async function recover(mode: 'new' | 'inspect' | 'continue') {
    if (beforeAction && !beforeAction()) return
    if (!client?.forwardRpc || !connected || !visible) return
    let flight = flights.current.get(client)
    if (!flight) { flight = new Set(); flights.current.set(client, flight) }
    if (flight.has(agentSessionId)) return
    flight.add(agentSessionId); setBusy(true)
    const original = { client, agentSessionId, visible }, recordId = owner.recordIdentity()
    const scope = { runtimeId: client.runtimeOwnerIdentity?.()?.runtimeId, deviceHostId: owner.snapshot().record.host?.hostId ?? null }
    const unchanged = () => (!beforeAction || beforeAction()) && current.current.client === original.client && current.current.agentSessionId === original.agentSessionId && current.current.visible === original.visible && current.current.connected &&
      owner.recordIdentity() === recordId && client.runtimeOwnerIdentity?.()?.runtimeId === scope.runtimeId && (owner.snapshot().record.host?.hostId ?? null) === scope.deviceHostId
    let intent: MobileAgentResumeIntent | undefined = pending
    try {
      if (!scope.runtimeId) throw new Error('原 Host 运行身份尚未确认；原对话与草稿保留。')
      const result = await client.forwardRpc('agent.inspect', { target: { kind: 'agent-session', agentSessionId } })
      if (!unchanged()) return
      if (result.session.agentSessionId !== agentSessionId) throw new Error('读取返回了另一 Agent；原记录保留，未执行恢复。')
      if (mode === 'inspect') {
        if (!intent || intent.hostId !== result.session.hostId) throw new Error('原恢复目标未确认；保留原操作。')
        const operation = result.session.continuityOperations?.[intent.input.operationId]
        if (!operation) { setNotice('Host 尚未确认此原恢复操作；原请求保留，可稍后再核对。'); return }
        if (operation.operationId !== intent.input.operationId || operation.launchInput || operation.agentSessionId !== agentSessionId || operation.previousRun.runId !== intent.input.expectedRun.runId || operation.action === 'restart') throw new Error('原恢复回执目标不同；未采用该回执。')
        if (operation.kind === 'conflict' && result.session.run.runId !== intent.input.expectedRun.runId) {
          await owner.retainAgentResume({ ...intent, phase: 'superseded' }, recordId)
          if (unchanged()) { setNotice('原 Run 已被其他操作更替，原冲突记录保留。可重新显式恢复当前 Run，不会自动重放。'); redraw(value => value + 1) }
        } else if (operation.kind === 'resumed' || operation.kind === 'reattachable') {
          await owner.retainAgentResume({ ...intent, phase: 'confirmed' }, recordId)
          if (!unchanged()) return
          setNotice(operation.kind === 'resumed' ? '原恢复启动已确认；上下文与输入就绪仍以 Core 当前状态为准。' : '原 Run 可重新接回；当前对话与草稿保留。'); redraw(value => value + 1)
        } else setNotice(`原恢复操作：${operation.kind}。${operation.error ?? operation.reason} 原操作与草稿保留。`)
        return
      }
      if (intent && mode === 'new') throw new Error('已有原恢复操作待核对；不会创建另一恢复请求。')
      if (intent && intent.hostId !== result.session.hostId) throw new Error('原恢复 Host 不同；未重新执行。')
      intent ??= { ...scope, runtimeId: scope.runtimeId, hostId: result.session.hostId, input: { agentSessionId, expectedRun: { ...result.session.run }, operationId: randomClientRequestId(), trigger: 'manual' }, phase: 'sending' }
      await owner.retainAgentResume(intent, recordId)
      if (!unchanged()) return
      const restored = await client.ensureAgentContinuity(intent.input)
      if (('session' in restored ? restored.session.agentSessionId !== agentSessionId || restored.session.hostId !== intent.hostId : restored.agentSessionId !== agentSessionId) || restored.previousRun.runId !== intent.input.expectedRun.runId) throw new Error('恢复返回了另一目标；保留原请求供核对。')
      const confirmed = restored.kind === 'resumed' || restored.kind === 'reattachable'
      const superseded = restored.kind === 'conflict' && restored.reason === 'session-run-changed'
      await owner.retainAgentResume({ ...intent, phase: confirmed ? 'confirmed' : superseded ? 'superseded' : 'unknown' }, recordId)
      if (unchanged()) setNotice(superseded ? '原 Run 已被其他操作更替，原冲突记录保留。可重新显式恢复当前 Run，不会自动重放。' : confirmed ? restored.kind === 'resumed' ? '原恢复启动已确认；上下文与输入就绪仍以 Core 当前状态为准。' : '原 Run 可重新接回；当前对话与草稿保留。' : `恢复尚未完成：${restored.kind}。原身份、请求和草稿保留，可核对原操作。`)
    } catch (error) {
      if (intent && mode !== 'inspect') { try { await owner.retainAgentResume({ ...intent, phase: 'unknown' }, recordId) } catch { /* Replacement records never accept old receipts. */ } }
      if (unchanged()) setNotice(`恢复未确认：${error instanceof Error ? error.message : String(error)}`)
    } finally { flight.delete(agentSessionId); if (!flight.size) flights.current.delete(client); if (current.current.client === client && current.current.agentSessionId === agentSessionId) { setBusy(false); redraw(value => value + 1) } }
  }
  return <div className="mobile-agent-actions">
    <button className="mobile-menu-row" onClick={() => void copy()}><SemanticIcon name="action.copy" size={18} /><span>复制 Agent 身份链接</span></button>
    {showLink && <input aria-label="Agent 身份链接" value={link} readOnly onFocus={event => event.target.select()} />}
    <MobileAgentUsage client={client} agentSessionId={agentSessionId} connected={connected} beforeRead={beforeAction} />
    <button className="mobile-menu-row" disabled={busy || !connected || !client} onClick={() => void recover(pending ? 'inspect' : 'new')}><SemanticIcon name="action.refresh" size={18} /><span>{busy ? '正在核对原会话…' : pending ? '核对原恢复操作' : '恢复原 Agent'}</span></button>
    {pending && <button className="mobile-menu-row" disabled={busy || !connected || !client} onClick={() => void recover('continue')}><span>继续同一恢复操作</span></button>}
    {notice && <MobileNotice kind="feedback" owner={client} identity={[agentSessionId,pending?.input.operationId,notice]} className="mobile-spatial-notice" role="status">{notice}</MobileNotice>}
  </div>
}
