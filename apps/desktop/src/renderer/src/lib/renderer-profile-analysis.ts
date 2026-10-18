import type { V8ProfileAnalysis } from '@agentmux/core/control'

/** One bounded zoom level; unpainted frames remain in the original analysis and export. */
export function profileFlameRows(analysis: V8ProfileAnalysis, root: number, maxRows = 12) {
  const rows: { id: number; depth: number; left: number; width: number }[] = []
  const total = analysis.frames.get(root)?.totalMs ?? 0
  const pending = [{ id: root, depth: 0, left: 0 }]
  let omitted = 0
  while (pending.length) {
    const item = pending.pop()!, frame = analysis.frames.get(item.id)!
    if (frame.totalMs === 0) continue
    if (item.depth >= maxRows || rows.length >= 300) { omitted++; continue }
    const width = frame.totalMs / total * 100
    rows.push({ ...item, width })
    let left = item.left
    for (const id of frame.children) {
      const child = analysis.frames.get(id)!
      pending.push({ id, depth: item.depth + 1, left }); left += child.totalMs / total * 100
    }
  }
  return { rows, omitted }
}
