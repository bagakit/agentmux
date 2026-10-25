import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession, AgentTurnUsage } from '@agentmux/core'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { MobileNotice } from '../notices/MobileNotice'
import { getDeviceWorkface } from '../recovery/device-workface'

function UsageRow({ label, usage, missing }: { label: string; usage: Pick<AgentTurnUsage, 'inputTokens' | 'outputTokens' | 'totalTokens'> | undefined; missing: string }) {
  return <tr><th scope="row">{label}</th>{usage
    ? [usage.inputTokens, usage.outputTokens, usage.totalTokens].map((count, index) => <td key={index}>{Number.isFinite(count) && count >= 0 ? count.toLocaleString() : '未上报'}</td>)
    : <td colSpan={3}>{missing}</td>}</tr>
}

/** A visible, exact-SID read; no polling, billing estimate or lifecycle action. */
export function MobileAgentUsage({ client, agentSessionId, connected, beforeRead }: { client: AgentMuxHostedClient | null; agentSessionId: string; connected: boolean; beforeRead?: (() => boolean) | undefined }) {
  const [revision, refresh] = useState(0), [reading, setReading] = useState(false), [issue, setIssue] = useState('')
  const source = () => {
    const runtime = client?.runtimeOwnerIdentity?.(), { recordId, host } = getDeviceWorkface().snapshotIdentity()
    return JSON.stringify([runtime?.runtimeId, runtime?.ownerInstanceId, recordId, host?.hostId, host?.origin])
  }
  const scope = source(), current = useRef({ client, agentSessionId, scope, connected })
  current.current = { client, agentSessionId, scope, connected }
  const [, updateSnapshot] = useState(0)
  const [observed, setObserved] = useState<{ client: AgentMuxHostedClient; agentSessionId: string; scope: string; session: AgentMuxAgentSession } | null>(null)
  let cached: AgentMuxAgentSession | undefined
  try { const value = client?.agentSession(agentSessionId); if (value?.agentSessionId === agentSessionId) cached = value } catch { /* Metadata may not have hydrated; the original public read remains available. */ }
  const remote = observed && observed.client === client && observed.agentSessionId === agentSessionId && observed.scope === scope &&
    (!cached || observed.session.hostId === cached.hostId && observed.session.run.runId === cached.run.runId) ? observed.session : undefined
  const session = cached?.turnUsage && (!remote?.turnUsage || cached.turnUsage.observedAt > remote.turnUsage.observedAt) ? cached : remote ?? cached
  useEffect(() => client?.onEvent(event => {
    if (event.type === 'agent-session' && event.session.agentSessionId === agentSessionId) updateSnapshot(value => value + 1)
  }), [client, agentSessionId])
  useEffect(() => {
    if (beforeRead && !beforeRead()) { setReading(false); return }
    if (!client?.forwardRpc || !connected) { setReading(false); setIssue('连接暂不可用；原消耗读数保留，可接回后刷新。'); return }
    let live = true
    const originalScope = scope, originalHost = cached?.hostId
    const unchanged = () => live && current.current.client === client && current.current.agentSessionId === agentSessionId &&
      current.current.connected && source() === originalScope && (!beforeRead || beforeRead())
    const runtime = client.runtimeOwnerIdentity?.()
    const fence = runtime?.runtimeId && runtime.ownerInstanceId ? { runtimeId: runtime.runtimeId, ownerInstanceId: runtime.ownerInstanceId } : undefined
    setReading(true); setIssue('')
    void client.forwardRpc('agent.inspect', { target: { kind: 'agent-session', agentSessionId } }, {}, fence).then(result => {
      if (!unchanged()) return
      if (result.session.agentSessionId !== agentSessionId || originalHost && result.session.hostId !== originalHost) throw new Error('读数返回了另一 Agent 或 Host，未采用。')
      let latest: AgentMuxAgentSession | undefined
      try { latest = client.agentSession(agentSessionId) } catch { /* Missing metadata does not invalidate the exact original public read. */ }
      if (latest && (latest.hostId !== result.session.hostId || latest.run.runId !== result.session.run.runId)) throw new Error('原会话已更新，未采用旧 Host 或 Run 的读数。')
      setObserved({ client, agentSessionId, scope: originalScope, session: result.session })
    }).catch(error => { if (unchanged()) setIssue(`读取消耗未完成：${error instanceof Error ? error.message : String(error)}`) })
      .finally(() => { if (live) setReading(false) })
    return () => { live = false }
  }, [client, agentSessionId, connected, scope, revision, beforeRead])
  const usage = session?.turnUsage, context = usage?.context
  const contextKnown = context && Number.isFinite(context.usedTokens) && context.usedTokens >= 0 && Number.isFinite(context.capacityTokens) && context.capacityTokens > 0
  return <section className="mobile-agent-usage" aria-label="Agent 消耗">
    <div className="mobile-agent-usage__heading"><h3>消耗</h3><span role="status">{reading ? '正在核对…' : usage ? '原生观测' : '尚无观测'}</span><IconButton className="mobile-icon-button" aria-label="刷新消耗" onClick={() => refresh(value => value + 1)}><SemanticIcon name="action.refresh" size={15} /></IconButton></div>
    {issue && <MobileNotice owner={client} identity={[agentSessionId, scope, revision, issue]} role="status">{issue}</MobileNotice>}
    <div className="mobile-agent-usage__context"><span>上下文窗口</span><strong>{contextKnown ? `${context.usedTokens.toLocaleString()} / ${context.capacityTokens.toLocaleString()} tokens` : '已用量与容量尚未上报'}</strong></div>
    {contextKnown && <progress aria-label="上下文已用量" value={context.usedTokens} max={context.capacityTokens} />}
    <table className="mobile-agent-usage__samples" aria-label="Token 用量">
      <thead><tr><th scope="col">范围</th><th scope="col">输入</th><th scope="col">输出</th><th scope="col">合计</th></tr></thead>
      <tbody><UsageRow label="原生 Session 累计" usage={usage?.cumulative?.scope === 'native-session' ? usage.cumulative : undefined} missing="累计用量尚未上报" />
        <UsageRow label={usage?.scope === 'response' ? '最近回复' : '最近样本 · 范围未确认'} usage={usage} missing="原生样本尚未上报" /></tbody>
    </table>
    <details className="mobile-agent-usage__source"><summary>观测详情{usage ? ` · ${new Date(usage.observedAt).toLocaleTimeString()}` : ''}</summary><p>{usage ? `观测于 ${new Date(usage.observedAt).toLocaleString()}` : '暂无原生观测'}{session ? ` · Run ${session.run.runId}` : ''}。上下文不含未发送草稿；未推算费用。</p></details>
  </section>
}
