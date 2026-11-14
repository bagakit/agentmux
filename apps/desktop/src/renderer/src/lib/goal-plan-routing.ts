// Geometry is local to the canvas. A column is the depth computed by the Goal owner.
export type GoalPlanBox = { left: number; right: number; top: number; bottom: number; column: number }
export type GoalPlanEdge = { from: string; to: string; live: boolean; boundary?: 'start' | 'finish'; d: string }
type Point = { x: number; y: number }
type Task = { id: string; dependsOn: string[]; live: boolean; box: GoalPlanBox }
type Link = Omit<GoalPlanEdge, 'd'> & {
  source: GoalPlanBox; target: GoalPlanBox; startY: number; endY: number
  corridor?: { left: number; right: number; y: number }
}

function curve(from: Point, to: Point) {
  const middle = (from.x + to.x) / 2
  return `C ${middle} ${from.y}, ${middle} ${to.y}, ${to.x} ${to.y}`
}
export function goalPlanEdgePath(from: Point, to: Point): string {
  return `M ${from.x} ${from.y} ${curve(from, to)}`
}
const center = (box: GoalPlanBox) => (box.top + box.bottom) / 2

// For a link that skips columns, find a clear horizontal band between the actual cards.
// A crowded column can always be skirted above or below inside the canvas padding.
function corridorY(blockers: GoalPlanBox[], desired: number, prior: number[]): number {
  const clearance = 6
  const bands: { top: number; bottom: number }[] = []
  for (const box of blockers.sort((a, b) => a.top - b.top)) {
    const last = bands.at(-1)
    if (last && box.top - clearance <= last.bottom) last.bottom = Math.max(last.bottom, box.bottom + clearance)
    else bands.push({ top: box.top - clearance, bottom: box.bottom + clearance })
  }
  const above = bands[0]!.top, below = bands.at(-1)!.bottom
  const candidates = [above, below, Math.min(above, desired), Math.max(below, desired)]
  for (let index = 1; index < bands.length; index++) {
    const top = bands[index - 1]!.bottom, bottom = bands[index]!.top
    candidates.push(top, (top + bottom) / 2, bottom, Math.min(bottom, Math.max(top, desired)))
  }
  const score = (y: number) => Math.abs(y - desired) + (prior.some(used => Math.abs(used - y) < clearance) ? 120 : 0)
  return candidates.reduce((best, y) => score(y) < score(best) ? y : best)
}

export function goalPlanEdges(tasks: Task[], start: GoalPlanBox, finish: GoalPlanBox): GoalPlanEdge[] {
  const tasksById = new Map(tasks.map(task => [task.id, task]))
  const hasChildren = new Set(tasks.flatMap(task => task.dependsOn))
  const columns = new Map<number, GoalPlanBox[]>()
  for (const box of [start, ...tasks.map(task => task.box), finish]) {
    const group = columns.get(box.column) ?? []
    group.push(box)
    columns.set(box.column, group)
  }
  const links: Link[] = []
  const inputs = new Map<GoalPlanBox, Link[]>(), outputs = new Map<GoalPlanBox, Link[]>()
  function add(source: GoalPlanBox, target: GoalPlanBox, from: string, to: string, live: boolean, boundary?: GoalPlanEdge['boundary']) {
    if (target.left <= source.right) return // stacked reading layout
    const link: Link = { from, to, source, target, live, startY: center(source), endY: center(target), ...(boundary ? { boundary } : {}) }
    if (target.column > source.column + 1) {
      const between: GoalPlanBox[] = []
      for (let column = source.column + 1; column < target.column; column++) between.push(...(columns.get(column) ?? []))
      const left = Math.min(...between.map(box => box.left)), right = Math.max(...between.map(box => box.right))
      if (between.length && left > source.right && right < target.left) {
        const occupied = links.flatMap(({ corridor }) => corridor && corridor.left < right && left < corridor.right ? [corridor.y] : [])
        link.corridor = { left, right, y: corridorY(between, (link.startY + link.endY) / 2, occupied) }
      }
    }
    links.push(link)
    const incoming = inputs.get(target) ?? [], outgoing = outputs.get(source) ?? []
    incoming.push(link)
    outgoing.push(link)
    inputs.set(target, incoming)
    outputs.set(source, outgoing)
  }
  for (const task of tasks) {
    if (!task.dependsOn.length) add(start, task.box, '', task.id, false, 'start')
    for (const dependency of task.dependsOn) {
      const source = tasksById.get(dependency)
      if (source) add(source.box, task.box, source.id, task.id, task.live)
    }
    if (!hasChildren.has(task.id)) add(task.box, finish, task.id, '', false, 'finish')
  }
  for (const [groups, side] of [[outputs, 'startY'], [inputs, 'endY']] as const) {
    for (const [box, edges] of groups) {
      if (edges.length === 1) continue
      const approach = (link: Link) => link.corridor?.y ?? center(side === 'startY' ? link.target : link.source)
      edges.sort((a, b) => approach(a) - approach(b))
      const spacing = Math.min(11, Math.max(0, box.bottom - box.top - 16) / (edges.length - 1))
      edges.forEach((edge, index) => { edge[side] = center(box) + (index - (edges.length - 1) / 2) * spacing })
    }
  }
  return links.map(({ source, target, startY, endY, corridor, ...edge }) => {
    const from = { x: source.right, y: startY }, to = { x: target.left, y: endY }
    const d = corridor
      ? `${goalPlanEdgePath(from, { x: corridor.left, y: corridor.y })} L ${corridor.right} ${corridor.y} ${curve({ x: corridor.right, y: corridor.y }, to)}`
      : goalPlanEdgePath(from, to)
    return { ...edge, d }
  })
}
