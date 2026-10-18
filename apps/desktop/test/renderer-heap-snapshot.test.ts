import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import type { WebContents } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { durableWriteFile, DurableWriteError } from '../../../packages/core/src/durable-write.js'
import { RendererHeapSnapshotOwner } from '../src/main/renderer-heap-snapshot.js'
import { createResourceMetricsPort } from '../src/main/resource-usage-control.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { parseRendererHeapSnapshotResult } from '../../../packages/core/src/renderer-heap-snapshot.js'

const target = { windowId: 1, webContentsId: 2, generation: 3, pid: 4, creationTime: 1000 }
const host = { kind: 'unix-host' as const, hostId: 'local' as const, hostname: 'fixture-host', mainPid: 5 }
// Unit material verifies file transport, not the native V8 format or pause cost.
const bytes = JSON.stringify({ snapshot: { meta: { node_fields: ['type', 'name'] } }, strings: ['held-marker'], nodes: [0, 0], edges: [] })
const disposers: Array<() => Promise<unknown> | void> = []
async function fixture(write = durableWriteFile) {
  const directory = await mkdtemp(join(tmpdir(), 'heap-unit-'))
  const owner = new RendererHeapSnapshotOwner(directory, (...args) => args[0].endsWith('/pending.json') ? durableWriteFile(...args) : write(...args))
  let current: typeof target | null = { ...target }
  const debuggerClient = { isAttached: vi.fn(() => false), attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn() }
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, isDevToolsOpened: vi.fn(() => false), debugger: debuggerClient,
    takeHeapSnapshot: vi.fn(async (path: string) => { await writeFile(path, bytes) }) })
  const dependencies = { contents: contents as unknown as WebContents, currentTarget: () => current, host: () => host }
  disposers.push(async () => { owner.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { directory, owner, contents, debuggerClient, dependencies, setTarget: (next: typeof current) => { current = next } }
}
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })

it('keeps one original native file and strict capture reference, then saves exact bytes without a heap RPC body', async () => {
  const f = await fixture(), input = { target, captureId: randomUUID() }
  const result = await f.owner.capture(input, f.dependencies)
  expect(result).toMatchObject({ capture: { status: 'completed', target, captureId: input.captureId,
    native: { requested: true, settled: true, succeeded: true }, sourceVerified: { before: true, after: true },
    artifact: { host, format: 'v8-heapsnapshot', byteLength: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') } },
    persistence: { status: 'confirmed', phase: null, issue: null } })
  const path = result.capture.artifact!.path
  expect(await readFile(path, 'utf8')).toBe(bytes)
  expect(JSON.stringify(result)).not.toContain('held-marker')
  expect(await f.owner.inspect({ captureId: input.captureId })).toMatchObject({ status: 'available', capture: result.capture })
  const output = join(f.directory, 'export.heapsnapshot')
  expect(await f.owner.save({ captureId: input.captureId }, async () => output)).toEqual({ status: 'saved', path: output })
  expect(await readFile(output, 'utf8')).toBe(bytes)
  expect(f.contents.takeHeapSnapshot).toHaveBeenCalledExactlyOnceWith(path)
  expect(f.contents.eventNames()).toEqual([])
  for (const method of [f.debuggerClient.attach, f.debuggerClient.detach, f.debuggerClient.sendCommand]) expect(method).not.toHaveBeenCalled()
  expect(() => parseRendererHeapSnapshotResult({ ...result, capture: { ...result.capture, target: { ...target, creationTime: 1001 } } }, input)).toThrow()
})

it('preserves a completed capture when the same logical captureId is submitted again', async () => {
  const f = await fixture(), input = { target, captureId: randomUUID() }
  const original = await f.owner.capture(input, f.dependencies), metadata = await readFile(join(f.directory, 'latest.json'))
  await expect(f.owner.capture(input, f.dependencies)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect(await f.owner.inspect({ captureId: input.captureId })).toMatchObject({ status: 'available', capture: original.capture })
  expect(await readFile(join(f.directory, 'latest.json'))).toEqual(metadata)
  expect(f.contents.takeHeapSnapshot).toHaveBeenCalledOnce()
})

it('does not accumulate unindexed heap files after publication failure or lose the pending original', async () => {
  const f = await fixture(async () => { throw new Error('Controlled metadata publication failure') })
  const input = { target, captureId: randomUUID() }, result = await f.owner.capture(input, f.dependencies)
  expect(result).toMatchObject({ capture: { status: 'completed' }, persistence: { status: 'failed', phase: 'before-replace' } })
  await expect(f.owner.capture({ target, captureId: randomUUID() }, f.dependencies)).rejects.toMatchObject({ code: 'CONTROL_OWNER_BUSY' })
  expect((await readdir(f.directory)).filter(name => name.endsWith('.heapsnapshot'))).toEqual([input.captureId + '.heapsnapshot'])
  expect(await f.owner.inspect({ captureId: input.captureId })).toMatchObject({ status: 'available', capture: result.capture })
  expect(f.contents.takeHeapSnapshot).toHaveBeenCalledOnce()
})

it('explicitly retries only original before-replace receipt publication, and observes after-replace unknown without another native capture', async () => {
  let fail = true
  const f = await fixture(async (...args) => { if (fail) throw new Error('Controlled before-replace failure'); return durableWriteFile(...args) })
  const input = { target, captureId: randomUUID() }, first = await f.owner.capture(input, f.dependencies)
  expect(first.persistence.status).toBe('failed'); fail = false
  const second = await f.owner.capture(input, f.dependencies)
  expect(second.capture).toEqual(first.capture)
  expect(second.persistence.status).toBe('confirmed')
  expect(f.contents.takeHeapSnapshot).toHaveBeenCalledOnce()
  const after = await fixture(async (...args) => {
    await durableWriteFile(...args)
    throw new DurableWriteError(args[0], 'after-replace', new Error('Controlled after-replace uncertainty'))
  })
  const original = { target, captureId: randomUUID() }, unknown = await after.owner.capture(original, after.dependencies)
  expect(unknown.persistence.status).toBe('unknown')
  expect(await after.owner.capture(original, after.dependencies)).toEqual(unknown)
  await expect(after.owner.capture({ target, captureId: randomUUID() }, after.dependencies)).rejects.toMatchObject({ code: 'CONTROL_OWNER_BUSY' })
  expect(await after.owner.inspect({ captureId: original.captureId })).toMatchObject({ status: 'available', capture: unknown.capture })
  expect(unknown.persistence.status).toBe('unknown')
  expect(after.contents.takeHeapSnapshot).toHaveBeenCalledOnce()
})

it('fences changed source and existing debugger ownership while leaving the original debugger untouched', async () => {
  const f = await fixture()
  f.contents.isDevToolsOpened.mockReturnValue(true)
  await expect(f.owner.capture({ target, captureId: randomUUID() }, f.dependencies)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(f.contents.takeHeapSnapshot).not.toHaveBeenCalled()
  f.contents.isDevToolsOpened.mockReturnValue(false)
  f.contents.takeHeapSnapshot.mockImplementation(async path => {
    await writeFile(path, bytes); f.setTarget({ ...target, creationTime: target.creationTime + 1 })
  })
  const result = await f.owner.capture({ target, captureId: randomUUID() }, f.dependencies)
  expect(result).toMatchObject({ capture: { status: 'unknown', target, sourceVerified: { before: true, after: false }, native: { succeeded: true },
    artifact: { sha256: createHash('sha256').update(bytes).digest('hex') }, issues: [{ code: 'CONTROL_OWNER_LOST' }] } })
  expect(f.contents.eventNames()).toEqual([])
  expect(f.debuggerClient.detach).not.toHaveBeenCalled()
})

it('cancels only the reader, retains the native slot until actual settlement, and never mutates its unknown reply', async () => {
  const f = await fixture(), signal = new AbortController(), input = { target, captureId: randomUUID() }
  let settle!: () => void, entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  f.contents.takeHeapSnapshot.mockImplementation(async path => { entered(); await new Promise<void>(resolve => { settle = resolve }); await writeFile(path, bytes) })
  const pending = f.owner.capture(input, f.dependencies, signal.signal)
  await ready; signal.abort(new Error('Reader cancelled'))
  const result = await pending, original = JSON.stringify(result)
  expect(result).toMatchObject({ capture: { status: 'unknown', native: { requested: true, settled: false, succeeded: null } } })
  const profile = { capture: vi.fn(), dispose() {} }
  const metrics = createResourceMetricsPort({ sampler: {} as never, currentWindow: () => target, profiler: profile,
    heap: { owner: f.owner, dependencies: f.dependencies } })
  await expect(metrics.captureProfile!({ target, durationMs: 1000 })).rejects.toMatchObject({ code: 'CONTROL_OWNER_BUSY' })
  expect(profile.capture).not.toHaveBeenCalled()
  settle()
  await vi.waitFor(() => expect(f.owner.isCapturing()).toBe(false))
  expect(await f.owner.inspect({ captureId: input.captureId })).toMatchObject({ status: 'available', capture: { status: 'completed', native: { settled: true, succeeded: true } } })
  expect(JSON.stringify(result)).toBe(original)
  expect(f.contents.takeHeapSnapshot).toHaveBeenCalledOnce(); metrics.dispose()
  let publishing!: () => void, release!: () => void
  const saving = new Promise<void>(resolve => { publishing = resolve })
  const p = await fixture(async (...args) => {
    publishing(); await new Promise<void>(resolve => { release = resolve }); await durableWriteFile(...args)
  })
  const observer = new AbortController(), originalInput = { target, captureId: randomUUID() }
  const waiting = p.owner.capture(originalInput, p.dependencies, observer.signal)
  await saving; observer.abort(new Error('Reader ended during an unobserved write phase'))
  const unobserved = await waiting, originalBytes = JSON.stringify(unobserved)
  expect(unobserved).toMatchObject({ capture: { status: 'unknown', native: { requested: true, settled: true, succeeded: true } },
    persistence: { status: 'unknown', phase: null } })
  expect(parseRendererHeapSnapshotResult(unobserved, originalInput)).toEqual(unobserved)
  release(); await vi.waitFor(() => expect(p.owner.isCapturing()).toBe(false))
  expect(await p.owner.inspect({ captureId: originalInput.captureId })).toMatchObject({ status: 'available', capture: { status: 'completed' } })
  expect(JSON.stringify(unobserved)).toBe(originalBytes); expect(p.contents.takeHeapSnapshot).toHaveBeenCalledOnce()
})

it('recovers one original pending attempt across owner construction and exports it before allowing another native file', async () => {
  const f = await fixture(async () => { throw new Error('Controlled latest publication failure') })
  const input = { target, captureId: randomUUID() }, first = await f.owner.capture(input, f.dependencies)
  const recovered = new RendererHeapSnapshotOwner(f.directory)
  disposers.push(() => recovered.dispose())
  expect(await recovered.inspect({ captureId: input.captureId })).toMatchObject({ status: 'available', capture: first.capture })
  expect(await recovered.capture(input, f.dependencies)).toMatchObject({ capture: first.capture, persistence: { status: 'unknown', phase: null } })
  await expect(recovered.capture({ target, captureId: randomUUID() }, f.dependencies)).rejects.toMatchObject({ code: 'CONTROL_OWNER_BUSY' })
  expect(f.contents.takeHeapSnapshot).toHaveBeenCalledOnce()
  const output = join(f.directory, 'export.heapsnapshot')
  expect(await recovered.save({ captureId: input.captureId }, async () => output)).toEqual({ status: 'saved', path: output })
  expect(await readFile(output, 'utf8')).toBe(bytes)
  expect((await readdir(f.directory)).filter(name => name === 'pending.json' || name === input.captureId + '.heapsnapshot')).toEqual([])
  const next = await recovered.capture({ target, captureId: randomUUID() }, f.dependencies)
  expect(next.capture.status).toBe('completed'); expect(f.contents.takeHeapSnapshot).toHaveBeenCalledTimes(2)
})

it('keeps unobserved native facts unknown on recovery and preserves incompatible earlier bytes through explicit export', async () => {
  const f = await fixture(), input = { target, captureId: randomUUID() }
  const completed = await f.owner.capture(input, f.dependencies)
  const pending = { ...completed.capture, status: 'unknown' as const, native: { requested: null, settled: null, succeeded: null },
    timing: { ...completed.capture.timing, nativeRequestedAt: null, nativeSettledAt: null }, sourceVerified: { before: true, after: false }, artifact: null,
    issues: [{ stage: 'recover', code: 'HEAP_NATIVE_UNCONFIRMED', message: 'Original native observations are unavailable.', messageTruncated: false }] }
  const incompatible = '{"olderDiagnosticContract":true}'
  await writeFile(join(f.directory, 'latest.json'), incompatible)
  await writeFile(join(f.directory, 'pending.json'), JSON.stringify({ capture: pending, previous: null, incompatible: true }))
  const recovered = new RendererHeapSnapshotOwner(f.directory)
  disposers.push(() => recovered.dispose())
  expect(await recovered.inspect({ captureId: input.captureId })).toMatchObject({ status: 'available', capture: { status: 'unknown',
    native: { requested: null, settled: null, succeeded: null }, artifact: { byteLength: Buffer.byteLength(bytes) } } })
  expect(await recovered.capture(input, f.dependencies)).toMatchObject({ capture: { status: 'unknown', native: { succeeded: null } } })
  await recovered.save({ captureId: input.captureId }, async () => join(f.directory, 'recovered.heapsnapshot'))
  expect(await readFile(join(f.directory, 'latest.json'), 'utf8')).toBe(incompatible)
  expect(await readFile(join(f.directory, 'pending.json'), 'utf8').then(() => 'present', (e: NodeJS.ErrnoException) => e.code)).toBe('ENOENT')
  expect(f.contents.takeHeapSnapshot).toHaveBeenCalledOnce()
})

it('refuses export over exact owner metadata or retained material without deleting the exported destination', async () => {
  const f = await fixture(), input = { target, captureId: randomUUID() }, result = await f.owner.capture(input, f.dependencies)
  const metadata = await readFile(join(f.directory, 'latest.json')), original = await readFile(result.capture.artifact!.path)
  for (const destination of [join(f.directory, '.', 'latest.json'), result.capture.artifact!.path])
    await expect(f.owner.save({ captureId: input.captureId }, async () => destination)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(await readFile(join(f.directory, 'latest.json'))).toEqual(metadata)
  expect(await readFile(result.capture.artifact!.path)).toEqual(original)
  const failed = await fixture(); failed.contents.takeHeapSnapshot.mockRejectedValueOnce(new Error('Controlled native failure'))
  const id = randomUUID(); await failed.owner.capture({ target, captureId: id }, failed.dependencies)
  const pending = await readFile(join(failed.directory, 'pending.json'))
  await expect(failed.owner.save({ captureId: id }, async () => join(failed.directory, '.', 'pending.json'))).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(await readFile(join(failed.directory, 'pending.json'))).toEqual(pending)
  const exportPath = join(failed.directory, 'attempt.json')
  expect(await failed.owner.save({ captureId: id }, async () => exportPath)).toEqual({ status: 'saved', path: exportPath })
  expect(JSON.parse(await readFile(exportPath, 'utf8'))).toMatchObject({ captureId: id, native: { requested: true, settled: true, succeeded: false } })
  expect(await readFile(join(failed.directory, 'pending.json')).then(() => 'exists', (e: NodeJS.ErrnoException) => e.code)).toBe('ENOENT')
})

it('delivers the actual compiled public CLI through Unix, the original metrics port and original Host artifact', async () => {
  const cli = process.env.AGENTMUX_HEAP_CLI
  expect(cli, 'The isolated parent supplies a per-module compiled current Core CLI').toBeTruthy()
  const f = await fixture(), captureId = randomUUID()
  const metrics = createResourceMetricsPort({ sampler: {} as never, currentWindow: () => target,
    heap: { owner: f.owner, dependencies: f.dependencies } })
  const endpoint = join(f.directory, 'control.sock'), server = new AgentMuxControlServer({ coreClients: () => [], metrics }, endpoint)
  await server.start(); disposers.push(async () => { await server.stop(); metrics.dispose() })
  const call = (args: string[]) => new Promise<{ exit: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli!, '--endpoint', 'unix://' + endpoint, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
    child.once('error', reject); child.once('close', exit => resolve({ exit, stdout, stderr }))
  })
  const captureReply = await call(['system', 'metrics', 'heap', 'capture', '--window-id', '1', '--web-contents-id', '2', '--generation', '3', '--pid', '4', '--creation-time', '1000', '--capture-id', captureId])
  expect(captureReply.exit, captureReply.stderr).toBe(0)
  const first = JSON.parse(captureReply.stdout)
  expect(first).toMatchObject({ ok: true, result: { capture: { capture: { captureId, target, status: 'completed', artifact: { host } } } } })
  const artifact = first.result.capture.capture.artifact
  expect(await readFile(artifact.path, 'utf8')).toBe(bytes)
  const inspectReply = await call(['system', 'metrics', 'heap', 'inspect', '--capture-id', captureId])
  expect(inspectReply.exit, inspectReply.stderr).toBe(0)
  const second = JSON.parse(inspectReply.stdout)
  expect(second).toMatchObject({ ok: true, result: { inspection: { status: 'available', capture: first.result.capture.capture } } })
  expect(f.contents.takeHeapSnapshot).toHaveBeenCalledOnce()
}, 30000)
