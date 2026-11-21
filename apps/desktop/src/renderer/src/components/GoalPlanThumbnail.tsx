import { useMemo } from 'react'
import type { GoalPlanNodeState } from '@agentmux/demand/goal-plan'
import { goalPlanEdgePath } from '../lib/goal-plan-routing'
import type { DemandProjection } from '../lib/global-demand-board'

type GraphNode = { id: string; column: number; state: GoalPlanNodeState | null; dependsOn: readonly string[] }

function thumbnail(nodes: readonly GraphNode[]) {
  const counts = new Map<number, number>()
  let lastColumn = 0, rows = 0
  for (const { column } of nodes) {
    const count = (counts.get(column) ?? 0) + 1
    counts.set(column, count)
    rows = Math.max(rows, count)
    lastColumn = Math.max(lastColumn, column)
  }
  const width = (lastColumn + 2) * 24 + 12, height = Math.max(rows, 2) * 12
  const positions = new Map<number, number>()
  const points = nodes.map(node => {
    const row = positions.get(node.column) ?? 0
    positions.set(node.column, row + 1)
    return { ...node, x: 6 + (node.column + 1) * 24, y: height / 2 + (row - ((counts.get(node.column) ?? 1) - 1) / 2) * 12 }
  })
  const byId = new Map(points.map(point => [point.id, point]))
  const predecessors = new Set(nodes.flatMap(node => node.dependsOn))
  const start = { x: 6, y: height / 2 }, finish = { x: width - 6, y: height / 2 }
  const edges = points.flatMap(point => {
    const incoming = point.dependsOn.length
      ? point.dependsOn.flatMap(id => { const source = byId.get(id); return source ? [goalPlanEdgePath(source, point)] : [] })
      : [goalPlanEdgePath(start, point)]
    return predecessors.has(point.id) ? incoming : [...incoming, goalPlanEdgePath(point, finish)]
  })
  return { width, height, points, edges: edges.join(' '), start, finish }
}

/** The thumbnail reads the owner layout directly, without mounting the interactive detail graph. */
export function GoalPlanThumbnail({ demand: { plan, planState } }: { demand: Pick<DemandProjection, 'plan' | 'planState'> }) {
  const graph = useMemo(() => {
    if (!plan?.nodes.length) return thumbnail([{ id: '', column: 0, state: null, dependsOn: [] }])
    if (!planState) return null
    const states = new Map(planState.nodes.map(node => [node.id, node]))
    const nodes: GraphNode[] = []
    for (const node of plan.nodes) {
      const state = states.get(node.id)
      if (!state) return null
      nodes.push({ id: node.id, column: state.column, state: state.state, dependsOn: node.dependsOn })
    }
    return thumbnail(nodes)
  }, [plan, planState])
  if (!graph) return null
  return <svg className="goal-card-workflow" data-goal-workflow-preview role="img"
    aria-label={plan?.nodes.length ? 'Goal workflow preview' : 'Single-step Goal workflow'}
    viewBox={`0 0 ${graph.width} ${graph.height}`} preserveAspectRatio="xMinYMid meet">
    <path d={graph.edges} className="goal-card-workflow__edges" />
    <circle cx={graph.start.x} cy={graph.start.y} r="2" className="goal-card-workflow__boundary" />
    {graph.points.map(node => <circle key={node.id} cx={node.x} cy={node.y} r="3.2" data-ticket-state={node.state ?? 'whole-goal'} />)}
    <rect x={graph.finish.x - 2} y={graph.finish.y - 2} width="4" height="4" rx=".5" className="goal-card-workflow__boundary" />
  </svg>
}
