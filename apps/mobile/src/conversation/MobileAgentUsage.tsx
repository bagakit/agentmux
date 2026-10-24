import { useEffect, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession, AgentTurnUsage } from '@agentmux/core'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { MobileNotice } from '../notices/MobileNotice'

function TokenCounts({ usage }: { usage: Pick<AgentTurnUsage, 'inputTokens' | 'outputTokens' | 'totalTokens'> }) {
  return <dl>{([['输入', usage.inputTokens], ['输出', usage.outputTokens], ['合计', usage.totalTokens]] as const).map(([name, count]) =>
    <div key={name}><dt>{name}</dt><dd>{Number.isFinite(count) && count >= 0 ? count.toLocaleString() : '未上报'}</dd></div>)}</dl>
}

/** One explicit read of the original SID. No row polling, billing estimate or lifecycle action. */
export function MobileAgentUsage({ client, agentSessionId, connected, beforeRead }: { client: AgentMuxHostedClient | null; agentSessionId: string; connected: boolean; beforeRead?: (() => boolean) | undefined }) {
  const [expanded, expand] = useState(false), [revision, refresh] = useState(0)
  const [reading, setReading] = useState(false), [issue, setIssue] = useState('')
  const [observed, setObserved] = useState<{ client: AgentMuxHostedClient; agentSessionId: string; session: AgentMuxAgentSession } | null>(null)
  useEffect(() => {
    if (!expanded) return
    if (beforeRead && !beforeRead()) { setReading(false); return }
    if (!client?.forwardRpc || !connected) { setReading(false); setIssue('连接暂不可用；原消耗读数保留，可接回后刷新。'); return }
    let live = true
    setReading(true); setIssue('')
    void client.forwardRpc('agent.inspect', { target: { kind: 'agent-session', agentSessionId } }).then(result => {
      if (!live || beforeRead && !beforeRead()) return
      if (result.session.agentSessionId !== agentSessionId) throw new Error('读数返回了另一 Agent，未采用。')
      setObserved({ client, agentSessionId, session: result.session })
    }).catch(error => { if (live) setIssue(`读取消耗未完成：${error instanceof Error ? error.message : String(error)}`) })
      .finally(() => { if (live) setReading(false) })
    return () => { live = false }
  }, [client, agentSessionId, connected, expanded, revision, beforeRead])
  const session = observed?.client === client && observed.agentSessionId === agentSessionId ? observed.session : undefined
  const usage = session?.turnUsage, context = usage?.context
  const contextKnown = context && Number.isFinite(context.usedTokens) && context.usedTokens >= 0 && Number.isFinite(context.capacityTokens) && context.capacityTokens > 0
  return <section className="mobile-agent-usage">
    <button className="mobile-menu-row" aria-label="查看消耗" aria-expanded={expanded} onClick={() => expand(value => !value)}><SemanticIcon name="object.performance" size={18} /><span>查看消耗<small>上下文与原生 Token 观测</small></span><SemanticIcon name={expanded ? 'action.collapse' : 'navigation.disclosure'} size={16} /></button>
    {expanded && <div className="mobile-agent-usage__details">
      <div className="mobile-agent-usage__heading"><span>{reading ? '正在读取…' : '原生观测'}</span><button className="mobile-icon-button" aria-label="刷新消耗" onClick={() => refresh(value => value + 1)}><SemanticIcon name="action.refresh" size={16} /></button></div>
      {issue && <MobileNotice owner={client} identity={[agentSessionId, revision, issue]} role="status">{issue}</MobileNotice>}
      <h3>上下文窗口</h3><p>{contextKnown ? `${context.usedTokens.toLocaleString()} / ${context.capacityTokens.toLocaleString()} tokens` : '已用量与容量尚未上报'}</p>
      <h3>原生 Session 累计</h3>{usage?.cumulative?.scope === 'native-session' ? <TokenCounts usage={usage.cumulative} /> : <p>累计用量尚未上报</p>}
      <h3>{usage?.scope === 'response' ? '最近回复' : '最近样本 · 范围未确认'}</h3>{usage ? <TokenCounts usage={usage} /> : <p>原生样本尚未上报</p>}
      <p className="mobile-agent-usage__source">{usage ? `观测于 ${new Date(usage.observedAt).toLocaleString()}` : '暂无原生观测'}{session ? ` · Run ${session.run.runId}` : ''}。上下文不含未发送草稿；未推算费用。</p>
    </div>}
  </section>
}
