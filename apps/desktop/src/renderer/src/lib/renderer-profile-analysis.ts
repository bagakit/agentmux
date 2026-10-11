import type { RendererV8Profile } from '@agentmux/core/control'

export type ProfileFrame = { id: number; name: string; url: string; line: number; selfMs: number; totalMs: number; children: number[] }
export type ProfileAnalysis = { frames: Map<number, ProfileFrame>; root: number; sampledMs: number; samples: number
  modules: { url: string; selfMs: number; samples: number }[] }
export type ProfileAnalysisResult = { data: ProfileAnalysis; reason: null } | { data: null; reason: string }

/** A projection of original sample weights, never a second profiler or CPU estimate. */
export function analyseRendererProfile(profile: RendererV8Profile): ProfileAnalysisResult {
  const unavailable = (reason: string): ProfileAnalysisResult => ({ data: null, reason })
  if (!profile.samples?.length || !profile.timeDeltas?.length) return unavailable('No weighted V8 samples were returned. The original profile remains available.')
  if (profile.nodes.length > 50000 || profile.samples.length > 1000000) return unavailable('This profile exceeds the interactive analysis budget. Export the original profile for offline analysis.')
  if (profile.samples.length !== profile.timeDeltas.length) return unavailable('Sample weights are incomplete. Export the original profile to inspect it.')
  const frames = new Map<number, ProfileFrame>(), parents = new Map<number, number>()
  for (const node of profile.nodes) {
    if (frames.has(node.id)) return unavailable('The profile call tree has duplicate identities.')
    frames.set(node.id, { id: node.id, name: node.callFrame.functionName || '(anonymous)', url: node.callFrame.url,
      line: node.callFrame.lineNumber, selfMs: 0, totalMs: 0, children: node.children ?? [] })
    for (const child of node.children ?? []) {
      if (parents.has(child)) return unavailable('The profile call tree has ambiguous parents.')
      parents.set(child, node.id)
    }
  }
  const roots = [...frames.keys()].filter(id => !parents.has(id))
  if (roots.length !== 1) return unavailable('The profile call tree has no unique root.')
  const ordered: number[] = [], pending = [roots[0]!], seen = new Set<number>()
  while (pending.length) {
    const id = pending.pop()!, frame = frames.get(id)
    if (!frame || seen.has(id)) return unavailable('The profile call tree is incomplete or cyclic.')
    seen.add(id); ordered.push(id); pending.push(...frame.children)
  }
  if (ordered.length !== frames.size) return unavailable('Some profile frames are disconnected.')
  const modules = new Map<string, { url: string; selfMs: number; samples: number }>()
  let sampledMs = 0
  for (let index = 0; index < profile.samples.length; index++) {
    const frame = frames.get(profile.samples[index]!), weight = profile.timeDeltas[index]! / 1000
    if (!frame || !Number.isFinite(weight) || weight < 0) return unavailable('The profile contains an invalid sample weight.')
    frame.selfMs += weight; sampledMs += weight
    const url = frame.url || '(runtime / no script)', module = modules.get(url) ?? { url, selfMs: 0, samples: 0 }
    module.selfMs += weight; module.samples++; modules.set(url, module)
  }
  if (sampledMs === 0) return unavailable('All sample weights are zero. No timing attribution is available.')
  for (let index = ordered.length - 1; index >= 0; index--) {
    const frame = frames.get(ordered[index]!)!
    frame.totalMs = frame.selfMs + frame.children.reduce((total, id) => total + frames.get(id)!.totalMs, 0)
  }
  return { reason: null, data: { frames, root: roots[0]!, sampledMs, samples: profile.samples.length,
    modules: [...modules.values()].sort((a, b) => b.selfMs - a.selfMs || a.url.localeCompare(b.url)) } }
}

/** One bounded zoom level; unpainted frames remain in the original analysis and export. */
export function profileFlameRows(analysis: ProfileAnalysis, root: number, maxRows = 12) {
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
