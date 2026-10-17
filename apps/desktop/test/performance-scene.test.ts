import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { readPerformanceSceneEvidence, parsePerformanceSceneEvidence } from '../../../packages/core/src/performance-scene-evidence'
import type { WebContents } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError, durableWriteFile, DurableWriteError } from '@agentmux/core'
import {
  parseRendererAllocationsResult,
  parseRendererPerformanceScene,
  parseRendererSceneCaptureResult,
  parseRendererSceneInspection,
  RENDERER_ALLOCATION_POLICY,
  RENDERER_TRACE_CATEGORIES,
  type RendererAllocationsProfile,
  type RendererAllocationsResult,
  type RendererV8ProfileResult,
  type RendererTraceResult,
  type RendererMemoryResult
} from '@agentmux/core/control'
import { RendererAllocationSampler } from '../src/main/renderer-allocations'
import {
  PerformanceSceneOwner,
  readSceneResources,
  type PerformanceSceneDependencies
} from '../src/main/performance-scene'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { deepMetricsSnapshot } from '../../../packages/core/test/helpers/toolkit-metrics'

const target = { windowId: 1, webContentsId: 2, generation: 3, pid: 4, creationTime: 1000 },
  input = { target, durationMs: 2000 }
const hash = (p: unknown) => createHash('sha256').update(JSON.stringify(p)).digest('hex')
const profile = (): RendererAllocationsProfile => ({
  head: {
    id: 1,
    selfSize: 0,
    callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 },
    children: [
      {
        id: 2,
        selfSize: 65536,
        callFrame: {
          functionName: 'privateFixtureAllocation',
          scriptId: '1',
          url: 'private-fixture.js',
          lineNumber: 0,
          columnNumber: 0
        },
        children: []
      }
    ]
  },
  samples: [{ size: 65536, nodeId: 2, ordinal: 1 }]
})
const allocation = (): RendererAllocationsResult => ({
  ...input,
  schema: 'agentmux.renderer-allocations.v1',
  scope: 'renderer-v8-isolate-sampled-allocations',
  policy: { ...RENDERER_ALLOCATION_POLICY },
  status: 'completed',
  timing: {
    requestedAt: Date.now(),
    startedAt: Date.now(),
    stoppedAt: Date.now(),
    finishedAt: Date.now(),
    startMonotonicMs: 1,
    stopMonotonicMs: 2001
  },
  sourceVerified: { before: true, after: true },
  cleanup: {
    startRequested: true,
    startAcknowledged: true,
    stopRequested: true,
    stopAcknowledged: true,
    disableAcknowledged: true,
    detached: 'confirmed'
  },
  profile: profile(),
  profileBytes: Buffer.byteLength(JSON.stringify(profile())),
  sha256: hash(profile()),
  issues: []
})
const cpu = (): RendererV8ProfileResult => {
  const r = allocation(),
    p = { nodes: [{ id: 1, callFrame: profile().head.callFrame }], startTime: 1, endTime: 2001 }
  return {
    ...input,
    schema: 'agentmux.renderer-v8-profile.v1',
    scope: 'renderer-main-thread-v8',
    status: 'completed',
    timing: r.timing,
    sourceVerified: r.sourceVerified,
    cleanup: { stopRequested: true, stopAcknowledged: true, disableAcknowledged: true, detached: 'confirmed' },
    profilerTimeUnit: 'microseconds',
    profile: p,
    profileBytes: Buffer.byteLength(JSON.stringify(p)),
    sha256: hash(p),
    issues: []
  }
}
const memory = (): RendererMemoryResult => ({
  target,
  schema: 'agentmux.renderer-memory.v1',
  scope: 'renderer-v8-isolate',
  units: 'bytes',
  status: 'completed',
  timing: { requestedAt: Date.now(), sampledAt: Date.now(), finishedAt: Date.now() },
  sourceVerified: { before: true, after: true },
  usage: { usedSize: 1, totalSize: 2, embedderHeapUsedSize: null, backingStorageSize: null },
  cleanup: { detached: 'confirmed' },
  issues: []
})
const trace = (): RendererTraceResult => ({
  target,
  durationMs: 2000,
  schema: 'agentmux.renderer-trace.v2',
  scope: 'chromium-target-related-timeline',
  status: 'failed',
  transferMode: 'ReturnAsStream',
  streamFormat: 'json',
  streamCompression: 'gzip',
  traceTimeUnit: 'microseconds',
  requestedCategories: [...RENDERER_TRACE_CATEGORIES],
  timing: {
    requestedAt: Date.now(),
    startedAt: null,
    endAcknowledgedAt: null,
    completedAt: null,
    finishedAt: Date.now(),
    startMonotonicMs: null,
    endMonotonicMs: null,
    completeMonotonicMs: null
  },
  sourceVerified: { before: true, after: false },
  lifecycle: {
    startRequested: false,
    startAcknowledged: false,
    endRequested: false,
    endAcknowledged: false,
    tracingComplete: false,
    dataLossOccurred: null,
    detached: 'not-attached'
  },
  stream: { handleReceived: false, eof: false, closeRequested: false, closeAcknowledged: false },
  bufferUsage: { observations: 0, maxFraction: null, fullObserved: false },
  receivedEvents: 0,
  receivedTraceBytes: 0,
  receivedGzipBytes: 0,
  trace: null,
  traceBytes: null,
  sha256: null,
  issues: [
    { stage: 'fixture', code: 'CONTROL_UNAVAILABLE', message: 'Only this trace stage failed', messageTruncated: false }
  ]
})
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0)) await close()
})
async function context(write?: typeof durableWriteFile) {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'amx-scene-unit-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'latest.json'),
    owner = new PerformanceSceneOwner(path, write)
  const deps: PerformanceSceneDependencies = {
    currentTarget: () => ({ ...target }),
    loaded: () => ({ mainPid: process.pid, package: null, renderer: null }),
    resources: vi.fn(async () => {
      const value = deepMetricsSnapshot().observation
      if (!value) throw new Error('Private metrics fixture lacks its original observation')
      value.renderer.data!.process = { pid: target.pid, creationTime: target.creationTime }
      return value
    }),
    captureProfile: vi.fn(async () => cpu()),
    captureAllocations: vi.fn(async () => allocation()),
    captureTrace: vi.fn(async () => trace()),
    inspectMemory: vi.fn(async () => memory())
  }
  return { directory, path, owner, deps }
}

