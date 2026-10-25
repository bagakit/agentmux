import { AgentMuxError } from './errors.js'
import { parseV8Profile, V8_PROFILE_MAX_BYTES, type V8Profile } from './v8-profile.js'

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
export function analyseV8Profile(profile: V8Profile): V8ProfileAnalysisResult {
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

/** Parse only explicit original artifact bytes; no IO, normalization or capture. */
export function parseV8ProfileBytes(bytes: Uint8Array): V8Profile {
  if (bytes.byteLength > V8_PROFILE_MAX_BYTES)
    throw new AgentMuxError('The selected profile exceeds the original 8 MiB profile budget.', 'INVALID_CLI_ARGUMENT')
  let original: unknown
  try { original = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new AgentMuxError('The selected file is not valid profile JSON. No capture was started.', 'INVALID_CLI_ARGUMENT') }
  return parseV8Profile(original)
}

export type V8ProfileArtifactSource = { sha256: string; bytes: number; captureIdentity: 'unavailable-in-bare-profile' }

export function summariseV8Profile(analysis: V8ProfileAnalysisResult, source: V8ProfileArtifactSource) {
  if (!analysis.data) return { schema: 'agentmux.v8-profile-analysis.v1' as const, status: 'unavailable' as const, source, reason: analysis.reason }
  const data = analysis.data
  // Fixed rows, bounded labels and caller paths avoid duplicating the whole input.
  const label = (value: string) => value.slice(0, 128)
  const position = (frame: V8ProfileFrame) => ({ id: frame.id, name: label(frame.name), url: label(frame.url),
    scriptId: label(frame.scriptId), line: frame.line, column: frame.column,
    labelsTruncated: [frame.name, frame.url, frame.scriptId].some(value => value.length > 128) })
  const frames = [...data.frames.values()].filter(frame => frame.samples > 0).sort((a, b) => b.selfMs - a.selfMs || a.id - b.id)
  return {
    schema: 'agentmux.v8-profile-analysis.v1' as const, status: 'analysed' as const, source,
    interpretation: 'Original generated-script sample weights only; not process CPU, source symbolication, native/worker coverage or a leak diagnosis. Raw originals remain unchanged. Positions are zero-based.',
    timing: { profileDurationMs: data.profileDurationMs, weightedMs: data.sampledMs,
      lastSampleTailMs: data.lastSampleTailMs, weightsExceedInterval: data.lastSampleTailMs < 0,
      maxSampleGapMs: data.maxSampleGapMs, samples: data.samples },
    weights: data.weights,
    modules: data.modules.slice(0, 12).map(module => ({ ...module, url: label(module.url), labelTruncated: module.url.length > 128 })),
    modulesOmitted: Math.max(0, data.modules.length - 12),
    frames: frames.slice(0, 12).map(frame => {
      const callers = []
      let parent = frame.parent
      while (parent !== null && callers.length < 12) {
        const caller = data.frames.get(parent)!
        callers.push(position(caller)); parent = caller.parent
      }
      return { ...position(frame), selfMs: frame.selfMs, inclusiveMs: frame.totalMs, samples: frame.samples,
        weightedSampleShare: frame.selfMs / data.sampledMs, callers, callersOmitted: parent !== null }
    }),
    framesOmitted: Math.max(0, frames.length - 12)
  }
}
