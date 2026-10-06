import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { TextInput } from '@agentmux/client-ui/input'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxRpcGoal, AgentMuxRpcResult } from '@agentmux/core'
import { AGENTMUX_DEMAND_PRIORITIES, AGENTMUX_DEMAND_STATUSES } from '@agentmux/core/control'
import './goals.css'
import { MobileGoalCreate, type GoalDiscussionReceipt } from './MobileGoalCreate'
import { MobileZoneWorkface } from '../navigation/MobileZoneWorkface'
import { MobileGoalActions } from './MobileGoalActions'
import { MobileGoalLinks } from './MobileGoalLinks'
import { MobileGoalSessions } from './MobileGoalSessions'
import { MobileGoalAlignment } from './MobileGoalAlignment'
import type { MobileObjectIdentity } from '../navigation/MobileIdentity'
import { getDeviceWorkface } from '../recovery/device-workface'
import type { MobileGoalsContext } from '../recovery/presentation-route'
import type { MobileGoalDraftScope } from '../recovery/goal-drafts'
import { mobileGoalDraftSource, useGoalDraft } from './useGoalDraft'
import { MobileGoalDraftEditor } from './MobileGoalDraftEditor'

export type MobileGoalsSurfaceProps = {
  client: AgentMuxHostedClient | null
  connected: boolean
  visible: boolean
  openSession?: (id: string, identity: MobileObjectIdentity) => void
  onBackChange?(back: (() => void) | null): void
  initialContext?: MobileGoalsContext
  context?: MobileGoalsContext
  onContextChange?(context: MobileGoalsContext): void
  copyText?: ClientUiPlatform['copyText'] | undefined
}
const statuses = { backlog: '待整理', todo: '待开始', in_progress: '进行中', in_review: '待检查', blocked: '受阻', done: '已完成', cancelled: '已取消' }
const priorities = { low: '低', normal: '普通', high: '高', urgent: '紧急' }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
type Decisions = AgentMuxRpcResult<'goal.decisions'>['decisions']