it('retains complete siblings and exact native failure, reads original identity without sampling, and sizes the file read to actual bytes', async () => {
  const { owner, deps, path } = await context()
  const capture = await owner.capture({ target }, deps)
  expect(capture.scene.status).toBe('partial')
  expect(capture.scene.cpu.result?.profile).toEqual(cpu().profile)
  expect(capture.scene.timeline.result?.issues[0]?.message).toBe('Only this trace stage failed')
  expect(capture.persistence.status).toBe('confirmed')
  expect(parseRendererSceneCaptureResult(capture, { target })).toEqual(capture)
  const calls = (deps.captureAllocations as ReturnType<typeof vi.fn>).mock.calls.length,
    bytes = (await stat(path)).size,
    allocate = vi.spyOn(Buffer, 'alloc')
  const read = await owner.inspect({ captureId: capture.scene.captureId })
  expect(read.status).toBe('available')
  expect(allocate.mock.calls.some(([size]) => size === bytes + 1)).toBe(true)
  expect(allocate.mock.calls.some(([size]) => size >= 32 * 1024 * 1024)).toBe(false)
  expect(parseRendererSceneInspection(read, { captureId: capture.scene.captureId }).scene).toEqual(capture.scene)
  expect((deps.captureAllocations as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
  expect(await owner.inspect({ captureId: 'replaced-original' })).toMatchObject({
    status: 'mismatch',
    scene: null,
    issue: { code: 'METRICS_SCENE_NOT_RETAINED' }
  })
  expect(() => parseRendererSceneCaptureResult(capture, { target: { ...target, pid: 999 } })).toThrow()
  expect(() => parseRendererPerformanceScene({ ...capture.scene, extra: 'unexpected' })).toThrow()
})
it('admits only one App scene across different Window dependency sets, without disturbing the original', async () => {
  const { owner, deps } = await context()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const original = deps.resources
  deps.resources = vi.fn(async (signal) => {
    await held
    return original(signal)
  })
  const first = owner.capture({ target }, deps)
  await expect(owner.capture({ target }, { ...deps })).rejects.toMatchObject({ code: 'METRICS_SCENE_BUSY' })
  release()
  expect((await first).scene.cpu.result?.status).toBe('completed')
})
it('preserves unknown allocation receipt and blocks later native acquisition while keeping independent resource reads', async () => {
  const { owner, deps } = await context(),
    unknown = allocation()
  unknown.status = 'unknown'
  unknown.cleanup.detached = 'unconfirmed'
  unknown.issues = [
    { stage: 'detach', code: 'CONTROL_UNAVAILABLE', message: 'Original release unconfirmed', messageTruncated: false }
  ]
  deps.captureAllocations = vi.fn(async () => unknown)
  const result = await owner.capture({ target }, deps)
  expect(result.scene.cpu.status).toBe('completed')
  expect(result.scene.allocations.result).toEqual(unknown)
  expect(result.scene.timeline).toMatchObject({
    status: 'skipped',
    requestedAt: null,
    issue: { code: 'SCENE_NATIVE_RELEASE_UNKNOWN' }
  })
  expect(deps.captureTrace).not.toHaveBeenCalled()
  expect(deps.inspectMemory).toHaveBeenCalledTimes(1)
  expect(deps.resources).toHaveBeenCalledTimes(2)
})
it.each(['before', 'after'] as const)(
  'rejects %s resource facts when the original source changes during the point read',
  async (side) => {
    const { owner, deps } = await context()
    let current = { ...target },
      reads = 0
    deps.currentTarget = () => current
    const original = deps.resources
    deps.resources = vi.fn(async (signal) => {
      reads++
      const result = await original(signal)
      if (reads === (side === 'before' ? 1 : 2)) {
        current = { ...target, generation: 4 }
        result.window = { windowId: 1, webContentsId: 2, generation: 4 }
        result.renderer.data!.window = result.window
      }
      return result
    })
    const capture = await owner.capture({ target }, deps)
    expect(capture.scene[side].resources).toMatchObject({
      status: 'unknown',
      result: null,
      issue: { code: 'CONTROL_OWNER_LOST' }
    })
    if (side === 'after') expect(capture.scene.cpu.result?.status).toBe('completed')
  }
)
it('strict wire rejects a new Renderer resource projection inside an old scene', async () => {
  const { owner, deps } = await context(),
    capture = await owner.capture({ target }, deps),
    forged = structuredClone(capture)
  forged.scene.after.resources.result!.window = { windowId: 1, webContentsId: 2, generation: 4 }
  forged.scene.after.resources.result!.renderer.data!.window = { windowId: 1, webContentsId: 2, generation: 4 }
  expect(() => parseRendererSceneCaptureResult(forged, { target })).toThrow()
})
it('budgets large resources before native work and retains every original native release receipt', async () => {
  const { owner, deps } = await context(),
    read = deps.resources
  deps.resources = vi.fn(async (signal) => {
    const r = await read(signal)
    r.runTotals = {
      coverage: { trackedRuns: 4096, observedRoots: 4096, missingRoots: 0 },
      processCount: 4096,
      cpuPercent: 0,
      rssKib: 4096
    }
    r.process = {
      state: 'available',
      observedAt: Date.now(),
      lastSuccessAt: Date.now(),
      reason: null,
      data: Array.from({ length: 4096 }, (_, i) => ({
        runId: String(i) + 'x'.repeat(1000),
        hostId: 'local',
        rootPid: 4,
        processCount: 1,
        cpuPercent: 0,
        rssKib: 1,
        rootRssKib: 1,
        descendantsRssKib: 0,
        descendantProcessCount: 0
      }))
    }
    return r
  })
  const capture = await owner.capture({ target }, deps)
  expect(capture.scene.before.resources).toMatchObject({
    status: 'failed',
    result: null,
    issue: { code: 'SCENE_MATERIAL_TOO_LARGE' }
  })
  expect(capture.scene.cpu.result?.cleanup.detached).toBe('confirmed')
  expect(capture.scene.allocations.result?.cleanup.stopAcknowledged).toBe(true)
  expect(capture.scene.timeline.result?.lifecycle.detached).toBe('not-attached')
  expect(capture.scene.timeline.result?.issues[0]?.message).toBe('Only this trace stage failed')
})
it('never retargets a later native phase after the original generation changes', async () => {
  const { owner, deps } = await context()
  let current = { ...target }
  deps.currentTarget = () => current
  deps.captureProfile = vi.fn(async () => {
    current = { ...target, generation: 4 }
    return cpu()
  })
  const result = await owner.capture({ target }, deps)
  expect(result.scene.target).toEqual(target)
  expect(result.scene.allocations).toMatchObject({
    status: 'unknown',
    result: null,
    issue: { code: 'CONTROL_OWNER_LOST' }
  })
  expect(deps.captureAllocations).not.toHaveBeenCalled()
  expect(deps.captureTrace).not.toHaveBeenCalled()
})
it.each(['before-replace', 'after-replace'] as const)(
  'separates durable %s failure without rollback or capture replay',
  async (phase) => {
    let fail = false,
      writes = 0
    const writer: typeof durableWriteFile = async (path, text, options) => {
      writes++
      if (!fail || phase === 'after-replace') await durableWriteFile(path, text, options)
      if (fail) throw new DurableWriteError(path, phase, new Error('Private fixture disk ACK failure'))
    }
    const { owner, deps, path } = await context(writer),
      first = await owner.capture({ target }, deps)
    const old = await readFile(path, 'utf8')
    fail = true
    const second = await owner.capture({ target }, deps)
    expect(second.persistence).toMatchObject({ status: phase === 'after-replace' ? 'unknown' : 'failed', phase })
    expect(writes).toBe(2)
    if (phase === 'before-replace') {
      expect(await readFile(path, 'utf8')).toBe(old)
      expect((await owner.inspect({ captureId: first.scene.captureId })).status).toBe('available')
    } else {
      expect((await owner.inspect({ captureId: second.scene.captureId })).status).toBe('available')
      expect((await owner.inspect({ captureId: first.scene.captureId })).status).toBe('mismatch')
    }
    expect(deps.captureAllocations).toHaveBeenCalledTimes(2)
  }
)
it('cancels within the scene budget and releases an original late metrics subscription', async () => {
  vi.useFakeTimers()
  const { owner, deps } = await context()
  let resolve!: (v: { dispose(): void }) => void
  const dispose = vi.fn()
  deps.resources = (signal) =>
    readSceneResources(
      {
        subscribe: () =>
          new Promise((yes) => {
            resolve = yes
          })
      },
      signal
    )
  const result = owner.capture({ target }, deps)
  await vi.advanceTimersByTimeAsync(20000)
  const receipt = await result
  expect(receipt.scene.before.resources.status).toBe('unknown')
  expect(deps.captureAllocations).not.toHaveBeenCalled()
  resolve({ dispose })
  await vi.advanceTimersByTimeAsync(0)
  expect(dispose).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
it('diagnostic query exposes only the exact safe scene summary and domain read reference', async () => {
  const { owner, deps } = await context(),
    capture = await owner.capture({ target }, deps),
    service = new AgentMuxRpcService({
      coreClients: () => [],
      metrics: {
        subscribe: async () => ({ dispose() {} }),
        inspectScene: (input, signal) => owner.inspect(input, signal)
      }
    })
  const params = {
    target: { domain: 'performance.scene' as const, hostId: 'local', captureId: capture.scene.captureId },
    includeRaw: true
  }
  const report = await service.call('system.diagnostics.inspect', params),
    read = report.reads[0]!
  expect(read).toMatchObject({
    availability: 'found',
    recordRef: null,
    readAuthority: null,
    authorityStatus: 'unconfirmed',
    persistence: 'observed',
    raw: { returned: 'withheld' }
  })
  expect(read.data).toMatchObject({
    kind: 'performance-scene',
    captureId: capture.scene.captureId,
    material: { method: 'system.metrics.scene.inspect', captureId: capture.scene.captureId }
  })
  expect(JSON.stringify(report)).not.toContain('privateFixtureAllocation')
  expect(JSON.stringify(report)).not.toContain('private-fixture.js')
  expect(JSON.stringify(report)).not.toContain('Only this trace stage failed')
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(128 * 1024)
})
function native() {
  let current = { ...target }
  const state = { attached: false, devtools: false }
  const debuggerClient = Object.assign(new EventEmitter(), {
    isAttached: () => state.attached,
    attach: vi.fn(() => {
      state.attached = true
    }),
    detach: vi.fn(() => {
      state.attached = false
      debuggerClient.emit('detach')
    }),
    sendCommand: vi.fn(async (method: string) => (method === 'HeapProfiler.stopSampling' ? { profile: profile() } : {}))
  })
  const contents = Object.assign(new EventEmitter(), {
    debugger: debuggerClient,
    isDestroyed: () => false,
    isDevToolsOpened: () => state.devtools
  })
  return {
    state,
    debuggerClient,
    contents,
    sampler: new RendererAllocationSampler(contents as unknown as WebContents, () => current),
    change() {
      current = { ...target, pid: 99 }
    }
  }
}
it('uses the fixed native policy and preserves original sampling tree, sample bytes and own cleanup', async () => {
  vi.useFakeTimers()
  const f = native(),
    pending = f.sampler.capture(input)
  await vi.advanceTimersByTimeAsync(2000)
  const result = await pending
  expect(result.status).toBe('completed')
  expect(result.profile).toEqual(profile())
  expect(parseRendererAllocationsResult(result, input)).toEqual(result)
  expect(f.debuggerClient.sendCommand.mock.calls).toEqual([
    ['HeapProfiler.enable', undefined],
    [
      'HeapProfiler.startSampling',
      {
        samplingInterval: 32768,
        stackDepth: 128,
        includeObjectsCollectedByMajorGC: false,
        includeObjectsCollectedByMinorGC: false
      }
    ],
    ['HeapProfiler.stopSampling', undefined],
    ['HeapProfiler.disable', undefined]
  ])
  expect(result.cleanup).toEqual({
    startRequested: true,
    startAcknowledged: true,
    stopRequested: true,
    stopAcknowledged: true,
    disableAcknowledged: true,
    detached: 'confirmed'
  })
  expect(f.debuggerClient.detach).toHaveBeenCalledOnce()
  expect(f.contents.eventNames()).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})
it('refuses an exact-target mismatch and preserves a foreign debugger owner', async () => {
  const f = native()
  await expect(f.sampler.capture({ ...input, target: { ...target, creationTime: 1001 } })).rejects.toMatchObject({
    code: 'CONTROL_OWNER_LOST'
  })
  expect(f.debuggerClient.attach).not.toHaveBeenCalled()
  f.state.attached = true
  await expect(f.sampler.capture(input)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(f.state.attached).toBe(true)
  expect(f.debuggerClient.detach).not.toHaveBeenCalled()
})
it('does not detach a replacement debugger after the original native owner is lost', async () => {
  vi.useFakeTimers()
  const f = native(),
    pending = f.sampler.capture(input)
  await vi.advanceTimersByTimeAsync(0)
  f.debuggerClient.emit('detach')
  f.state.attached = true
  const result = await pending
  expect(result.status).toBe('unknown')
  expect(result.cleanup.detached).toBe('owner-lost')
  expect(f.debuggerClient.detach).not.toHaveBeenCalled()
  expect(
    f.debuggerClient.sendCommand.mock.calls.filter(([method]) => method === 'HeapProfiler.stopSampling')
  ).toHaveLength(0)
})


it('retains native gzip in the actual saved scene and projects separate raw and compressed byte facts', async () => {
  const { owner, deps, path } = await context()
  const raw = '{ "metadata":{"original":"λ"}, "traceEvents":[{"name":"Layout","pid":4}], "future":true }'
  const gzip = gzipSync(raw), digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
  const original: RendererTraceResult = { ...trace(), status: 'completed', sourceVerified: { before: true, after: true },
    timing: { requestedAt: Date.now(), startedAt: Date.now(), endAcknowledgedAt: Date.now(), completedAt: Date.now(), finishedAt: Date.now(), startMonotonicMs: 1, endMonotonicMs: 2001, completeMonotonicMs: 2002 },
    lifecycle: { startRequested: true, startAcknowledged: true, endRequested: true, endAcknowledged: true, tracingComplete: true, dataLossOccurred: false, detached: 'confirmed' },
    stream: { handleReceived: true, eof: true, closeRequested: true, closeAcknowledged: true },
    receivedEvents: 1, receivedTraceBytes: Buffer.byteLength(raw), receivedGzipBytes: gzip.length,
    trace: { encoding: 'base64', data: gzip.toString('base64'), bytes: gzip.length, sha256: digest(gzip) }, traceBytes: Buffer.byteLength(raw), sha256: digest(raw), issues: [] }
  deps.captureTrace = vi.fn(async () => original)
  const captured = await owner.capture({ target }, deps)
  expect(captured.scene.status).toBe('completed'); expect(captured.persistence.status).toBe('confirmed')
  expect(JSON.parse(await readFile(path, 'utf8')).timeline.result).toEqual(original)
  const inspected = await owner.inspect({ captureId: captured.scene.captureId })
  expect(inspected.status).toBe('available'); expect(inspected.scene!.timeline.result).toEqual(original)
  const evidence = await readPerformanceSceneEvidence({ domain: 'performance.scene', hostId: 'local', captureId: captured.scene.captureId },
    (input, signal) => owner.inspect(input, signal), { signal: new AbortController().signal, maxBytes: 16 * 1024 })
  expect(evidence.availability).toBe('found')
  expect(parsePerformanceSceneEvidence(evidence.data, captured.scene.captureId).phases[4]).toMatchObject({ profileBytes: Buffer.byteLength(raw), gzipBytes: gzip.length })
  expect(JSON.stringify(evidence)).not.toContain(original.trace!.data)
  expect(deps.captureTrace).toHaveBeenCalledOnce()
})

it('reports unsupported stored trace versions without changing their bytes or recapturing', async () => {
  const { owner, deps, path } = await context(), captured = await owner.capture({ target }, deps)
  const unsupported = structuredClone(captured.scene) as unknown as { timeline: { result: { schema: string } } }
  unsupported.timeline.result.schema = 'agentmux.renderer-trace.unsupported'
  const bytes = JSON.stringify(unsupported); await writeFile(path, bytes)
  const inspected = await owner.inspect({ captureId: captured.scene.captureId })
  expect(inspected.status).toBe('unavailable'); expect(inspected.issue?.message).toMatch(/unsupported.*(schema|version)|(schema|version).*unsupported/i)
  expect(await readFile(path, 'utf8')).toBe(bytes); expect(deps.captureTrace).toHaveBeenCalledOnce()
})
