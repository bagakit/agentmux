import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ComposerTextarea, TextInput } from '@agentmux/client-ui/input'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxRpcGoal, AgentMuxRpcResult, AgentMuxRpcParams } from '@agentmux/core'
import { AGENTMUX_DEMAND_PRIORITIES, AGENTMUX_DEMAND_STATUSES } from '@agentmux/core/control'
import './goals.css'
import { MobileGoalCreate, type GoalDiscussionReceipt } from './MobileGoalCreate'
import { MobileZoneWorkface } from '../navigation/MobileZoneWorkface'
import { MobileGoalActions } from './MobileGoalActions'
import { MobileGoalLinks } from './MobileGoalLinks'
import { MobileGoalSessions } from './MobileGoalSessions'
import { MobileGoalAlignment } from './MobileGoalAlignment'
import type { MobileObjectIdentity } from '../navigation/MobileIdentity'

export type MobileGoalsSurfaceProps = {
  client: AgentMuxHostedClient | null
  connected: boolean
  visible: boolean
  openSession?: (id: string, identity: MobileObjectIdentity) => void
  onBackChange?(back: (() => void) | null): void
}
const statuses = { backlog: '待整理', todo: '待开始', in_progress: '进行中', in_review: '待检查', blocked: '受阻', done: '已完成', cancelled: '已取消' }
const priorities = { low: '低', normal: '普通', high: '高', urgent: '紧急' }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
type Decisions = AgentMuxRpcResult<'goal.decisions'>['decisions']