/** The original Goal owner supplies all facts and validates all mutations. */
export function MobileGoalsSurface({ client, connected, visible, openSession, onBackChange, initialContext, context: presentedContext, onContextChange, copyText }: MobileGoalsSurfaceProps) {
  const [goals, setGoals] = useState<AgentMuxRpcGoal[] | null>(null)
  const [localContext, setLocalContext] = useState<MobileGoalsContext>(initialContext ?? { goalId: null, mode: 'detail', discussion: null })
  const context = presentedContext ?? localContext, contextRef = useRef(context); contextRef.current = context
  const setContext = useCallback((change: MobileGoalsContext | ((value: MobileGoalsContext) => MobileGoalsContext)) => {
    const next = typeof change === 'function' ? change(contextRef.current) : change
    contextRef.current = next; setLocalContext(next); onContextChange?.(next)
  }, [onContextChange])
  const selected = context.goalId, discussionTab = context.discussion
  const selectedRef = useRef(selected)
  const navigation = useRef({ visible, client, epoch: 0 })
  if (navigation.current.visible !== visible || navigation.current.client !== client) { navigation.current.visible = visible; navigation.current.client = client; navigation.current.epoch += 1 }
  const select = useCallback((id: string | null) => { navigation.current.epoch += 1; selectedRef.current = id; setContext({ goalId: id, mode: 'detail', discussion: null }) }, [setContext])
  const beginPresentation = () => { const epoch = navigation.current.epoch; return () => navigation.current.visible && navigation.current.epoch === epoch }
  const [details, setDetails] = useState<Record<string, AgentMuxRpcGoal>>({})
  const [detailScopes, setDetailScopes] = useState<Record<string, MobileGoalDraftScope | null>>({})
  const listScope = useRef<MobileGoalDraftScope | null>(null)
  const source = () => mobileGoalDraftSource(client, getDeviceWorkface())
  const readScope = (before: ReturnType<typeof source>) => {
    const after = source()
    if (before && JSON.stringify(before) !== JSON.stringify(after)) throw new Error('原 Host 在读取期间已变化；原目标与草稿保留，请刷新核对。')
    return before && after ? before.scope : null
  }
  const [decisions, setDecisions] = useState<Record<string, Decisions>>({})
  const [issue, setIssue] = useState(''), [detailIssue, setDetailIssue] = useState(''), [decisionIssue, setDecisionIssue] = useState('')
  const [query, setQuery] = useState(''), [status, setStatus] = useState('')
  const [lookup, setLookup] = useState(''), [lookupIssue, setLookupIssue] = useState('')
  const lookupRead = useRef(0)
  const backToList = useCallback(() => { lookupRead.current += 1; select(null) }, [select])
  const backToGoal = useCallback(() => { navigation.current.epoch += 1; setContext(value => ({ ...value, discussion: null })) }, [setContext])
  const backToDetail = useCallback(() => setContext(value => ({ ...value, mode: 'detail' })), [setContext])
  const activeBack = discussionTab ? backToGoal : selected ? context.mode === 'edit' ? backToDetail : backToList : null
  useLayoutEffect(() => {
    if (!visible || !onBackChange) return
    onBackChange(activeBack)
    return () => onBackChange(null)
  }, [visible, onBackChange, activeBack])
  useEffect(() => () => { lookupRead.current += 1 }, [client, visible])
  const [revision, refresh] = useState(0)
  const factEpoch = useRef({ list: 0, goals: {} as Record<string, number> })
  useEffect(() => {
    if (!client?.forwardRpc || !visible || selected) return
    let live = true, pending = false
    const read = async () => {
      if (pending) return
      pending = true
      const epoch = factEpoch.current.list
      try {
        const before = source()
        const result = await client.forwardRpc!('goal.ls', { limit: 1000, ...(status ? { status } : {}) })
        if (live && epoch === factEpoch.current.list) { listScope.current = readScope(before); setGoals(result.goals); setIssue('') }
      } catch (error) { if (live) setIssue(`读取目标失败：${message(error)}。原目标保留，可刷新重试。`) }
      finally { pending = false }
    }
    void read()
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void read() }, 10000)
    const foreground = () => { if (document.visibilityState !== 'hidden') void read() }
    document.addEventListener('visibilitychange', foreground)
    return () => { live = false; clearInterval(timer); document.removeEventListener('visibilitychange', foreground) }
  }, [client, connected, visible, revision, status, selected])
  useEffect(() => {
    if (!client?.forwardRpc || !selected || !visible) return
    let live = true, pending = false
    const read = async () => {
      if (pending) return
      pending = true
      const epoch = factEpoch.current.goals[selected] ?? 0
      try {
        const before = source()
        const result = await client.forwardRpc!('goal.inspect', { goalId: selected })
        if (!live || epoch !== (factEpoch.current.goals[selected] ?? 0)) return
        if (result.goal) { const scope = readScope(before); setDetails(values => ({ ...values, [result.goal!.id]: result.goal! })); setDetailScopes(values => ({ ...values, [result.goal!.id]: scope })); setDetailIssue('') }
        else setDetailIssue('原目标当前未找到；保留已读正文与引用，可刷新核对。')
      } catch (error) { if (live) setDetailIssue(`读取详情失败：${message(error)}。已读正文与草稿保留，可刷新重试。`) }
      finally { pending = false }
    }
    void read()
    const timer = setInterval(() => { if (!document.hidden) void read() }, 10000)
    const foreground = () => { if (!document.hidden) void read() }
    document.addEventListener('visibilitychange', foreground)
    void client.forwardRpc('goal.decisions', { goalId: selected }).then(result => {
      if (live) { setDecisions(values => ({ ...values, [selected]: result.decisions })); setDecisionIssue('') }
    }).catch(error => { if (live) setDecisionIssue(`读取决策记录失败：${message(error)}。可刷新重试。`) })
    return () => { live = false; clearInterval(timer); document.removeEventListener('visibilitychange', foreground) }
  }, [client, connected, visible, selected, revision])
  const choose = (goal: AgentMuxRpcGoal, scope = listScope.current) => { select(goal.id); setDetails(values => ({ ...values, [goal.id]: goal })); setDetailScopes(values => ({ ...values, [goal.id]: scope })); setDetailIssue(''); setDecisionIssue('') }
  const updated = (goal: AgentMuxRpcGoal, fields: Array<keyof AgentMuxRpcGoal>) => {
    factEpoch.current.list += 1
    factEpoch.current.goals[goal.id] = (factEpoch.current.goals[goal.id] ?? 0) + 1
    const merge = (previous: AgentMuxRpcGoal) => goal.updatedAt < previous.updatedAt ? previous : goal
    setDetails(values => { const previous = values[goal.id]; return previous ? { ...values, [goal.id]: merge(previous) } : values }); setGoals(values => values?.map(value => value.id === goal.id ? merge(value) : value) ?? null)
  }
  const deleted = (id: string) => {
    factEpoch.current.list += 1
    factEpoch.current.goals[id] = (factEpoch.current.goals[id] ?? 0) + 1
    setGoals(values => values?.filter(goal => goal.id !== id) ?? null)
    setDetails(values => Object.fromEntries(Object.entries(values).filter(([key]) => key !== id)))
    if (selectedRef.current === id) select(null)
  }
  const openDiscussion = (receipt: GoalDiscussionReceipt) => {
    if (!navigation.current.visible || selectedRef.current !== receipt.goalId) return
    setContext(value => ({ ...value, discussion: { goalId: receipt.goalId, tabId: receipt.tabId, agentSessionId: receipt.agentSessionId ?? null } }))
    if (receipt.agentSessionId && openSession) openSession(receipt.agentSessionId, { name: '目标原 Mote', project: details[receipt.goalId]?.projectName ?? '未分配项目' })
  }
  const visibleGoals = useMemo(() => goals?.filter(goal => (!status || goal.status === status) && `${goal.title} ${goal.description} ${goal.projectName ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [goals, status, query])
  return <section className="mobile-goals" aria-label="Goals" hidden={!visible}>
    <header><h1>Goals</h1><button className="mobile-icon-button mobile-goals-refresh" aria-label="刷新目标" title="刷新目标" onClick={() => refresh(value => value + 1)}><SemanticIcon name="action.refresh" size={18} /><span className="mobile-visually-hidden">刷新目标</span></button></header>
    {!connected && <p role="status">连接暂不可用，已读目标与草稿保留；可刷新核对。</p>}
    {!client?.forwardRpc && <p role="status">目标公共端口暂不可用，已读目标与会话保留。</p>}
    {issue && <p role="status">{issue}</p>}
    {goals?.length === 1000 && <p role="status">目录已达到原服务单次返回范围，搜索仅覆盖已读目标；可按准确 Goal ID 打开其他目标。完整翻页仍待原服务提供。</p>}
      <MobileGoalCreate client={client} visible={visible && selected === null && !discussionTab} openDiscussion={openDiscussion} beginPresentation={beginPresentation} created={(goal, present) => {
        factEpoch.current.list += 1
        setGoals(previous => previous ? [...previous.filter(value => value.id !== goal.id), goal] : previous)
        setDetails(values => ({ ...values, [goal.id]: goal }))
        if (present()) {
          // The creation's own continuation still owns this presentation epoch.
          // Selecting another Goal remains the explicit epoch-changing action.
          selectedRef.current = goal.id
          setContext({ goalId: goal.id, mode: 'detail', discussion: null })
          setDetailScopes(values => ({ ...values, [goal.id]: source()?.scope ?? null }))
          setDetailIssue(''); setDecisionIssue('')
        }
      }} />
    <div hidden={selected !== null || !!discussionTab}>
      <div className="mobile-goals-filters"><TextInput aria-label="搜索目标" placeholder="搜索目标或项目" value={query} onChange={event => setQuery(event.target.value)} />
        <select aria-label="筛选工作状态" value={status} onChange={event => setStatus(event.target.value)}><option value="">全部状态</option>{AGENTMUX_DEMAND_STATUSES.map(value => <option key={value} value={value}>{statuses[value]}</option>)}</select></div>
      <details><summary>按 Goal ID 打开</summary><form onSubmit={event => {
        event.preventDefault()
        if (!client?.forwardRpc) { setLookupIssue('读取未发送：目标公共端口暂不可用。'); return }
        const goalId = lookup, sequence = ++lookupRead.current, epoch = factEpoch.current.goals[lookup] ?? 0, before = source()
        void client.forwardRpc('goal.inspect', { goalId }).then(result => {
          if (sequence !== lookupRead.current || epoch !== (factEpoch.current.goals[goalId] ?? 0)) return
          if (result.goal) { choose(result.goal, readScope(before)); setLookupIssue('') }
          else setLookupIssue('未找到这个准确 Goal ID；原列表与输入保留。')
        }).catch(error => { if (sequence === lookupRead.current && epoch === (factEpoch.current.goals[goalId] ?? 0)) setLookupIssue(`读取目标失败：${message(error)}。原列表与输入保留，可重试。`) })
      }}><label>Goal ID<TextInput aria-label="打开 Goal ID" value={lookup} onChange={event => setLookup(event.target.value)} required /></label><button>打开指定目标</button></form>{lookupIssue && <p role="status">{lookupIssue}</p>}</details>
      {goals === null ? <p>目标列表尚未确认。</p> : <>
        <ul className="mobile-goals-list">{(visibleGoals ?? []).map(goal => <li key={goal.id}>
          <button onClick={() => choose(goal)}><strong>{goal.title || '待定义目标'}</strong><span>{goal.projectName ?? goal.projectId ?? '未分配项目'} · {statuses[goal.status]}</span><small>{goal.description}</small></button>
        </li>)}</ul>
        {!goals.length && <p>暂无目标。</p>}
        {!!goals.length && !visibleGoals?.length && <p>已读列表中没有匹配的目标。可清除搜索或筛选。</p>}
      </>}
    </div>
    {[...new Set([...Object.keys(details), ...(selected ? [selected] : [])])].map(id => { const detail = details[id]; return <div key={id} hidden={selected !== id || !!discussionTab}><button onClick={backToList}>返回目标列表</button>{selected === id && [detailIssue, decisionIssue].filter(Boolean).map((value, index) => <p key={index} role="status">{value}</p>)}
      <GoalDetail key={id} goalId={id} goal={detail ?? null} factScope={detailScopes[id] ?? null} visible={visible && selected === id && !discussionTab} editing={context.mode === 'edit' && selected === id} edit={editing => setContext(value => ({ ...value, mode: editing ? 'edit' : 'detail' }))} decisions={decisions[id] ?? null} client={client} connected={connected} updated={updated} refresh={() => refresh(value => value + 1)} copyText={copyText}>
        {detail && <>
        <MobileGoalAlignment client={client} goal={detail} updated={updated} openDiscussion={openDiscussion} beginPresentation={beginPresentation} />
        </>}
      </GoalDetail>
      {detail && <><MobileGoalSessions client={client} goal={detail} factScope={detailScopes[id] ?? null} sessionIds={detail.sessionIds} visible={visible && selected === detail.id && !discussionTab} openSession={openSession} />
      <details><summary>协作、关联与高级动作</summary>
      <MobileGoalLinks client={client} goal={detail} updated={updated} />
      <MobileGoalActions client={client} goal={detail} visible={visible && selected === detail.id} updated={updated} deleted={deleted} />
      </details></>}
    </div> })}
    {discussionTab && <div><button type="button" onClick={backToGoal}>返回原目标</button><MobileZoneWorkface key={discussionTab.tabId} client={client} name="目标原主 Mote" tabId={discussionTab.tabId} visible={visible}
      openSession={(id, identity) => { if (openSession) openSession(id, identity) }} /></div>}
  </section>
}

function GoalDetail({ goalId, goal, factScope, visible, decisions, client, connected, updated, refresh, children, editing, edit, copyText }: {
  goalId: string; goal: AgentMuxRpcGoal | null; factScope: MobileGoalDraftScope | null; visible: boolean; decisions: Decisions | null; client: AgentMuxHostedClient | null; connected: boolean
  updated(goal: AgentMuxRpcGoal, fields: Array<keyof AgentMuxRpcGoal>): void; refresh(): void; children: ReactNode
  editing: boolean; edit(editing: boolean): void; copyText?: ClientUiPlatform['copyText'] | undefined
}) {
  const model = useGoalDraft(goalId, goal, factScope, client, connected, updated)
  const editor = <MobileGoalDraftEditor model={model} editing={editing} onEditingChange={edit} refresh={refresh} copyText={copyText} />
  if (!goal) return <article aria-label="目标详情" hidden={!visible}><h2>原目标</h2><p role="status">当前目标尚未读回；原引用、正文与请求保留。</p><code>{goalId}</code>{editor}<button onClick={refresh}>读取当前目标</button></article>
  const { saving, save } = model
  const alignment = goal.alignment, grounding = goal.grounding
  const currentReport = !!alignment && grounding?.alignmentRevision === alignment.revision
  return <article aria-label="目标详情" hidden={!visible}>
    {!editing && <><h2>{goal.title || '待定义目标'}</h2><p className="mobile-goals-body">{goal.description || '目标原意尚未整理。'}</p></>}
    {editor}
    <section aria-label="目标与成功标准"><h3>目标与成功标准</h3>
      {alignment ? <><p className="mobile-goals-body">{alignment.summary}</p><ul>{alignment.criteria.map(criterion => <li key={criterion.id}>{criterion.text}</li>)}</ul>
        {!alignment.criteria.length && <p>尚无成功标准。</p>}
        {!!alignment.openQuestions.length && <><h4>待决定事项</h4><ul>{alignment.openQuestions.map((question, index) => <li key={index}>{question}</li>)}</ul></>}
        <p>{alignment.confirmedAt === null ? '目标尚未确认。' : `目标已确认 · ${new Date(alignment.confirmedAt).toLocaleString()}`}</p>
      </> : <p>尚无目标提案，原意与关联会话仍可阅读。</p>}
    </section>
    <section aria-label="结果与证据"><h3>结果与证据</h3>
      {grounding ? <><p className="mobile-goals-body">{grounding.summary}</p>
        {(!alignment || grounding.alignmentRevision !== alignment.revision) && <p role="status">此报告尚不能对应当前目标标准，请核对目标版本。</p>}
        {(currentReport ? alignment?.criteria : [])?.filter(criterion => !grounding.checks.some(check => check.criterionId === criterion.id)).map(criterion => <p key={criterion.id}>缺少结果检查：{criterion.text}</p>)}
        <ul>{grounding.checks.map(check => <li key={check.criterionId}><strong>{currentReport ? alignment?.criteria.find(criterion => criterion.id === check.criterionId)?.text ?? check.criterionId : `旧报告标准 ${check.criterionId}`}</strong><p>{({ met: '报告声称达成', gap: '仍有差距', unknown: '结果未知' })[check.outcome]}</p><p>{check.note}</p>
          <ul>{check.evidence.map((evidence, index) => <li key={index}><code>{evidence}</code></li>)}</ul>{!check.evidence.length && <p>暂无定位证据。</p>}
        </li>)}</ul><p>{grounding.acceptedAt === null ? '结果尚未接受。' : `${currentReport ? '当前结果已接受' : '旧报告曾被接受，不代表当前结果接受'} · ${new Date(grounding.acceptedAt).toLocaleString()}`}</p>
      </> : <p>{goal.status === 'done' ? '工作状态已完成，结果尚未核验。' : '尚无结果报告。'}</p>}
    </section>
    {children}
    <details><summary>工作状态与属性</summary>
      <label>工作状态<select disabled={saving} aria-label="工作状态" value={goal.status} onChange={event => { void save({ status: event.target.value as AgentMuxRpcGoal['status'] }) }}>{AGENTMUX_DEMAND_STATUSES.map(value => <option key={value} value={value}>{statuses[value]}</option>)}</select></label>
      <p>工作状态不代表目标确认或结果接受。</p>
      <label>优先级<select disabled={saving} aria-label="优先级" value={goal.priority} onChange={event => { void save({ priority: event.target.value as AgentMuxRpcGoal['priority'] }) }}>{AGENTMUX_DEMAND_PRIORITIES.map(value => <option key={value} value={value}>{priorities[value]}</option>)}</select></label>
      <dl><dt>目标 ID</dt><dd>{goal.id}</dd><dt>项目</dt><dd>{goal.projectId ? `${goal.projectName ?? '名称未确认'} · ${goal.projectId}` : '未分配项目'}</dd><dt>负责人</dt><dd>{goal.assigneeSessionIds?.join('、') || '未分配'}</dd><dt>Supervisor</dt><dd>{goal.supervisorSessionId ?? '未指定'}</dd><dt>标签</dt><dd>{goal.tags?.join('、') || '无'}</dd><dt>父目标</dt><dd>{goal.parentGoalId ?? '无'}</dd><dt>计划开始</dt><dd>{goal.plannedStartAt ? new Date(goal.plannedStartAt).toLocaleString() : '未设置'}</dd><dt>目标日期</dt><dd>{goal.targetAt ? new Date(goal.targetAt).toLocaleString() : '未设置'}</dd><dt>最后更新</dt><dd>{new Date(goal.updatedAt).toLocaleString()}</dd></dl>
    </details>
    <details><summary>活动与决策记录</summary><ul>{goal.activityLog?.map((entry, index) => <li key={index}>{entry}</li>)}</ul>
      {decisions === null ? <p>决策记录尚未确认。</p> : decisions.map((decision, index) => <div key={index}><p>{decision.input}</p><p>{decision.risk} · {decision.confirmation} · {decision.selectedProjectId ?? '未选择项目'}</p><ul>{decision.candidates.map(candidate => <li key={candidate.projectId}>{candidate.projectId}：{candidate.reason}</li>)}</ul></div>)}
    </details>
    <button onClick={refresh}>读取当前目标</button>
  </article>
}
