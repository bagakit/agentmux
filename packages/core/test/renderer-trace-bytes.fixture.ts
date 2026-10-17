import { fixtureEpoch as _followupFixtureEpoch } from "../../../test/fixture-values.mjs"
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { scanRendererTraceBytes, RENDERER_TRACE_MAX_RAW_BYTES, type RendererTraceByteProgress } from '../src/renderer-trace-bytes.js'
import { RENDERER_TRACE_CATEGORIES, RENDERER_TRACE_MAX_BYTES, RENDERER_TRACE_MAX_GZIP_BYTES, RENDERER_TRACE_METADATA_BYTES,
  parseRendererTraceResult, type RendererTraceResult } from '../src/renderer-trace.js'
import { writeRendererTrace } from '../src/renderer-trace-cli.js'
import { writeNewCliFile } from '../src/cli-atomic-file.js'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const roots: string[] = []
const directory = async () => { const dir = await mkdtemp(join(tmpdir(), 'trace-bytes-')); roots.push(dir); return dir }
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function* fragments(bytes: Uint8Array, size = 65536) { for (let n = 0; n < bytes.byteLength; n += size) yield bytes.subarray(n, n + size) }
function capture(raw: Uint8Array, events = 1): RendererTraceResult {
  const gz = gzipSync(raw)
  return { target: { windowId: 1, webContentsId: 2, generation: 3, pid: 4, creationTime: 5 }, durationMs: 1000,
    schema: 'agentmux.renderer-trace.v2', scope: 'chromium-target-related-timeline', status: 'completed',
    transferMode: 'ReturnAsStream', streamFormat: 'json', streamCompression: 'gzip', traceTimeUnit: 'microseconds',
    requestedCategories: [...RENDERER_TRACE_CATEGORIES],
    timing: { requestedAt: _followupFixtureEpoch(0, 0, 1), startedAt: _followupFixtureEpoch(0, 0, 2), endAcknowledgedAt: _followupFixtureEpoch(0, 0, 3), completedAt: _followupFixtureEpoch(0, 0, 4), finishedAt: _followupFixtureEpoch(0, 0, 5), startMonotonicMs: 1, endMonotonicMs: 1001, completeMonotonicMs: 1002 },
    sourceVerified: { before: true, after: true }, lifecycle: { startRequested: true, startAcknowledged: true, endRequested: true,
      endAcknowledged: true, tracingComplete: true, dataLossOccurred: false, detached: 'confirmed' },
    bufferUsage: { observations: 1, maxFraction: 0.1, fullObserved: false },
    stream: { handleReceived: true, eof: true, closeRequested: true, closeAcknowledged: true },
    receivedEvents: events, receivedTraceBytes: raw.byteLength, receivedGzipBytes: gz.byteLength,
    traceBytes: raw.byteLength, sha256: hash(raw), trace: { encoding: 'base64', data: gz.toString('base64'), bytes: gz.byteLength, sha256: hash(gz) }, issues: [] }
}

it('streams a nonempty trace larger than the old raw budget through the real atomic CLI writer, preserving all original bytes', async () => {
  const raw = Buffer.from('{ "metadata": {"original":"保留", "deep":{"x":true}}, "traceEvents": [{"pid":4,"name":"λ😀","args":{"body":"' +
    'λ😀'.repeat(1600000) + '"}},{"pid":9,"args":{"future":[null,false,2.5]}}], "futureRoot":{"original":true} }\n')
  expect(raw.byteLength).toBeGreaterThan(RENDERER_TRACE_MAX_BYTES)
  const result = capture(raw, 2), gz = Buffer.from(result.trace!.data, 'base64'), decoded: Buffer[] = []
  let pending = false, writes = 0
  const facts = await scanRendererTraceBytes(fragments(gz, 17), { onDecodedChunk: async chunk => {
    expect(pending).toBe(false); pending = true; await Promise.resolve(); decoded.push(Buffer.from(chunk)); writes++; pending = false
  } })
  expect(writes).toBeGreaterThan(1)
  expect(facts).toEqual({ gzipBytes: gz.byteLength, gzipSha256: hash(gz), rawBytes: raw.byteLength, rawSha256: hash(raw), events: 2 })
  expect(Buffer.compare(Buffer.concat(decoded), raw)).toBe(0)
  expect(parseRendererTraceResult(result)).toBe(result)
  const dir = await directory(), path = join(dir, 'original.json'), written = await writeRendererTrace(path, { capture: result })
  expect(written).toEqual({ path, bytes: raw.byteLength, sha256: hash(raw) })
  expect(Buffer.compare(await readFile(path), raw)).toBe(0); expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(await readdir(dir)).toEqual(['original.json'])
  await expect(writeRendererTrace(path, { capture: result })).rejects.toMatchObject({ code: 'EEXIST' })
  const link = join(dir, 'existing-link'); await symlink(path, link)
  await expect(writeRendererTrace(link, { capture: result })).rejects.toMatchObject({ code: 'EEXIST' })
  expect(Buffer.compare(await readFile(path), raw)).toBe(0)
})

it('rejects a declared digest mismatch before publishing the original output file', async () => {
  const dir = await directory(), path = join(dir, 'refused.json'), result = capture(Buffer.from('{"traceEvents":[{"args":{"x":"原文"}}],"metadata":{"n":2}}'))
  result.sha256 = '0'.repeat(64)
  let error: unknown
  try { await writeRendererTrace(path, { capture: result }) } catch (e) { error = e }
  expect(error).toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(await readdir(dir)).toEqual([])
})

