import { demandAgentReferenceLabel } from '@agentmux/demand/relations'
import { MobileAvatarNoticeOutlet, MobileNotice, MobileNoticeScope } from '../notices/MobileNotice'
import { formatMobileTime, withMobileTime } from '../presentation/time'
import { mobileGoalStatus as statuses, mobileGoalOutcome } from './presentation'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { Button } from '@agentmux/client-ui/components/Button'
import goalsCompanions from '@agentmux/client-ui/brand/illustrations/goals/goals-companions-header.png'
import goalsEmpty from '@agentmux/client-ui/brand/illustrations/concepts/goals-companions.png'
import { MobileHeaderMenu } from '../navigation/MobileHeaderMenu'
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
import { MobileGoalEvidence } from './MobileGoalEvidence'
import type { MobileObjectIdentity } from '../navigation/MobileIdentity'
import { getDeviceWorkface } from '../recovery/device-workface'
import type { MobileGoalsContext } from '../recovery/presentation-route'
import type { MobileGoalDraftScope } from '../recovery/goal-drafts'
import { mobileGoalDraftSource, useGoalDraft } from './useGoalDraft'
import { MobileGoalDraftEditor } from './MobileGoalDraftEditor'
import { MobileWorkfaceFrame, MobileWorkfacePane } from '../layout/MobileWorkfaceFrame'
import { workfacePanes } from '../layout/workface-presentation'

export type MobileGoalsSurfaceProps = {
  client: AgentMuxHostedClient | null
  connected: boolean
  visible: boolean
  wide?: boolean
  openSession?: (id: string, identity: MobileObjectIdentity) => void
  onBackChange?(back: (() => void) | null): void
  initialContext?: MobileGoalsContext
  context?: MobileGoalsContext
  onContextChange?(context: MobileGoalsContext): void
  copyText?: ClientUiPlatform['copyText'] | undefined
}
const priorities = { low: '低', normal: '普通', high: '高', urgent: '紧急' }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
type Decisions = AgentMuxRpcResult<'goal.decisions'>['decisions']

