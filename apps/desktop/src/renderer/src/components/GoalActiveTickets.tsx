import { useEffect, useMemo, useState } from 'react'
import { formatAmuxObjectLink } from '@agentmux/core/sharing'
import type { GoalActivePlanResult } from '@agentmux/core/goal-delegation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { api } from '../lib/api'
import type { DemandRecord } from '../lib/global-demand-board'
import { GoalPlanMark, goalPlanStateLabel } from './GoalPlanState'
import { SurfaceState } from './SurfaceState'

const Disclosure = semanticIconComponent('navigation.disclosure')
const states = ['review', 'changes', 'ready', 'working', 'unknown'] as const

export function GoalActiveTickets({ demands, project, query, onOpen, onShowGoals, onClearConditions }: {
  demands: Readonly<Record<string, DemandRecord>>
  project: string
  query: string
  onOpen(trigger: HTMLButtonElement): void
  onShowGoals(): void
  onClearConditions(): void
}) {
  const [read, setRead] = useState<{ result: GoalActivePlanResult | null; issue?: string }>({ result: null })
  const [retry, setRetry] = useState(0)
  const [linkIssue, setLinkIssue] = useState<string>()
  useEffect(() => {
    let disposed = false
    let reading = false
    let invalidated = false
    async function refresh() {
      invalidated = true
      if (reading) return
      reading = true
      while (invalidated && !disposed) {
        invalidated = false
        try {
          const result = await api.demands.delegation('goal.plan.active', { view: 'manage' })
          if (!disposed) setRead({ result })
        } catch (error) {
          if (!disposed) setRead(previous => ({ ...previous, issue: error instanceof Error ? error.message : String(error) }))
        }
      }
      reading = false
    }
    const stopChanges = api.demands.onChanged(() => void refresh())
    const stopIssues = api.demands.onObservationIssue(message => {
      if (message) setRead(previous => ({ ...previous, issue: message }))
    })
    void refresh()
    return () => { disposed = true; stopChanges(); stopIssues() }
  }, [retry])

  const groups = useMemo(() => {
    type Row = { goalId: string; title: string; project: string | null; node: GoalActivePlanResult['goals'][number]['nodes'][number] }
    const groups = new Map<Row['node']['state'], Row[]>()
    if (!read.result) return groups
    const { owner, goals } = read.result
    const normalized = query.trim().toLocaleLowerCase()
    for (const { goalId, nodes } of goals) {
      const demand = demands[goalId]
      const goal = demand?.address?.runtimeId === owner.runtimeId && demand.address.namespace === owner.namespace ? demand : undefined
      if (project !== 'all' && goal?.projectId !== project) continue
      const title = goal?.title ?? `Goal ${goalId}`
      for (const node of nodes) {
        if (normalized && !`${node.title} ${title} ${goal?.projectName ?? ''}`.toLocaleLowerCase().includes(normalized)) continue
        const row = { goalId, title, project: goal?.projectName ?? null, node }
        const rows = groups.get(node.state)
        if (rows) rows.push(row)
        else groups.set(node.state, [row])
      }
    }
    return groups
  }, [read.result, demands, project, query])

  async function open(goalId: string, nodeId: string, trigger: HTMLButtonElement) {
    if (!read.result) return
    setLinkIssue(undefined)
    onOpen(trigger)
    try {
      await api.ui.openObjectLink(formatAmuxObjectLink({ kind: 'goal', goalId, nodeId, ...read.result.owner }))
    } catch (error) {
      setLinkIssue(error instanceof Error ? error.message : String(error))
    }
  }

  const filtered = project !== 'all' || Boolean(query.trim())
  return <div className="goals-collection goals-collection--tickets" role="region" aria-label="Active tickets">
    {read.issue ? <div className="goals-service goals-ticket-service" role="status">
      {read.result ? 'Ticket updates are unconfirmed. Showing the last confirmed list.' : 'Active tickets are unavailable.'}
      <span>{read.issue}</span>
      <button type="button" className="small-button" onClick={() => setRetry(current => current + 1)}>Refresh tickets</button>
    </div> : null}
    {linkIssue ? <p className="goals-service goals-ticket-service" role="status">{linkIssue}</p> : null}
    {!read.result && !read.issue ? <p className="goals-empty" role="status">Reading active tickets…</p> : null}
    {read.result && !read.issue && !groups.size ? <SurfaceState layout="inline" className="goals-empty"
      title={filtered ? 'No tickets match this view.' : 'No active tickets.'}
      description={filtered ? undefined : 'Open a Goal to read its plan or continue work without a plan.'}
      actions={<button type="button" className="small-button" onClick={filtered ? onClearConditions : onShowGoals}>{filtered ? 'Clear search and filters' : 'Show goals'}</button>} /> : null}
    {groups.size ? <div className="goals-list">
      {states.map(state => {
        const rows = groups.get(state)
        return rows ? <section key={state} className="goals-group">
          <h2 className="goals-group__heading"><GoalPlanMark item={{ state }} />{state === 'unknown' ? 'Needs a check' : goalPlanStateLabel({ state, unknown: [] })}<span className="goals-group__count">{rows.length}</span></h2>
          {rows.map(({ goalId, title, project, node }) => <button key={`${goalId}:${node.nodeId}`} type="button" className="goals-row goals-ticket-row"
            data-active-ticket={node.nodeId} onClick={event => void open(goalId, node.nodeId, event.currentTarget)}>
            <span className="goals-row__copy"><strong>{node.title}</strong><span className="goals-row__facts">
              <span>{title}{project ? ` · ${project}` : ''}</span>
              {node.state === 'unknown' && node.unknown.length ? <span>{goalPlanStateLabel(node)}</span> : null}
            </span></span>
            <Disclosure size={13} aria-hidden="true" />
          </button>)}
        </section> : null
      })}
    </div> : null}
  </div>
}
