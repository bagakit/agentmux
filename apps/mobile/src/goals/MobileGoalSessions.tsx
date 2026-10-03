import { useEffect, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentPresentation } from '@agentmux/core/control'
import type { MobileObjectIdentity } from '../navigation/MobileIdentity'

export function MobileGoalSessions({ client, sessionIds, visible, openSession }: {
  client: AgentMuxHostedClient | null; sessionIds: string[]; visible: boolean
  openSession: ((id: string, identity: MobileObjectIdentity) => void) | undefined
}) {
  const [rows, setRows] = useState<AgentMuxAgentPresentation[]>([]), [issue, setIssue] = useState('')
  const [revision, refresh] = useState(0)
  const ids = JSON.stringify(sessionIds)
  useEffect(() => {
    if (!visible || !sessionIds.length || !client?.forwardRpc) return
    let live = true, pending = false
    const read = async () => {
      if (pending) return
      pending = true
      try {
        const result = await client.forwardRpc!('space.ls', { target: {}, presentation: true })
        if (live) {
          const related = result.catalog.agentPresentation?.filter(row => sessionIds.includes(row.agentSessionId)) ?? []
          setRows(previous => sessionIds.flatMap(id => { const row = related.find(value => value.agentSessionId === id) ?? previous.find(value => value.agentSessionId === id); return row ? [row] : [] }))
          setIssue(related.length < sessionIds.length ? '部分关联 Agent 当前呈现尚未确认；已有呈现保留，仍可打开原会话。' : '')
        }
      } catch (error) { if (live) setIssue(`读取关联 Agent 呈现失败：${error instanceof Error ? error.message : String(error)}。上次呈现保留，仍可打开原会话或刷新。`) }
      finally { pending = false }
    }
    void read()
    return () => { live = false }
  }, [client, visible, ids, revision])
  return <section aria-label="关联会话"><h3>关联会话</h3>
    {issue && <p role="status">{issue}</p>}
    {sessionIds.map(id => {
      const row = rows.find(value => value.agentSessionId === id)
      const identity = { name: row?.name || 'Agent 名称未确认', project: row?.project || '项目未确认' }
      return <div key={id} className="mobile-goal-session"><strong>{identity.name}</strong><p>{identity.project}{row?.state ? ` · ${row.state}` : ''}</p>
        {row?.recap && <p>{row.recap.text}<small> · {row.recap.source}</small></p>}
        {row?.detail && <p>{row.detail}</p>}
        {openSession && <button onClick={() => openSession(id, identity)}>打开关联会话</button>}
        <details><summary>会话身份</summary><code>{id}</code>{row?.providerId && <p>{row.providerId}</p>}</details>
      </div>
    })}
    {sessionIds.length > 0 && <button onClick={() => refresh(value => value + 1)}>刷新关联会话</button>}
    {!sessionIds.length && <p>暂无关联会话。</p>}
  </section>
}
