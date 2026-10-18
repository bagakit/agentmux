import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import { parseRendererV8Profile, RENDERER_V8_PROFILE_MAX_BYTES } from './renderer-v8-profile.js'
import { analyseV8Profile, type V8ProfileFrame } from './v8-profile-analysis.js'

/** Explicit local artifact processing. No endpoint, capture or service state is consulted. */
export async function analyseLocalV8Profile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
    throw new AgentMuxError('The explicitly selected local profile could not be opened.', 'PROFILE_INPUT_UNAVAILABLE')
  })
  let bytes: Buffer
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > RENDERER_V8_PROFILE_MAX_BYTES)
      throw new AgentMuxError('Select a regular cpuprofile within the original 8 MiB profile budget.', 'INVALID_CLI_ARGUMENT')
    const buffer = Buffer.alloc(RENDERER_V8_PROFILE_MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, null)
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    if (length > RENDERER_V8_PROFILE_MAX_BYTES)
      throw new AgentMuxError('The selected profile grew beyond its original 8 MiB budget.', 'INVALID_CLI_ARGUMENT')
    bytes = buffer.subarray(0, length)
  } finally { await file.close() }
  let original: unknown
  try { original = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new AgentMuxError('The selected file is not valid profile JSON. No capture was started.', 'INVALID_CLI_ARGUMENT') }
  const profile = parseRendererV8Profile(original), analysis = analyseV8Profile(profile)
  const source = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    captureIdentity: 'unavailable-in-bare-profile' as const }
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
