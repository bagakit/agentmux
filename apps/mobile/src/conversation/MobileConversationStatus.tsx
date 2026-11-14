import type { AgentMuxAgentSession } from '@agentmux/core'
import type { MobileConversationClient } from './mobile-conversation-client'
import type { MobileConnection } from './use-hosted-conversation'
import type { MobileConversationMetadata } from './mobile-conversation-session'

/** Presentation of the existing Reader's facts; never another Session observer. */
export type MobileConversationStatus = {
  client: MobileConversationClient | null
  agentSessionId: string | null
  session: AgentMuxAgentSession | null
  metadata: MobileConversationMetadata
  readingIssue: string | null
  agentIssue: string | null
  connection: MobileConnection
  refresh(): Promise<unknown>
}
export function mobileConversationStatusLabel(status: MobileConversationStatus | null) {
  if (!status) return null
  if (status.connection.state !== 'connected' || status.connection.issue) return 'Mac 连接需要查看'
  if (status.metadata.issue || status.metadata.state === 'unconfirmed') return '对话信息待确认'
  if (status.readingIssue) return '对话记录读取需要重试'
  if (status.agentIssue) return 'Agent 有状态说明'
  if (status.metadata.state === 'retired') return '历史对话'
  if (status.metadata.state === 'deleted') return '对话记录已删除'
  return null
}
export function MobileConversationStatusDetails({ status, onConnection }: {
  status: MobileConversationStatus; onConnection(): void
}) {
  const historical = status.metadata.state === 'retired'
  const connectionIssue = status.connection.issue ?? (status.connection.state !== 'connected' ? status.connection.message : null)
  return <section className="mobile-session-diagnostic" data-conversation-status={status.metadata.state}>
    <h3>{historical ? '历史对话' : status.metadata.state === 'deleted' ? '对话记录已删除' : '对话状态'}</h3>
    {historical ? <p>这段对话已转入历史，内容仍可阅读。对话身份和当前草稿仍保留。</p>
      : status.metadata.state === 'deleted' ? <p>这段记录已删除。本设备保留的草稿和请求仍可查看。</p>
      : status.metadata.state === 'loading' ? <p>正在读取对话信息。</p>
      : status.metadata.state === 'unconfirmed' ? <p>暂时读不到对话信息。草稿会保留，可重新核对这段对话。</p> : null}
    {connectionIssue ? <div className="mobile-session-diagnostic__source"><h4>Mac 连接</h4><p>{status.connection.state === 'connected' ? '连接状态暂未确认，对话和草稿会保留。' : status.connection.message}</p>
      {status.connection.issue ? <details><summary>连接详情</summary><p>{connectionIssue}</p></details> : null}
      <button type="button" className="mobile-text-button" onClick={onConnection}>查看连接</button></div> : null}
    {status.readingIssue ? <div className="mobile-session-diagnostic__source"><h4>对话记录</h4><p>暂时未能更新记录，已读内容会保留。</p>
      <details><summary>读取详情</summary><p>{status.readingIssue}</p></details></div> : null}
    {status.agentIssue ? <div className="mobile-session-diagnostic__source"><h4>Agent 最近报告</h4><p>{status.agentIssue}</p></div> : null}
    {status.metadata.issue ? <details className="mobile-session-diagnostic__source"><summary>对话信息详情</summary><p>{status.metadata.issue}</p></details> : null}
    <button type="button" className="mobile-text-button" onClick={() => { void status.refresh() }}>重新读取对话</button>
    <details><summary>对话身份</summary><code>{status.agentSessionId}</code></details>
  </section>
}