it.each([
  ['missing events', '{"metadata":{}}'], ['root array', '[]'], ['primitive event', '{"traceEvents":[1]}'],
  ['string event', '{"traceEvents":["x"]}'], ['duplicate events', '{"traceEvents":[],"traceEvents":[]}'],
  ['nonfinite event', '{"traceEvents":[{"n":1e400}]}'], ['nonfinite metadata', '{"traceEvents":[],"metadata":{"n":-1e999}}'],
  ['trailing document', '{"traceEvents":[]}{}'], ['truncated JSON', '{"traceEvents":[{}]']
])('rejects original JSON with %s', async (_name, text) => {
  await expect(scanRendererTraceBytes(fragments(gzipSync(text), 7))).rejects.toBeDefined()
})

it('validates UTF8 and gzip completion, while accepting empty events and arbitrary original metadata', async () => {
  const valid = Buffer.from('{"traceEvents":[],"metadata":{"hugeKeyIsNotAnEvent":[{"traceEvents":"原始😀"}]}}')
  expect((await scanRendererTraceBytes(fragments(gzipSync(valid), 1))).events).toBe(0)
  const invalidUtf8 = Buffer.concat([Buffer.from('{"traceEvents":[],"x":"'), Buffer.from([0xc3,0x28]), Buffer.from('"}')])
  await expect(scanRendererTraceBytes(fragments(gzipSync(invalidUtf8), 3))).rejects.toBeDefined()
  const gz = gzipSync(valid), bad = Buffer.from(gz); bad[bad.length - 8] = bad[bad.length - 8]! ^ 1
  await expect(scanRendererTraceBytes(fragments(bad, 3))).rejects.toBeDefined()
  await expect(scanRendererTraceBytes(fragments(gz.subarray(0, -1), 3))).rejects.toBeDefined()
})

it('retains actual over-budget observations and never publishes raw scan overflow', async () => {
  let observed: RendererTraceByteProgress | undefined
  // The guard must run before the oversized received chunk enters zlib.
  async function* oversized() { yield Buffer.alloc(RENDERER_TRACE_MAX_GZIP_BYTES + 1) }
  await expect(scanRendererTraceBytes(oversized(), { onProgress: p => { observed = p } })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(observed!.gzipBytes).toBe(RENDERER_TRACE_MAX_GZIP_BYTES + 1)
  const overRaw = gzipSync(Buffer.alloc(RENDERER_TRACE_MAX_RAW_BYTES + 1, 32))
  await expect(scanRendererTraceBytes(fragments(overRaw), { onProgress: p => { observed = p } })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(observed!.rawBytes).toBeGreaterThan(RENDERER_TRACE_MAX_RAW_BYTES)
})

it('requires canonical bounded v2 material and every actual stream completion fact without decoding in the DTO parser', () => {
  const result = capture(Buffer.from('{"traceEvents":[]}'), 0)
  expect(parseRendererTraceResult(result)).toBe(result)
  expect(RENDERER_TRACE_MAX_GZIP_BYTES * 4 / 3 + RENDERER_TRACE_METADATA_BYTES).toBeLessThanOrEqual(RENDERER_TRACE_MAX_BYTES)
  for (const key of ['handleReceived', 'eof', 'closeRequested', 'closeAcknowledged'] as const) {
    expect(() => parseRendererTraceResult({ ...result, stream: { ...result.stream, [key]: false } })).toThrow()
  }
  expect(() => parseRendererTraceResult({ ...result, schema: 'agentmux.renderer-trace.v1' })).toThrow()
  expect(() => parseRendererTraceResult({ ...result, receivedGzipBytes: result.receivedGzipBytes + 1 })).toThrow()
  const one = { ...result, receivedGzipBytes: 1, trace: { encoding: 'base64', data: '/w==', bytes: 1, sha256: '1'.repeat(64) } }
  expect(parseRendererTraceResult(one)).toBe(one) // Envelope validation does not claim that arbitrary bytes are a valid gzip.
  expect(() => parseRendererTraceResult({ ...one, trace: { ...one.trace, data: '/x==' } })).toThrow()
  expect(() => parseRendererTraceResult({ ...result, issues: [{ stage: 'x', code: 'x', message: 'x'.repeat(65536), messageTruncated: false }] })).toThrow()
  const unknown = { ...result, status: 'unknown', trace: null, traceBytes: null, sha256: null,
    receivedGzipBytes: RENDERER_TRACE_MAX_GZIP_BYTES + 65536, stream: { ...result.stream, eof: false } }
  expect(parseRendererTraceResult(unknown)).toBe(unknown)
  const badComplete = { ...unknown, lifecycle: { ...unknown.lifecycle, tracingComplete: false, dataLossOccurred: null }, stream: { handleReceived: true, eof: false, closeRequested: true, closeAcknowledged: true } }
  expect(parseRendererTraceResult(badComplete)).toBe(badComplete)
})

it('awaits producer validation and cleans unpublished bytes on cancellation while preserving the string writer', async () => {
  const dir = await directory(), path = join(dir, 'partial.json'), signal = new AbortController()
  await expect(writeNewCliFile(path, async write => {
    await scanRendererTraceBytes(fragments(gzipSync('{"traceEvents":[{"x":"' + 'a'.repeat(150000) + '"}]}')), {
      signal: signal.signal, onDecodedChunk: async chunk => { await write(chunk); signal.abort() }
    })
  })).rejects.toBeDefined()
  expect(await readdir(dir)).toEqual([])
  await writeNewCliFile(path, 'λ😀'); expect(await readFile(path, 'utf8')).toBe('λ😀')
  expect(await readdir(dir)).toEqual(['partial.json'])
})