/** The original Goal owner supplies all facts and validates all mutations. */
export function MobileGoalsSurface({ client, connected, visible, wide = false, openSession, onBackChange, initialContext, context: presentedContext, onContextChange, copyText }: MobileGoalsSurfaceProps) {
  const [createOpen, setCreateOpen] = useState(false)
  const [goals, setGoals] = useState<AgentMuxRpcGoal[] | null>(null)
  const [listStatus, setListStatus] = useState<string | null>(null)
  const [localContext, setLocalContext] = useState<MobileGoalsContext>(initialContext ?? { goalId: null, mode: 'detail', discussion: null })
  const context = presentedContext ?? localContext, contextRef = useRef(context); contextRef.current = context
  const setContext = useCallback((change: MobileGoalsContext | ((value: MobileGoalsContext) => MobileGoalsContext)) => {
    const next = typeof change === 'function' ? change(contextRef.current) : change
    contextRef.current = next; setLocalContext(next); onContextChange?.(next)
  }, [onContextChange])
  const selected = context.goalId, discussionTab = context.discussion
  const panes = workfacePanes({ active: visible, split: wide, hasSelection: Boolean(selected || discussionTab) })
  const listVisible = panes.navigation.observed
  const detailVisible = panes.content.observed && selected !== null && !discussionTab
  const directoryPane = useRef<HTMLDivElement>(null), workPane = useRef<HTMLDivElement>(null)
  const previousWide = useRef(wide)
  useLayoutEffect(() => {
    const compacted = previousWide.current && !wide; previousWide.current = wide
    if (compacted && visible && (selected || discussionTab) && directoryPane.current?.contains(document.activeElement)) workPane.current?.focus({ preventScroll: true })
  }, [wide, visible, selected, discussionTab])
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
    if (before && JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Mac 连接在读取期间已变化，请刷新核对。')
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
    if (!client?.forwardRpc || !listVisible) return
    let live = true, pending = false
    const read = async () => {
      if (pending) return
      pending = true
      const epoch = factEpoch.current.list
      try {
        const before = source()
        const result = await client.forwardRpc!('goal.ls', { limit: 1000, ...(status ? { status } : {}) })
        if (live && epoch === factEpoch.current.list) { listScope.current = readScope(before); setGoals(result.goals); setListStatus(status); setIssue('') }
      } catch (error) { if (live) setIssue(`读取目标失败：${message(error)}。可以刷新重试。`) }
      finally { pending = false }
    }
    void read()
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void read() }, 10000)
    const foreground = () => { if (document.visibilityState !== 'hidden') void read() }
    document.addEventListener('visibilitychange', foreground)
    return () => { live = false; clearInterval(timer); document.removeEventListener('visibilitychange', foreground) }
  }, [client, connected, listVisible, revision, status])
  useEffect(() => {
    if (!client?.forwardRpc || !selected || !detailVisible) return
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
        else setDetailIssue('Mac 上没有找到这个目标，可以刷新核对。')
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
  }, [client, connected, detailVisible, selected, revision])
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
    if (receipt.route !== 'discussion') return
    if (!navigation.current.visible || selectedRef.current !== receipt.goalId) return
    setContext(value => ({ ...value, discussion: { goalId: receipt.goalId, tabId: receipt.tabId, regionId: receipt.regionId, hostId: receipt.hostId, agentSessionId: receipt.agentSessionId } }))
    if (receipt.agentSessionId && receipt.hostId === 'local' && openSession) openSession(receipt.agentSessionId, { name: '目标 Mote', project: details[receipt.goalId]?.projectName ?? '未分配项目' })
  }
  const visibleGoals = useMemo(() => goals?.filter(goal => (!status || goal.status === status) && `${goal.title} ${goal.description} ${goal.projectName ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [goals, status, query])
  const confirmedEmpty = goals?.length === 0 && listStatus === '' && !status && !query && !issue
  return <MobileNoticeScope owner={client}><section className="mobile-goals" data-wide={wide || undefined} data-detail={Boolean(selected || discussionTab) || undefined} aria-label="Goals">
    <header className="mobile-page-header"><MobileHeaderMenu hidden={Boolean(selected || discussionTab)} />{(selected || discussionTab) && <button className="mobile-goals-back" aria-label={discussionTab ? '返回目标' : '返回目标列表'} onClick={discussionTab ? backToGoal : backToList}><SemanticIcon name="navigation.back" size={18} /><span>返回</span></button>}<h1>{selected ? details[selected]?.title ?? '目标' : discussionTab ? '目标讨论' : 'Goals'}</h1><div className="mobile-section-actions">{!selected && !discussionTab && <><button type="button" className="mobile-icon-button mobile-goals-new" aria-label="新建目标" title="新建目标" aria-expanded={createOpen} onClick={() => setCreateOpen(value => !value)}><SemanticIcon name="action.add-item" size={20} /></button><details className="mobile-goal-lookup"><summary aria-label="按 Goal ID 打开" title="按 Goal ID 打开"><SemanticIcon name="action.search" size={18} /><span className="mobile-visually-hidden">按 Goal ID 打开</span></summary><div className="mobile-goal-lookup__panel"><form onSubmit={event => {
        event.preventDefault()
        if (!client?.forwardRpc) { setLookupIssue('读取未发送：Mac 上的目标服务暂不可用。'); return }
        const goalId = lookup, sequence = ++lookupRead.current, epoch = factEpoch.current.goals[lookup] ?? 0, before = source()
        void client.forwardRpc('goal.inspect', { goalId }).then(result => {
          if (sequence !== lookupRead.current || epoch !== (factEpoch.current.goals[goalId] ?? 0)) return
          if (result.goal) { choose(result.goal, readScope(before)); setLookupIssue('') }
          else setLookupIssue('没有找到这个 Goal ID。')
        }).catch(error => { if (sequence === lookupRead.current && epoch === (factEpoch.current.goals[goalId] ?? 0)) setLookupIssue(`读取目标失败：${message(error)}。可以重试。`) })
      }}><label>Goal ID<TextInput aria-label="打开 Goal ID" value={lookup} onChange={event => setLookup(event.target.value)} required /></label><button>打开指定目标</button></form>{lookupIssue && <MobileNotice identity={[lookup,lookupIssue]} role="status">{lookupIssue}</MobileNotice>}</div></details></>}{visible && <MobileAvatarNoticeOutlet header />}<button className="mobile-icon-button mobile-goals-refresh" aria-label="刷新目标" title="刷新目标" onClick={() => refresh(value => value + 1)}><SemanticIcon name="action.refresh" size={18} /><span className="mobile-visually-hidden">刷新目标</span></button></div></header>
    <div className="mobile-goals-notices">{!connected && <MobileNotice owner={client} identity={[connected]} role="status">连接暂不可用，已读目标与草稿保留；可刷新核对。</MobileNotice>}
    {!client?.forwardRpc && <MobileNotice owner={client} role="status">Mac 上的目标服务暂不可用，已读目标仍可查看。</MobileNotice>}
    {issue && <MobileNotice identity={[issue]} role="status">{issue}</MobileNotice>}
    {goals?.length === 1000 && <MobileNotice identity={[goals?.length]} role="status">目录只读到前 1000 个目标，搜索只覆盖这些；其他目标可按 Goal ID 打开。</MobileNotice>}</div>
    {!selected && !discussionTab && <section className={`mobile-goals-start ${confirmedEmpty ? 'mobile-goals-start--empty' : 'mobile-goals-start--compact'}`} aria-label="目标工坊">
      <img className="mobile-goals-start__art" src={confirmedEmpty ? goalsEmpty : goalsCompanions} alt="" width={confirmedEmpty ? 160 : 32} height={confirmedEmpty ? 107 : 28} loading="lazy" decoding="async" />
      <div className="mobile-goals-start__copy"><strong>{confirmedEmpty ? '从一个想法开始' : '把目标落到成果'}</strong>{confirmedEmpty && <p>还没有目标。和 Mote 一起开始。</p>}</div>
      {!createOpen && <Button variant="primary" className="mobile-goals-start__create" aria-label="开始新目标" onClick={() => setCreateOpen(true)}><SemanticIcon name="action.add-item" size={16} />新建目标</Button>}
    </section>}
      <MobileGoalCreate client={client} expanded={createOpen} presented={selected === null && !discussionTab} visible={visible && selected === null && !discussionTab} openDiscussion={openDiscussion} beginPresentation={beginPresentation} created={(goal, present) => {
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
    <MobileWorkfaceFrame className="mobile-goals-layout" presentation={panes}>
    <MobileWorkfacePane className="mobile-goals-directory" ref={directoryPane} pane="navigation" presentation={panes.navigation}>
    <div>
      <div className="mobile-goals-filters"><TextInput aria-label="搜索目标" placeholder="搜索目标或项目" value={query} onChange={event => setQuery(event.target.value)} />
        <select aria-label="筛选工作状态" value={status} onChange={event => setStatus(event.target.value)}><option value="">全部状态</option>{AGENTMUX_DEMAND_STATUSES.map(value => <option key={value} value={value}>{statuses[value]}</option>)}</select></div>
      {goals === null ? <p>目标列表尚未确认。</p> : <>
        <ul className="mobile-goals-list">{(visibleGoals ?? []).map(goal => <li key={goal.id}>
          <button aria-current={selected === goal.id ? 'true' : undefined} onClick={() => choose(goal)}><SemanticIcon name="object.goal" size={24} /><div className="mobile-goal-row-copy"><strong>{goal.title || '待定义目标'}</strong><span>{goal.projectName ?? goal.projectId ?? '未分配项目'} · {statuses[goal.status]}</span><small>{goal.description}</small></div><SemanticIcon name="navigation.submenu" size={16} /></button>
        </li>)}</ul>
        {!goals.length && !confirmedEmpty && <p>{status || query ? '已读列表中没有匹配的目标。可清除搜索或筛选。' : listStatus ? '上次筛选没有匹配的目标，当前列表尚未确认。' : '上次读取没有目标，可刷新核对。'}</p>}
        {!!goals.length && !visibleGoals?.length && <p>已读列表中没有匹配的目标。可清除搜索或筛选。</p>}
      </>}

    </div>
    </MobileWorkfacePane>
    <MobileWorkfacePane className="mobile-goals-work" ref={workPane} pane="content" presentation={panes.content} tabIndex={-1} role="region" aria-label="目标工作面">
    {[...new Set([...Object.keys(details), ...(selected ? [selected] : [])])].map(id => { const detail = details[id]; return <div className="mobile-workface-readable" key={id} hidden={selected !== id || !!discussionTab}>{selected === id && [detailIssue, decisionIssue].filter(Boolean).map((value, index) => <MobileNotice identity={[id,value]} key={index} role="status">{value}</MobileNotice>)}
      <GoalDetail key={id} goalId={id} goal={detail ?? null} factScope={detailScopes[id] ?? null} presented={panes.content.presented && selected === id && !discussionTab} editing={context.mode === 'edit' && selected === id} edit={editing => setContext(value => ({ ...value, mode: editing ? 'edit' : 'detail' }))} decisions={decisions[id] ?? null} client={client} connected={connected} updated={updated} refresh={() => refresh(value => value + 1)} copyText={copyText}>
        {detail && <>
        <MobileGoalAlignment visible={panes.content.presented && selected === id && !discussionTab} client={client} goal={detail} updated={updated} openDiscussion={openDiscussion} beginPresentation={beginPresentation} />
        </>}
      </GoalDetail>
      {detail && <><MobileGoalSessions client={client} goal={detail} factScope={detailScopes[id] ?? null} sessionIds={detail.sessionIds} visible={detailVisible && selected === detail.id} openSession={openSession} />
      <details><summary>协作、关联与高级动作</summary>
      <MobileGoalLinks client={client} goal={detail} updated={updated} />
      <MobileGoalActions client={client} goal={detail} visible={detailVisible && selected === detail.id} updated={updated} deleted={deleted} />
      </details></>}
    </div> })}
    {discussionTab && <div>{discussionTab.regionId && discussionTab.hostId !== undefined
      ? <MobileZoneWorkface key={discussionTab.tabId} client={client} name="目标主 Mote" tabId={discussionTab.tabId} regionId={discussionTab.regionId}
        expectedAgent={discussionTab.agentSessionId && discussionTab.hostId ? { agentSessionId: discussionTab.agentSessionId, hostId: discussionTab.hostId } : null} visible={visible}
        openSession={(id, identity) => { if (id !== discussionTab.agentSessionId || discussionTab.hostId !== 'local') { setIssue('这个讨论在另一台 Mac 上，当前连接还打不开。'); return }; openSession?.(id, identity) }} />
      : <MobileNotice identity={[discussionTab.goalId, discussionTab.tabId, discussionTab.regionId, discussionTab.hostId, discussionTab.agentSessionId]} role="status">还没确认讨论所在的 Mac 和位置，请返回目标后重新打开讨论。</MobileNotice>}</div>}
    {wide && selected === null && !discussionTab && <p className="mobile-goals-unselected">选择一个目标，阅读正文与成果。</p>}
    </MobileWorkfacePane>
    </MobileWorkfaceFrame>
  </section></MobileNoticeScope>
}

function GoalDetail({ goalId, goal, factScope, presented, decisions, client, connected, updated, refresh, children, editing, edit, copyText }: {
  goalId: string; goal: AgentMuxRpcGoal | null; factScope: MobileGoalDraftScope | null; presented: boolean; decisions: Decisions | null; client: AgentMuxHostedClient | null; connected: boolean
  updated(goal: AgentMuxRpcGoal, fields: Array<keyof AgentMuxRpcGoal>): void; refresh(): void; children: ReactNode
  editing: boolean; edit(editing: boolean): void; copyText?: ClientUiPlatform['copyText'] | undefined
}) {
  const model = useGoalDraft(goalId, goal, factScope, client, connected, updated)
  const editor = <MobileGoalDraftEditor model={model} editing={editing} onEditingChange={edit} refresh={refresh} copyText={copyText} />
  if (!goal) return <article aria-label="目标详情" hidden={!presented}><h2>目标</h2><MobileNotice identity={[goalId]} role="status">还没读到这个目标，可以重新读取。</MobileNotice><code>{goalId}</code>{editor}<button onClick={refresh}>读取当前目标</button></article>
  const { saving, save } = model
  const alignment = goal.alignment, grounding = goal.grounding
  const currentReport = !!alignment && grounding?.alignmentRevision === alignment.revision
  return <article aria-label="目标详情" hidden={!presented}>
    {!editing && <><h2>{goal.title || '待定义目标'}</h2><p className="mobile-goals-body">{goal.description || '还没有目标说明。'}</p></>}
    {editor}
    <section aria-label="目标与成功标准"><h3>目标与成功标准</h3>
      {alignment ? <><p className="mobile-goals-body">{alignment.summary}</p><ul>{alignment.criteria.map(criterion => <li key={criterion.id}>{criterion.text}</li>)}</ul>
        {!alignment.criteria.length && <p>尚无成功标准。</p>}
        {!!alignment.openQuestions.length && <><h4>待决定事项</h4><ul>{alignment.openQuestions.map((question, index) => <li key={index}>{question}</li>)}</ul></>}
        <p>{alignment.confirmedAt === null ? '目标尚未确认。' : withMobileTime('目标已确认', alignment.confirmedAt)}</p>
      </> : <p>还没有目标提案。</p>}
    </section>
    <section aria-label="结果与证据"><h3>结果与证据</h3>
      {grounding ? <><p className="mobile-goals-body">{grounding.summary}</p>
        {(!alignment || grounding.alignmentRevision !== alignment.revision) && <MobileNotice identity={[goal.id,grounding.alignmentRevision,alignment?.revision]} role="status">此报告尚不能对应当前目标标准，请核对目标版本。</MobileNotice>}
        {(currentReport ? alignment?.criteria : [])?.filter(criterion => !grounding.checks.some(check => check.criterionId === criterion.id)).map(criterion => <p key={criterion.id}>缺少结果检查：{criterion.text}</p>)}
        <ul>{grounding.checks.map(check => <li key={check.criterionId}><strong>{currentReport ? alignment?.criteria.find(criterion => criterion.id === check.criterionId)?.text ?? check.criterionId : `旧报告标准 ${check.criterionId}`}</strong><p>{mobileGoalOutcome[check.outcome]}</p><p>{check.note}</p>
          <MobileGoalEvidence evidence={check.evidence} client={client} copyText={copyText} />{!check.evidence.length && <p>暂无定位证据。</p>}
        </li>)}</ul><p>{grounding.acceptedAt === null ? '尚未验收。' : withMobileTime(currentReport ? '已验收' : '旧报告曾通过验收，当前结果尚未验收', grounding.acceptedAt)}</p>
      </> : <p>{goal.status === 'done' ? '工作状态已完成，结果尚未核验。' : '尚无结果报告。'}</p>}
    </section>
    {children}
    <details><summary>工作状态与属性</summary>
      <label>工作状态<select disabled={saving} aria-label="工作状态" value={goal.status} onChange={event => { void save({ status: event.target.value as AgentMuxRpcGoal['status'] }) }}>{AGENTMUX_DEMAND_STATUSES.map(value => <option key={value} value={value}>{statuses[value]}</option>)}</select></label>
      <p>工作状态不代表目标确认或结果接受。</p>
      <label>优先级<select disabled={saving} aria-label="优先级" value={goal.priority} onChange={event => { void save({ priority: event.target.value as AgentMuxRpcGoal['priority'] }) }}>{AGENTMUX_DEMAND_PRIORITIES.map(value => <option key={value} value={value}>{priorities[value]}</option>)}</select></label>
      <dl><dt>目标 ID</dt><dd>{goal.id}</dd><dt>项目</dt><dd>{goal.projectId ? `${goal.projectName ?? '名称未确认'} · ${goal.projectId}` : '未分配项目'}</dd><dt>负责人</dt><dd>{goal.assigneeSessionIds?.map(demandAgentReferenceLabel).join('、') || '未分配'}</dd><dt>Supervisor</dt><dd>{goal.supervisorSessionId ? demandAgentReferenceLabel(goal.supervisorSessionId) : '未指定'}</dd><dt>标签</dt><dd>{goal.tags?.join('、') || '无'}</dd><dt>父目标</dt><dd>{goal.parentGoalId ?? '无'}</dd><dt>计划开始</dt><dd>{goal.plannedStartAt ? (formatMobileTime(goal.plannedStartAt) ?? '时间未记录') : '未设置'}</dd><dt>目标日期</dt><dd>{goal.targetAt ? (formatMobileTime(goal.targetAt) ?? '时间未记录') : '未设置'}</dd><dt>最后更新</dt><dd>{(formatMobileTime(goal.updatedAt) ?? '时间未记录')}</dd></dl>
    </details>
    <details><summary>活动与决策记录</summary><ul>{goal.activityLog?.map((entry, index) => <li key={index}>{entry}</li>)}</ul>
      {decisions === null ? <p>决策记录尚未确认。</p> : decisions.map((decision, index) => <div key={index}><p>{decision.question}</p><p>{decision.decision}</p><p>{decision.rationale}</p></div>)}
    </details>
    <button onClick={refresh}>读取当前目标</button>
  </article>
}
