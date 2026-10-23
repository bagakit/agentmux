import type { Graph, Subgraph, Viz } from '@viz-js/viz'
import { CollaborationBoundsIndex, type CollaborationBounds } from './collaboration-spatial-index'

export type CanvasLayoutInput = {
  nodes: { id: string; width: number; height: number; areaId?: string }[]
  edges: { source: string; target: string }[]
}

const GAP = 24
let engine: Promise<Viz> | undefined
async function graphviz(): Promise<Viz> {
  engine ??= import('@viz-js/viz').then(module => module.instance()).catch(error => { engine = undefined; throw error })
  return engine
}

const expand = (box: CollaborationBounds, amount: number): CollaborationBounds => ({
  x: box.x - amount, y: box.y - amount, width: box.width + amount * 2, height: box.height + amount * 2,
})

/** Clustered force-directed layout (fdp): Note areas frame their members while multi-host shared blocks bridge between clusters. */
export async function arrangeNoteCanvas(input: CanvasLayoutInput): Promise<Record<string, { x: number; y: number }>> {
  if (!input.nodes.length) return {}
  const viz = await graphviz()
  const byId = new Map(input.nodes.map(node => [node.id, node]))
  const areaOf = (id: string) => {
    const node = byId.get(id)
    return node?.areaId && byId.has(node.areaId) ? node.areaId : id
  }
  const clusterMembers = new Map<string, typeof input.nodes>()
  for (const node of input.nodes) {
    const areaId = areaOf(node.id), list = clusterMembers.get(areaId) ?? []
    list.push(node); clusterMembers.set(areaId, list)
  }
  const usedNames = new Set(input.nodes.map(node => node.id))
  const clusters = new Map<string, Subgraph>()
  const graph: Graph = {
    directed: false,
    graphAttributes: { start: 42, overlap: 'prism', sep: `+${GAP}`, splines: false, pack: 28, K: 1.1 },
    nodeAttributes: { shape: 'box', fixedsize: true, label: '', margin: 0 },
    nodes: [],
    subgraphs: [],
    edges: [],
  }
  const toVizNode = (node: typeof input.nodes[number]) => ({
    name: node.id,
    attributes: { width: node.width / 72, height: node.height / 72 },
  })
  for (const [areaId, members] of clusterMembers) {
    if (members.length > 1) {
      let name = 'cluster_' + areaId
      while (usedNames.has(name)) name += '_'
      usedNames.add(name)
      const cluster: Subgraph = { name, graphAttributes: { margin: 20 }, nodes: members.map(toVizNode), edges: [] }
      clusters.set(areaId, cluster); graph.subgraphs!.push(cluster)
    } else {
      graph.nodes!.push(toVizNode(members[0]!))
    }
  }
  const pairs = new Set<string>()
  for (const edge of input.edges) {
    if (edge.source === edge.target || !byId.has(edge.source) || !byId.has(edge.target)) continue
    const key = JSON.stringify([edge.source, edge.target].sort())
    if (pairs.has(key)) continue
    pairs.add(key)
    const sourceArea = areaOf(edge.source), targetArea = areaOf(edge.target)
    const cluster = sourceArea === targetArea ? clusters.get(sourceArea) : undefined
    ;(cluster ?? graph).edges!.push({ tail: edge.source, head: edge.target })
  }
  let result: { objects?: { name: string; pos?: string }[] }
  try {
    result = viz.renderJSON(graph, { engine: 'fdp', yInvert: true }) as { objects?: { name: string; pos?: string }[] }
  } catch (error) {
    engine = undefined
    throw error
  }
  const rawPositions = new Map<string, { x: number; y: number }>()
  for (const item of result.objects ?? []) {
    const node = byId.get(item.name), [x, y] = (item.pos ?? '').split(',').map(Number)
    if (node && Number.isFinite(x) && Number.isFinite(y)) {
      rawPositions.set(node.id, { x: Math.round(x! - node.width / 2), y: Math.round(y! - node.height / 2) })
    }
  }
  if (rawPositions.size !== input.nodes.length) throw new Error('Layout did not return every original Note. Your positions are kept.')
  const occupied = new CollaborationBoundsIndex<CollaborationBounds>([])
  const positions: Record<string, { x: number; y: number }> = {}
  for (const node of input.nodes) {
    const base = rawPositions.get(node.id)!
    let candidate: CollaborationBounds = { x: base.x, y: base.y, width: node.width, height: node.height }
    if (occupied.query(expand(candidate, GAP / 2)).length) {
      const stepX = node.width + GAP, stepY = node.height + GAP, extent = occupied.extent!
      const rings = Math.ceil(Math.max(Math.abs(extent.x - candidate.x), Math.abs(extent.x + extent.width - candidate.x)) / stepX
        + Math.max(Math.abs(extent.y - candidate.y), Math.abs(extent.y + extent.height - candidate.y)) / stepY) + 2
      search: for (let ring = 1; ring <= rings; ring++) {
        const offsets: { x: number; y: number }[] = []
        for (let index = -ring; index <= ring; index++) {
          offsets.push({ x: index, y: -ring }, { x: index, y: ring })
          if (Math.abs(index) !== ring) offsets.push({ x: -ring, y: index }, { x: ring, y: index })
        }
        offsets.sort((a, b) => (a.x * stepX) ** 2 + (a.y * stepY) ** 2 - (b.x * stepX) ** 2 - (b.y * stepY) ** 2)
        for (const offset of offsets) {
          const next = { ...candidate, x: candidate.x + offset.x * stepX, y: candidate.y + offset.y * stepY }
          if (!occupied.query(expand(next, GAP / 2)).length) { candidate = next; break search }
        }
      }
    }
    occupied.add(candidate)
    positions[node.id] = { x: candidate.x, y: candidate.y }
  }
  return positions
}
