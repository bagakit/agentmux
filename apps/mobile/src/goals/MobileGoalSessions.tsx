import { MobileNotice } from '../notices/MobileNotice'
import { useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentPresentation } from '@agentmux/core/control'
import type { AgentMuxRpcGoal } from '@agentmux/core'
import type { MobileObjectIdentity } from '../navigation/MobileIdentity'
import { getDeviceWorkface } from '../recovery/device-workface'
import { sameMobileGoalDraftScope, type MobileGoalDraftScope } from '../recovery/goal-drafts'
import { mobileGoalDraftSource } from './useGoalDraft'
import { MobileAgentRow } from '../navigation/MobileAgentRow'
import { mobileGoalReferenceLabel } from './presentation'
import { demandAgentReferenceKey, demandAgentReferenceLabel, mergeDemandAgentReferences, type DemandAgentReference } from '@agentmux/demand/relations'

export function MobileGoalSessions({ client, sessionIds, visible, openSession, goal, factScope }: {
  client: AgentMuxHostedClient | null; sessionIds: DemandAgentReference[]; visible: boolean
  goal?: AgentMuxRpcGoal
  factScope?: MobileGoalDraftScope | null
  openSession: ((id: string, identity: MobileObjectIdentity) => void) | undefined
}) {
  const [rows, setRows] = useState<AgentMuxAgentPresentation[]>([]), [issue, setIssue] = useState('')
  const [revision, refresh] = useState(0)
  const rowsScope = useRef<MobileGoalDraftScope | null>(null)
  const sourceKey = JSON.stringify(mobileGoalDraftSource(client, getDeviceWorkface()))
  const references = mergeDemandAgentReferences(sessionIds, goal?.assigneeSessionIds ?? [], goal?.supervisorSessionId ? [goal.supervisorSessionId] : [],
    (goal?.dispatches ?? []).map(value => value.agentSessionId), (goal?.participations ?? []).map(value => value.agentSessionId)).filter(value => typeof value === 'string')
  const ids = JSON.stringify(references)
  useEffect(() => {
    if (!visible || !references.length || !client?.forwardRpc) return
    let live = true, pending = false
    const read = async () => {
      if (pending) return
      pending = true
      try {
        const before = mobileGoalDraftSource(client, getDeviceWorkface())
        if (goal && (!before || !factScope || !sameMobileGoalDraftScope(before.scope, factScope))) throw new Error('目标与当前连接的 Mac 不一致。')
        const result = await client.forwardRpc!('space.ls', { target: {}, presentation: true })
        if (live) {
          if (goal && JSON.stringify(before) !== JSON.stringify(mobileGoalDraftSource(client, getDeviceWorkface()))) throw new Error('读取期间 Mac 连接已变化。')
          const related = result.catalog.agentPresentation?.filter(row => references.includes(row.agentSessionId)) ?? []
          const retainPrevious = !goal || !!rowsScope.current && !!factScope && sameMobileGoalDraftScope(rowsScope.current, factScope)
          rowsScope.current = before?.scope ?? null
          setRows(previous => references.flatMap(id => { const row = related.find(value => value.agentSessionId === id) ?? (retainPrevious ? previous.find(value => value.agentSessionId === id) : undefined); return row ? [row] : [] }))
          setIssue(related.length < references.length ? '部分关联 Agent 的名称和状态还没确认，仍可打开会话。' : '')
        }
      } catch (error) { if (live) setIssue(`读取关联 Agent 失败：${error instanceof Error ? error.message : String(error)}。仍可打开会话或刷新。`) }
      finally { pending = false }
    }
    void read()
    return () => { live = false }
  }, [client, visible, ids, revision, sourceKey, JSON.stringify(factScope)])
  const displayedRows = !goal || !!rowsScope.current && !!factScope && sameMobileGoalDraftScope(rowsScope.current, factScope) ? rows : []
  const name = (id: DemandAgentReference) => typeof id === 'string' ? displayedRows.find(value => value.agentSessionId === id)?.name || 'Agent 名称未确认' : mobileGoalReferenceLabel(id)
  const sessions = <section aria-label="关联会话"><h3>关联会话</h3>
    {issue && <MobileNotice identity={[goal?.id,issue]} role="status">{issue}</MobileNotice>}
    {sessionIds.map(id => {
      if (typeof id !== 'string') return <div key={demandAgentReferenceKey(id)} className="mobile-goal-session"><strong>{mobileGoalReferenceLabel(id)}</strong><p>原 Source 关系已保留；打开或输入需要当前准确执行入口。</p><details><summary>完整来源身份</summary><pre>{JSON.stringify(id, null, 2)}</pre></details></div>
      const row = displayedRows.find(value => value.agentSessionId === id)
      const identity = { name: row?.name || 'Agent 名称未确认', project: row?.project || '项目未确认' }
      const originalSource = () => {
        const source = mobileGoalDraftSource(client, getDeviceWorkface())
        if (!goal || source && factScope && sameMobileGoalDraftScope(source.scope, factScope)) return true
        setIssue('没有打开：当前连接的 Mac 与这个目标不一致，连回原来的 Mac 后再试。')
        return false
      }
      return <div key={demandAgentReferenceKey(id)} className="mobile-goal-session"><strong>{identity.name}</strong><p>{identity.project}{row?.state ? ` · ${row.state}` : ''}</p>
        {row?.recap && <p>{row.recap.text}<small> · {row.recap.source}</small></p>}
        {row?.detail && <p>{row.detail}</p>}
        {openSession && <div className="mobile-agent-row"><MobileAgentRow agentSessionId={id} identity={identity} beforeMenu={originalSource} onOpen={() => {
          if (originalSource()) openSession(id, identity)
        }}>打开关联会话</MobileAgentRow></div>}
        <details><summary>会话身份</summary><code>{id}</code>{row?.providerId && <p>{row.providerId}</p>}</details>
      </div>
    })}
    {sessionIds.length > 0 && <button onClick={() => refresh(value => value + 1)}>刷新关联会话</button>}
    {!sessionIds.length && <p>暂无关联会话。</p>}
  </section>
  if (!goal) return sessions
  const stages = { prepared: '已准备，尚未提交', submitted: '已提交，确认未到', unknown: '输入未确认', confirmed: '输入已确认' }
  const dispatches = goal.dispatches ?? []
  return <section aria-label="目标协作与输入记录"><h3>协作与推进依据</h3>
    <p>负责人：{goal.assigneeSessionIds?.length ? goal.assigneeSessionIds.map(name).join('、') : '未分配'}</p>
    <p>Supervisor：{goal.supervisorSessionId ? name(goal.supervisorSessionId) : '未指定'}</p>
    {!dispatches.length ? <p>尚无公开输入记录。工作状态、关联历史与 Agent 活跃不证明目标已开始推进。</p>
      : <><p>{dispatches.length} 条输入记录 · {dispatches.filter(value => value.stage === 'confirmed').length} 条已确认</p>
        <p>输入确认不代表工作完成或结果接受。多条记录分别保留，不推断唯一当前执行。</p>
        {dispatches.filter(value => value.stage !== 'confirmed').map(value => <MobileNotice kind={value.stage === "unknown" || value.issue ? "warning" : "feedback"} dismissible={value.stage === "unknown" || Boolean(value.issue)} identity={[value.operationId,value.stage,value.issue]} key={value.operationId} role="status">{name(value.agentSessionId)} · {stages[value.stage]}{value.issue ? `：${value.issue}` : ''}</MobileNotice>)}
        <details><summary>全部输入与确认依据</summary>{dispatches.map(value => <div key={value.operationId}>
          <p>{name(value.agentSessionId)} · {stages[value.stage]} · {value.execution === 'continue' ? '续跑输入' : '单次输入'}</p>
          <p className="mobile-goals-body">{value.prompt}</p><pre>{JSON.stringify(value, null, 2)}</pre>
        </div>)}</details></>}
    <details><summary>负责人身份与参与来源</summary><dl><dt>负责人会话</dt><dd>{goal.assigneeSessionIds?.map(demandAgentReferenceLabel).join('、') || '未分配'}</dd>
      <dt>Supervisor 会话</dt><dd>{goal.supervisorSessionId ? demandAgentReferenceLabel(goal.supervisorSessionId) : '未指定'}</dd></dl>
      {(goal.participations ?? []).map(value => <div key={value.id}><p>{name(value.agentSessionId)} · {value.kind === 'create' ? '创建参与' : value.kind === 'requirements' ? '需求整理参与' : '讨论参与'}</p><pre>{JSON.stringify(value, null, 2)}</pre></div>)}
      {goal.creationOrigin && <><p>创建策略只表示来源；设置 Supervisor 不会自动开始执行。</p><pre>{JSON.stringify(goal.creationOrigin, null, 2)}</pre></>}
    </details>
    <details><summary>关联会话与历史</summary>{sessions}</details>
  </section>
}
