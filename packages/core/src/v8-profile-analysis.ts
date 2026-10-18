import type { RendererV8Profile } from './renderer-v8-profile.js'

export type V8ProfileWeightKind = 'script' | 'idle' | 'gc' | 'unattributed'
export type V8ProfileFrame = {
  id: number; name: string; url: string; scriptId: string; line: number; column: number
  selfMs: number; totalMs: number; samples: number; children: number[]; parent: number | null
}
export type V8ProfileAnalysis = {
  frames: Map<number, V8ProfileFrame>; root: number; sampledMs: number; samples: number
  profileDurationMs: number; lastSampleTailMs: number; maxSampleGapMs: number
  weights: Record<V8ProfileWeightKind, { selfMs: number; samples: number }>
  modules: { url: string; selfMs: number; samples: number }[]
}
export type V8ProfileAnalysisResult = { data: V8ProfileAnalysis; reason: null } | { data: null; reason: string }

function weightKind(frame: V8ProfileFrame): V8ProfileWeightKind {
  if (frame.url !== '' || frame.scriptId !== '0') return 'script'
  if (frame.line === -1 && frame.column === -1) {
    if (frame.name === '(idle)') return 'idle'
    if (frame.name === '(garbage collector)') return 'gc'
  }
  return 'unattributed'
}

/** Original sample weights, not process CPU or a source-map/module ownership claim. */
export function analyseV8Profile(profile: RendererV8Profile): V8ProfileAnalysisResult {
  const unavailable = (reason: string): V8ProfileAnalysisResult => ({ data: null, reason })
  if (!profile.samples?.length || !profile.timeDeltas?.length) return unavailable('No weighted V8 samples were returned. The original profile remains available.')
  if (profile.nodes.length > 50000 || profile.samples.length > 1000000) return unavailable('This profile exceeds the interactive analysis budget. Export the original profile for offline analysis.')
  if (profile.samples.length !== profile.timeDeltas.length) return unavailable('Sample weights are incomplete. Export the original profile to inspect it.')
  const profileDurationMs = (profile.endTime - profile.startTime) / 1000
  if (!Number.isFinite(profileDurationMs) || profileDurationMs < 0) return unavailable('The original profile interval is invalid.')
  const frames = new Map<number, V8ProfileFrame>(), parents = new Map<number, number>()
  for (const node of profile.nodes) {
    if (frames.has(node.id)) return unavailable('The profile call tree has duplicate identities.')
    frames.set(node.id, { id: node.id, name: node.callFrame.functionName || '(anonymous)', url: node.callFrame.url,
      scriptId: node.callFrame.scriptId, line: node.callFrame.lineNumber, column: node.callFrame.columnNumber,
      selfMs: 0, totalMs: 0, samples: 0, children: node.children ?? [], parent: null })
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
    frame.parent = parents.get(id) ?? null
    seen.add(id); ordered.push(id)
    // Iteration avoids overflowing the argument stack on a wide original tree.
    for (const child of frame.children) pending.push(child)
  }
  if (ordered.length !== frames.size) return unavailable('Some profile frames are disconnected.')
  const modules = new Map<string, { url: string; selfMs: number; samples: number }>()
  const weights: V8ProfileAnalysis['weights'] = {
    script: { selfMs: 0, samples: 0 }, idle: { selfMs: 0, samples: 0 },
    gc: { selfMs: 0, samples: 0 }, unattributed: { selfMs: 0, samples: 0 }
  }
  let sampledMs = 0, maxSampleGapMs = 0
  for (let index = 0; index < profile.samples.length; index++) {
    const frame = frames.get(profile.samples[index]!), weight = profile.timeDeltas[index]! / 1000
    if (!frame || !Number.isFinite(weight) || weight < 0) return unavailable('The profile contains an invalid sample weight.')
    sampledMs += weight
    if (!Number.isFinite(sampledMs)) return unavailable('The original sample weight sum is not finite.')
    frame.selfMs += weight; frame.samples++; maxSampleGapMs = Math.max(maxSampleGapMs, weight)
    const group = weights[weightKind(frame)]; group.selfMs += weight; group.samples++
    const url = frame.url, module = modules.get(url) ?? { url, selfMs: 0, samples: 0 }
    module.selfMs += weight; module.samples++; modules.set(url, module)
  }
  if (sampledMs === 0) return unavailable('All sample weights are zero. No timing attribution is available.')
  for (let index = ordered.length - 1; index >= 0; index--) {
    const frame = frames.get(ordered[index]!)!
    frame.totalMs = frame.selfMs + frame.children.reduce((total, id) => total + frames.get(id)!.totalMs, 0)
    if (!Number.isFinite(frame.totalMs)) return unavailable('The original inclusive weight sum is not finite.')
  }
  return { reason: null, data: { frames, root: roots[0]!, sampledMs, samples: profile.samples.length,
    profileDurationMs, lastSampleTailMs: profileDurationMs - sampledMs, maxSampleGapMs, weights,
    modules: [...modules.values()].sort((a, b) => b.selfMs - a.selfMs || a.url.localeCompare(b.url)) } }
}