/** The original Goal owner supplies all facts and validates all mutations. */
export function MobileGoalsSurface({ client, connected, visible, openSession, onBackChange }: MobileGoalsSurfaceProps) {
  const [goals, setGoals] = useState<AgentMuxRpcGoal[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const selectedRef = useRef(selected)
  const navigation = useRef({ visible, client, epoch: 0 })
  if (navigation.current.visible !== visible || navigation.current.client !== client) { navigation.current.visible = visible; navigation.current.client = client; navigation.current.epoch += 1 }
  const select = useCallback((id: string | null) => { navigation.current.epoch += 1; selectedRef.current = id; setSelected(id) }, [])
  const beginPresentation = () => { const epoch = navigation.current.epoch; return () => navigation.current.visible && navigation.current.epoch === epoch }
  const [discussionTab, setDiscussionTab] = useState<{ goalId: string; tabId: string } | null>(null)
  const [details, setDetails] = useState<Record<string, AgentMuxRpcGoal>>({})
  const [decisions, setDecisions] = useState<Record<string, Decisions>>({})
  const [issue, setIssue] = useState(''), [detailIssue, setDetailIssue] = useState(''), [decisionIssue, setDecisionIssue] = useState('')
  const [query, setQuery] = useState(''), [status, setStatus] = useState('')
  const [lookup, setLookup] = useState(''), [lookupIssue, setLookupIssue] = useState('')
  const lookupRead = useRef(0)
  const [detailBack, setDetailBack] = useState<{ goalId: string; back: () => void } | null>(null)
  const reportDetailBack = useCallback((goalId: string, back: (() => void) | null) => {
    setDetailBack(previous => back ? previous?.goalId === goalId && previous.back === back ? previous : { goalId, back }
      : previous?.goalId === goalId ? null : previous)
  }, [])
  const backToList = useCallback(() => { lookupRead.current += 1; select(null) }, [select])
  const backToGoal = useCallback(() => { navigation.current.epoch += 1; setDiscussionTab(null) }, [])
  const activeBack = discussionTab ? backToGoal : selected ? detailBack?.goalId === selected ? detailBack.back : backToList : null
  useEffect(() => {
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
        const result = await client.forwardRpc!('goal.ls', { limit: 1000, ...(status ? { status } : {}) })
        if (live && epoch === factEpoch.current.list) { setGoals(result.goals); setIssue('') }
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
        const result = await client.forwardRpc!('goal.inspect', { goalId: selected })
        if (!live || epoch !== (factEpoch.current.goals[selected] ?? 0)) return
        if (result.goal) { setDetails(values => ({ ...values, [result.goal!.id]: result.goal! })); setDetailIssue('') }
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
  const choose = (goal: AgentMuxRpcGoal) => { select(goal.id); setDetails(values => ({ ...values, [goal.id]: goal })); setDetailIssue(''); setDecisionIssue('') }
  const updated = (goal: AgentMuxRpcGoal, fields: Array<keyof AgentMuxRpcGoal>) => {
    factEpoch.current.list += 1
    factEpoch.current.goals[goal.id] = (factEpoch.current.goals[goal.id] ?? 0) + 1
    const merge = (previous: AgentMuxRpcGoal) => ({ ...previous, ...Object.fromEntries(fields.map(field => [field, goal[field]])), updatedAt: Math.max(previous.updatedAt, goal.updatedAt) })
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
    if (receipt.agentSessionId && openSession) openSession(receipt.agentSessionId, { name: '目标原 Mote', project: details[receipt.goalId]?.projectName ?? '未分配项目' })
    else setDiscussionTab({ goalId: receipt.goalId, tabId: receipt.tabId })
  }
  const visibleGoals = useMemo(() => goals?.filter(goal => (!status || goal.status === status) && `${goal.title} ${goal.description} ${goal.projectName ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [goals, status, query])
  return <section className="mobile-goals" aria-label="Goals" hidden={!visible}>
    <header><h1>Goals</h1><button onClick={() => refresh(value => value + 1)}>刷新目标</button></header>
    {!connected && <p role="status">连接暂不可用，已读目标与草稿保留；可刷新核对。</p>}
    {!client?.forwardRpc && <p role="status">目标公共端口暂不可用，已读目标与会话保留。</p>}
    {issue && <p role="status">{issue}</p>}
    {goals?.length === 1000 && <p role="status">目录已达到原服务单次返回范围，搜索仅覆盖已读目标；可按准确 Goal ID 打开其他目标。完整翻页仍待原服务提供。</p>}
      <MobileGoalCreate client={client} visible={visible && selected === null && !discussionTab} openDiscussion={openDiscussion} beginPresentation={beginPresentation} created={(goal, present) => {
        factEpoch.current.list += 1
        setGoals(previous => previous ? [...previous.filter(value => value.id !== goal.id), goal] : previous)
        setDetails(values => ({ ...values, [goal.id]: goal }))
        if (present()) { selectedRef.current = goal.id; setSelected(goal.id) }
      }} />
    <div hidden={selected !== null || !!discussionTab}>
      <div className="mobile-goals-filters"><TextInput aria-label="搜索目标" placeholder="搜索目标或项目" value={query} onChange={event => setQuery(event.target.value)} />
        <select aria-label="筛选工作状态" value={status} onChange={event => setStatus(event.target.value)}><option value="">全部状态</option>{AGENTMUX_DEMAND_STATUSES.map(value => <option key={value} value={value}>{statuses[value]}</option>)}</select></div>
      <details><summary>按 Goal ID 打开</summary><form onSubmit={event => {
        event.preventDefault()
        if (!client?.forwardRpc) { setLookupIssue('读取未发送：目标公共端口暂不可用。'); return }
        const goalId = lookup, sequence = ++lookupRead.current, epoch = factEpoch.current.goals[lookup] ?? 0
        void client.forwardRpc('goal.inspect', { goalId }).then(result => {
          if (sequence !== lookupRead.current || epoch !== (factEpoch.current.goals[goalId] ?? 0)) return
          if (result.goal) { choose(result.goal); setLookupIssue('') }
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
    {Object.values(details).map(detail => <div key={detail.id} hidden={selected !== detail.id || !!discussionTab}><button onClick={backToList}>返回目标列表</button>{selected === detail.id && [detailIssue, decisionIssue].filter(Boolean).map((value, index) => <p key={index} role="status">{value}</p>)}
      <GoalDetail key={detail.id} goal={detail} visible={visible && selected === detail.id && !discussionTab} decisions={decisions[detail.id] ?? null} client={client} updated={updated} refresh={() => refresh(value => value + 1)} onBackChange={reportDetailBack}>
        <MobileGoalAlignment client={client} goal={detail} updated={updated} openDiscussion={openDiscussion} beginPresentation={beginPresentation} />
      </GoalDetail>
      <MobileGoalSessions client={client} sessionIds={detail.sessionIds} visible={visible && selected === detail.id} openSession={openSession} />
      <MobileGoalLinks client={client} goal={detail} updated={updated} />
      <MobileGoalActions client={client} goal={detail} visible={visible && selected === detail.id} updated={updated} deleted={deleted} />
    </div>)}
    {discussionTab && <div><button type="button" onClick={backToGoal}>返回原目标</button><MobileZoneWorkface key={discussionTab.tabId} client={client} name="目标原主 Mote" tabId={discussionTab.tabId} visible={visible}
      openSession={(id, identity) => { if (openSession) openSession(id, identity) }} /></div>}
  </section>
}

function GoalDetail({ goal, visible, decisions, client, updated, refresh, children, onBackChange }: {
  goal: AgentMuxRpcGoal; visible: boolean; decisions: Decisions | null; client: AgentMuxHostedClient | null
  updated(goal: AgentMuxRpcGoal, fields: Array<keyof AgentMuxRpcGoal>): void; refresh(): void; children: ReactNode
  onBackChange?(goalId: string, back: (() => void) | null): void
}) {
  const [editing, edit] = useState(false), [title, setTitle] = useState(goal.title), [description, setDescription] = useState(goal.description)
  const backToDetail = useCallback(() => edit(false), [])
  useEffect(() => {
    if (!visible || !onBackChange) return
    onBackChange(goal.id, editing ? backToDetail : null)
    return () => onBackChange(goal.id, null)
  }, [visible, onBackChange, goal.id, editing, backToDetail])
  const [unknownWrites, setUnknownWrites] = useState<Array<{ operationId: string; patch: AgentMuxRpcParams<'goal.update'>['patch']; issue: string }>>([])
  const [saveMessages, setSaveMessages] = useState<Record<string, string>>({}), [saving, setSaving] = useState(false)
  const baseline = useRef({ title: goal.title, description: goal.description })
  useEffect(() => {
    if (title === baseline.current.title) { setTitle(goal.title); baseline.current.title = goal.title }
    if (description === baseline.current.description) { setDescription(goal.description); baseline.current.description = goal.description }
  }, [goal.title, goal.description])
  const inFlight = useRef(false)
  const save = async (patch: AgentMuxRpcParams<'goal.update'>['patch']) => {
    const field = 'title' in patch || 'description' in patch ? '正文' : 'status' in patch ? '工作状态' : '优先级'
    const report = (text: string) => setSaveMessages(values => ({ ...values, [field]: text }))
    if (inFlight.current) return
    if (!client?.forwardRpc) { report('保存未发送：目标公共端口暂不可用；草稿保留。'); return }
    const operationId = randomClientRequestId()
    inFlight.current = true; setSaving(true)
    try {
      const result = await client.forwardRpc('goal.update', { goalId: goal.id, patch, operationId })
      if (patch.title !== undefined) { baseline.current.title = result.goal.title; setTitle(value => value === patch.title ? result.goal.title : value) }
      if (patch.description !== undefined) { baseline.current.description = result.goal.description; setDescription(value => value === patch.description ? result.goal.description : value) }
      updated(result.goal, Object.keys(patch) as Array<keyof AgentMuxRpcGoal>); report('已保存到原目标。')
    } catch (error) { setUnknownWrites(values => [...values, { operationId, patch, issue: message(error) }]); report(`保存回执未确认：${message(error)}。草稿保留，请读取当前目标核对；不会自动重发。`) }
    finally { inFlight.current = false; setSaving(false) }
  }
  const alignment = goal.alignment, grounding = goal.grounding
  const currentReport = !!alignment && grounding?.alignmentRevision === alignment.revision
  return <article aria-label="目标详情" hidden={!visible}>
    <h2>{goal.title || '待定义目标'}</h2><p className="mobile-goals-body">{goal.description || '目标原意尚未整理。'}</p>
    <button onClick={() => edit(!editing)}>编辑目标正文</button>
    {editing && <form onSubmit={event => { event.preventDefault(); const patch = { ...(title !== baseline.current.title ? { title } : {}), ...(description !== baseline.current.description ? { description } : {}) }; if (Object.keys(patch).length) void save(patch) }}>
      <label>标题<TextInput value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>目标原意<ComposerTextarea value={description} onValueChange={setDescription} /></label>
      <button disabled={saving}>保存正文</button>
    </form>}
    {Object.entries(saveMessages).map(([field, text]) => <p key={field} role="status">{field}：{text}</p>)}
    {!!unknownWrites.length && <details open><summary>回执未确认的保存</summary>{unknownWrites.map(write => <div key={write.operationId}><p role="status">{write.issue}；原操作仍未确认，其他字段的保存不代签此次结果。</p><code>{write.operationId}</code><pre>{JSON.stringify(write.patch, null, 2)}</pre><button onClick={refresh}>读取当前目标核对</button></div>)}</details>}
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
