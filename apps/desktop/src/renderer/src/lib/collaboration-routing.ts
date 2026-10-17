import type { Viz } from '@viz-js/viz'
import type { CollaborationRelation } from './agent-collaboration'
export type CollaborationBox = { id: string; x: number; y: number; width: number; height: number; heading?: boolean }
export type CollaborationConnection = { id: string; source: string; target: string; kind: CollaborationRelation['kind'] }
export type CollaborationPath = { path: string; labelX: number; labelY: number }
let engine: Promise<Viz> | undefined
const ports = ['communication-out', 'communication-in', 'creation-out', 'creation-in', 'supervision-out', 'supervision-in']

/** Graphviz routes around fixed card rectangles. It cannot move an Agent or change a relation. */
export async function routeCollaboration(boxes: readonly CollaborationBox[], connections: readonly CollaborationConnection[], signal?: AbortSignal): Promise<Record<string, CollaborationPath>> {
  signal?.throwIfAborted()
  if (!connections.length) return {}
  engine ??= import('@viz-js/viz').then(module => module.instance()).catch(error => { engine = undefined; throw error })
  const viz = await engine
  signal?.throwIfAborted()
  const originals = new Map(boxes.map(box => [box.id, box]))
  const result = viz.renderJSON({ directed: true, graphAttributes: { notranslate: true, splines: true }, nodeAttributes: { shape: 'box', fixedsize: true, label: '', margin: 0 },
    nodes: boxes.map(box => ({ name: box.id, attributes: { pos: `${box.x + box.width / 2},${-box.y - box.height / 2}!`, width: box.width / 72, height: box.height / 72,
      ...(box.heading ? {} : { label: { html: `<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="0" WIDTH="${box.width}" HEIGHT="${box.height}" FIXEDSIZE="TRUE">${ports.map(port => `<TR><TD PORT="${port}" WIDTH="${box.width}" HEIGHT="${Math.floor(box.height / ports.length)}" FIXEDSIZE="TRUE"></TD></TR>`).join('')}</TABLE>` } }) } })),
    edges: connections.map(connection => {
      const from = originals.get(connection.source)!, to = originals.get(connection.target)!, forward = from.x <= to.x
      return { tail: connection.source, head: connection.target, attributes: { id: connection.id, arrowhead: 'none', tailport: `${connection.kind}-out:${forward ? 'e' : 'w'}`, headport: `${connection.kind}-in:${forward ? 'w' : 'e'}` } }
    })
  }, { engine: 'nop2', yInvert: true }) as { objects: { name: string; pos: string }[]; edges: { id: string; _draw_: { op: string; points?: number[][] }[] }[] }
  const origin = result.objects[0]!, box = originals.get(origin.name)!, [x, y] = origin.pos.split(',').map(Number)
  const dx = box.x + box.width / 2 - x!, dy = box.y + box.height / 2 - y!
  for (const position of result.objects) {
    const original = originals.get(position.name)!, [px, py] = position.pos.split(',').map(Number)
    if (Math.abs(px! + dx - original.x - original.width / 2) > .1 || Math.abs(py! + dy - original.y - original.height / 2) > .1) throw Error('Connection routing changed a fixed card position.')
  }
  const paths: Record<string, CollaborationPath> = {}
  for (const edge of result.edges) {
    const points = edge._draw_.find(draw => draw.op === 'b')?.points?.map(point => [point[0]! + dx, point[1]! + dy])
    if (!points || points.length < 4 || (points.length - 1) % 3) throw Error('Connection routing did not return an original curve.')
    const start = points[0]!, commands = [`M ${start[0]} ${start[1]}`]
    for (let index = 1; index < points.length; index += 3) commands.push('C ' + points.slice(index, index + 3).map(point => point.join(' ')).join(' '))
    const middle = Math.floor((points.length - 1) / 6) * 3, segment = points.slice(middle, middle + 4)
    paths[edge.id] = { path: commands.join(' '), labelX: (segment[0]![0]! + 3 * segment[1]![0]! + 3 * segment[2]![0]! + segment[3]![0]!) / 8,
      labelY: (segment[0]![1]! + 3 * segment[1]![1]! + 3 * segment[2]![1]! + segment[3]![1]!) / 8 }
  }
  if (Object.keys(paths).length !== connections.length) throw Error('Some recorded connections could not be routed. Their sources remain readable.')
  return paths
}
