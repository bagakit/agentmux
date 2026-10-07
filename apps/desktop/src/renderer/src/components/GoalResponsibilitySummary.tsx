import { useState } from 'react'
import { formatSessionAddress } from '@agentmux/core/sharing'
import type { GoalResponsibilityPhase } from '@agentmux/core/goal-responsibility'
import type { DemandRecord } from '../lib/global-demand-board'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { GoalPatrolControl } from './GoalPatrolControl'
import { GoalContinuationAgent } from './GoalContinuationControl'
import '../styles/goal-responsibility.css'

export const GOAL_RESPONSIBILITY_LABELS: Record<GoalResponsibilityPhase, string> = {
  executing: '执行中', 'idle-grace': '等待回报', stalled: '执行停滞', 'needs-input': '等待回应', blocked: '阻塞待处理',
  'waiting-external': '等待外部条件', 'report-review': '报告待回收', 'result-review': '结果待核验',
  'handed-off': '已交接', ended: '运行已结束 · 待接续', unknown: '观察待确认', closed: '已结束'
}

/** Shared source-qualified responsibility in list, detail and Mote; navigation preserves original input. */
export function GoalResponsibilitySummary({ demand, compact = false, active = true }: { demand: DemandRecord; compact?: boolean; active?: boolean }) {
  const current = useAppStore(state => active ? state.demands[demand.id] ?? demand : demand)
  const [issue, setIssue] = useState<string | null>(null)
  const observed = current.responsibility, rows = observed?.executions ?? []
  const retained = Boolean(current.delegationReadCut && current.delegationReadCut.goalUpdatedAt < current.updatedAt)
  async function openAgent(id: string) {
    try { await api.ui.openObjectLink(formatSessionAddress(id)); setIssue(null) }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
  }
  const identity = (id: string, hostId?: string) => <button type="button" className="goal-responsibility__agent" onClick={event => { event.stopPropagation(); void openAgent(id) }} title={`Session ${id}${hostId ? ' · Host ' + hostId : ''}`}>
    <GoalContinuationAgent agentSessionId={id} {...(hostId === undefined ? {} : { hostId })} active={active} size={14} />
  </button>
  const attention = rows.filter(row => row.alert !== null)
  const visible = compact ? [...attention, ...rows.filter(row => row.alert === null)].slice(0, 2) : rows
  const hiddenAttention = attention.length - visible.filter(row => row.alert !== null).length
  return <div className={`goal-responsibility${compact ? ' goal-responsibility--compact' : ''}`} aria-label="执行责任" data-goal-responsibility={current.id}>
    {!compact ? <strong className="goal-responsibility__heading">执行责任</strong> : null}
    {observed ? <div className="goal-responsibility__manager"><span>管理</span>{observed.supervisor.agentSessionId ? identity(observed.supervisor.agentSessionId, observed.supervisor.hostId) : <span>待指派</span>}
      {observed.supervisor.state === 'ended' ? <span className="goal-responsibility__notice">管理 Run 已结束 · 需恢复原 Session</span>
        : observed.supervisor.state === 'blocked' ? <span className="goal-responsibility__notice">管理异常 · 需接续</span>
        : observed.supervisor.state === 'unknown' ? <span className="goal-responsibility__notice">管理状态待确认</span>
        : observed.supervisor.state === 'missing' ? <span className="goal-responsibility__notice">缺少监督责任</span> : null}
    </div> : null}
    {!observed ? <span className="goal-responsibility__pending">{current.delegations?.length || current.dispatches?.some(item => item.execution === 'finite') ? '正在读取原执行责任…' : '尚无确认执行绑定'}</span> : null}
    {visible.map(row => <div className="goal-responsibility__execution" key={`${row.execution.kind}:${row.execution.operationId}`}>
      <div className="goal-responsibility__line">{identity(row.execution.agentSessionId, row.execution.hostId)}
        <span className={`goal-responsibility__phase${row.alert ? ' goal-responsibility__phase--attention' : ''}`}>{GOAL_RESPONSIBILITY_LABELS[row.phase]}</span>
        {row.binding !== 'confirmed' ? <span className="goal-responsibility__binding">{row.binding === 'ambiguous' ? '多个执行依据' : '原输入待确认'}</span> : null}
      </div>
      <div className="goal-responsibility__next"><span>下一步</span>{row.nextOwner.agentSessionId ? identity(row.nextOwner.agentSessionId,
        row.nextOwner.agentSessionId === observed?.supervisor.agentSessionId ? observed.supervisor.hostId : row.execution.hostId) : <span>{row.nextOwner.kind === 'human' ? '等待人核验' : row.nextOwner.kind === 'external' ? '外部条件' : '待明确负责者'}</span>}
        {!compact ? <span>{row.nextOwner.action}</span> : null}
      </div>
      {!compact || row.alert ? <p className="goal-responsibility__reason" role={row.alert ? 'status' : undefined}>{row.reason}</p> : null}
      {!compact ? <details className="goal-responsibility__source"><summary>责任依据</summary>
        <dl><dt>原执行</dt><dd>{row.execution.kind} · {row.execution.operationId}</dd><dt>Host / Run</dt><dd>{row.execution.hostId} / {row.execution.runId}</dd>
          <dt>状态起点</dt><dd>{row.stateSince ? new Date(row.stateSince).toLocaleString() : '未知'}</dd><dt>来源</dt><dd>{row.observation?.source ?? '原观察不可用'}</dd></dl>
        {row.progress ? <p>{row.progress.summary}{row.progress.evidence.map(source => <span className="goal-responsibility__evidence" key={source}>{source}</span>)}</p> : null}
      </details> : null}
    </div>)}
    {compact && rows.length > visible.length ? <span className="goal-responsibility__pending">另有 {rows.length - visible.length} 项原执行 · 详情可读</span> : null}
    {compact && hiddenAttention > 0 ? <span className="goal-responsibility__notice" role="status">另有 {hiddenAttention} 项责任待处理 · 详情可读</span> : null}
    {observed && !rows.length ? <span className="goal-responsibility__pending">尚无确认执行绑定；负责人和历史会话不代替执行。</span> : null}
    <GoalPatrolControl demand={current} compact={compact} />
    {retained || issue || current.delegationObservationIssue ? <p className="goal-responsibility__reason" role="status">{issue ?? current.delegationObservationIssue ?? '责任事实正在刷新；保留最后确认内容。'}</p> : null}
  </div>
}
