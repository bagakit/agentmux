export type CanvasLayoutInput = { nodes: { id: string; width: number; height: number }[]; edges: { source: string; target: string }[] }
/** Graphviz only chooses coordinates. Catalog identities, content and edges stay with their owners. */
export async function arrangeNoteCanvas(input: CanvasLayoutInput): Promise<Record<string, { x: number; y: number }>> {
  if (!input.nodes.length) return {}
  const { instance } = await import('@viz-js/viz')
  const viz = await instance()
  const graph = { directed: true, graphAttributes: { rankdir: 'LR', nodesep: .65, ranksep: 1.1, pad: .2 },
    nodeAttributes: { shape: 'box', fixedsize: true, label: '' },
    nodes: input.nodes.map(node => ({ name: node.id, attributes: { width: node.width / 72, height: node.height / 72 } })),
    edges: input.edges.filter(edge => edge.source !== edge.target).map(edge => ({ tail: edge.source, head: edge.target })) }
  const result = viz.renderJSON(graph, { engine: 'dot', yInvert: true }) as { objects?: { name: string; pos: string }[] }
  const byId = new Map(input.nodes.map(node => [node.id, node])), positions: Record<string, { x: number; y: number }> = {}
  for (const item of result.objects ?? []) {
    const node = byId.get(item.name), [x, y] = (item.pos ?? '').split(',').map(Number)
    if (node && Number.isFinite(x) && Number.isFinite(y)) positions[node.id] = { x: x! - node.width / 2, y: y! - node.height / 2 }
  }
  if (Object.keys(positions).length !== input.nodes.length) throw new Error('Layout did not return every original Note. Your positions are kept.')
  return positions
}
