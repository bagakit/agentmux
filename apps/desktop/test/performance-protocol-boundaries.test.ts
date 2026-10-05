import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from '../../../packages/core/src/control-host.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION as schemaVersion, AGENTMUX_CONTROL_MAX_MESSAGE_BYTES } from '../../../packages/core/src/control.js'
import { parseMetricsObservation } from '../../../packages/core/src/metrics.js'
import { deepMetricsSnapshot } from '../../../packages/core/test/helpers/toolkit-metrics.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const deep = (n: number): any => n ? { child: deep(n - 1) } : 0
const receipt = (operation: string, result: unknown) => ({ schemaVersion, requestId: 'private-proof', ok: true, operation, result })
const check = (input: unknown) => ({ input, outcome: 'unsupported', detail: 'original host fact' })
const refresh = (host: unknown) => ({ input: { executorId: 'executor', providerId: 'provider', command: 'literal', host }, availability: 'check-failed', cause: { code: 'EIO', message: 'original cause' } })
it('keeps depth8 leaves legal through host Test, list and Refresh, while depth9 still fails', () => {
  const input = deep(8)
  expect(parseAgentMuxControlRequest({ schemaVersion, requestId: 'draft', operation: 'settings.hosts.test', input })).toMatchObject({ input })
  for (const [operation, make] of [['settings.hosts.test', check], ['settings.hosts.list', (host: unknown) => ({ hosts: [host] })], ['settings.executors.refresh', refresh]] as const) {
    const valid = receipt(operation, make(input)); expect(() => parseAgentMuxControlReceipt(valid)).not.toThrow(); expect(parseAgentMuxControlReceipt(valid)).toEqual(valid)
    expect(() => parseAgentMuxControlReceipt(receipt(operation, make(deep(9))))).toThrow()
  }
})
it.each(['getter', 'nonenumerable', 'symbol', 'prototype', 'hole', 'iterator'])('rejects malformed host list %s without executing user code', kind => {
  const hosts: any[] = [deep(8)]; let invoked = 0
  const getter = () => { invoked++; return deep(8) }
  if (kind === 'getter') Object.defineProperty(hosts, '0', { get: getter, enumerable: true })
  if (kind === 'nonenumerable') Object.defineProperty(hosts, '0', { value: deep(8), enumerable: false })
  if (kind === 'symbol') Object.defineProperty(hosts, Symbol('extra'), { value: 1 })
  if (kind === 'prototype') Object.setPrototypeOf(hosts, { toJSON: getter })
  if (kind === 'hole') delete hosts[0]
  if (kind === 'iterator') Object.defineProperty(hosts, Symbol.iterator, { get: getter })
  expect(() => parseAgentMuxControlReceipt(receipt('settings.hosts.list', { hosts }))).toThrow()
  expect(invoked).toBe(0)
})
it('checks header and nested descriptors before serialization, and rejects unknown typed fields', () => {
  let invoked = 0; const getter = () => { invoked++; return 'original cause' }
  const header = receipt('settings.hosts.test', check({}))
  Object.defineProperty(header, 'schemaVersion', { get: getter, enumerable: true })
  const source = refresh({}); Object.defineProperty(source.cause, 'message', { get: getter, enumerable: true })
  const result = check({}); Object.defineProperty(result, 'detail', { get: getter, enumerable: true })
  for (const value of [header, receipt('settings.executors.refresh', source), receipt('settings.hosts.test', result), receipt('settings.hosts.test', { ...check({}), extra: true })]) expect(() => parseAgentMuxControlReceipt(value)).toThrow()
  expect(invoked).toBe(0)
})
it('keeps the aggregate receipt byte budget even when each host leaf fits separately', () => {
  const host = { text: 'x'.repeat(33 * 1024 * 1024) }, result = receipt('settings.hosts.list', { hosts: [host, host] })
  expect(Buffer.byteLength(JSON.stringify(host))).toBeLessThan(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES)
  expect(() => parseAgentMuxControlReceipt(result)).toThrow('budget')
})
it('roundtrips maximum legal opaque leaves through actual Unix owner, public RPC and compiled CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-protocol-host-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const input = deep(8), seen: string[] = []
  const owner = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], async execute(request) {
    seen.push(request.operation)
    if (request.operation === 'settings.hosts.list') return { operation: request.operation, hosts: [input] }
    if (request.operation === 'settings.hosts.test') return { operation: request.operation, ...check(request.input ?? input) } as any
    if (request.operation === 'settings.executors.refresh') return { operation: request.operation, ...refresh(input) } as any
    throw new Error('Unexpected public operation')
  } }); await owner.start(); cleanups.push(() => owner.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  await expect(rpc.call('settings.hosts.test', { input })).resolves.toEqual(check(input))
  await expect(rpc.call('settings.hosts.ls', {})).resolves.toEqual({ hosts: [input] })
  await expect(rpc.call('settings.executors.refresh', { executorId: 'executor', hostId: 'local' })).resolves.toEqual(refresh(input))
  for (const [args, expected] of [[['settings', 'hosts', 'test', '--input', '-'], check(input)], [['settings', 'hosts', 'ls'], { hosts: [input] }], [['settings', 'executors', 'refresh', 'executor', '--host', 'local'], refresh(input)]] as const) {
    const result = await runCompiledObjectCli(args, objectCliEnvironment(root), JSON.stringify(input))
    expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout).result).toEqual(expected)
  }
  expect(seen).toHaveLength(6)
})
function observation(count = 1) {
  const value = deepMetricsSnapshot().observation!
  value.scope.hostname = '测试-host'
  value.process = { state: 'available', observedAt: 1000, lastSuccessAt: 1000, reason: null, data: Array.from({ length: count }, (_, i) => ({ runId: `00000000-0000-4000-8000-${i.toString().padStart(12,'0')}`, hostId: 'local', rootPid: i+1, processCount: 1, cpuPercent: 0, rssKib: 1024, rootRssKib: 1024, descendantsRssKib: 0, descendantProcessCount: 0 })) }
  value.runTotals = { coverage: { trackedRuns: count, observedRoots: count, missingRoots: 0 }, processCount: count, cpuPercent: 0, rssKib: 1024 * count }
  return value
}
const opening = (data: unknown) => ({ jsonrpc: '2.0', id: 'proof', result: { subscriptionId: 'reader', method: 'system.metrics.watch', initial: { observation: data } } })
const event = (sequence: number, type: string, data?: unknown) => ({ jsonrpc: '2.0', method: 'system.subscription.event', params: { subscriptionId: 'reader', method: 'system.metrics.watch', sequence, event: { type, ...(data ? { data } : {}) } } })
async function start(frames: unknown[], options: { fragment?: number; linger?: boolean; rawHex?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'amx-script-pipe-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'input.json'), progress = join(root, 'progress'), pid = join(root, 'pid'), outputState = join(root, 'output-state.json'), observer = join(root, 'output-observer.mjs')
  await writeFile(input, JSON.stringify({ frames, ...options }))
  // Observe the actual script pipe without changing bytes, callbacks or write's
  // return value. The child CLI does not load this private process argument.
  await writeFile(observer, `import { renameSync, writeFileSync } from 'node:fs';
const write = process.stdout.write; let writes = 0, blocked = false;
process.stdout.write = function(...args) {
  const admitted = write.apply(this, args); writes++; blocked ||= !admitted;
  const path = process.env.AGENTMUX_PROTOCOL_OUTPUT_STATE;
  writeFileSync(path + '.tmp', JSON.stringify({ writes, blocked })); renameSync(path + '.tmp', path);
  return admitted;
};`)
  const child = spawn(process.execPath, ['--import', observer, (process.env.AGENTMUX_PERFORMANCE_SCRIPT ?? resolve('apps/desktop/resources/toolkit/performance.mjs')), resolve('apps/desktop/scripts/fixtures/performance-protocol-boundaries/metrics-cli.mjs')], { env: { ...objectCliEnvironment(root), AGENTMUX_PROTOCOL_INPUT: input, AGENTMUX_PROTOCOL_PROGRESS: progress, AGENTMUX_PROTOCOL_PID: pid, AGENTMUX_PROTOCOL_OUTPUT_STATE: outputState }, stdio: ['pipe', 'pipe', 'pipe'] })
  cleanups.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes.toString() })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>(resolve => child.once('close', (code, signal) => resolve({ code, signal, stderr })))
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  return { child, closed, exited, root, progress, pid, outputState }
}
async function read(child: ChildProcessWithoutNullStreams) {
  let text = ''; child.stdout.on('data', bytes => { text += bytes.toString() })
  return () => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}
it('runs the actual official script through real public metrics owner and compiled CLI with a large complete frame', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-real-metrics-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const data = observation(1500), dispose = vi.fn()
  expect(Buffer.byteLength(JSON.stringify(opening(data)))).toBeGreaterThan(256 * 1024)
  const owner = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], execute: vi.fn(), metrics: { async subscribe(push) { push(data); return { dispose } } } })
  await owner.start(); cleanups.push(() => owner.stop())
  const child = spawn(process.execPath, [(process.env.AGENTMUX_PERFORMANCE_SCRIPT ?? resolve('apps/desktop/resources/toolkit/performance.mjs')), (process.env.AGENTMUX_PROTOCOL_PUBLIC_CLI ?? resolve('packages/core/bin/amux'))], { env: objectCliEnvironment(root), stdio: ['pipe','pipe','pipe'] })
  cleanups.push(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  const frames = await read(child), close = new Promise(resolve => child.once('close', resolve))
  await vi.waitFor(() => expect(frames()[0]?.payload, JSON.stringify(frames())).toEqual(data), { timeout: 5000 })
  expect(frames().filter(frame => frame.event === 'error')).toEqual([])
  child.kill('SIGTERM'); await close
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
})
it('pauses source consumption under real OS output backpressure, then drains every frame in order', async () => {
  const data = observation(1500), frames = [opening(data), ...Array.from({ length: 19 }, (_, i) => event(i+1, 'snapshot', { ...data, observedAt: 1001+i })), event(20, 'end')]
  const p = await start(frames)
  const state = async () => JSON.parse(await readFile(p.outputState, 'utf8')) as { writes: number; blocked: boolean }
  await vi.waitFor(async () => expect((await state()).blocked).toBe(true))
  // Starting at the actual false result, an unread consumer may have exactly
  // one admitted frame. Source-write progress alone includes kernel buffering
  // and parsing cost, so it cannot prove the script stops admitting frames.
  const deadline = Date.now() + 3000
  while ((await state()).writes === 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  expect(p.child.exitCode).toBeNull()
  expect((await state()).writes).toBe(1)
  expect(Number(await readFile(p.progress, 'utf8'))).toBeLessThan(5)
  const output = await read(p.child), result = await p.closed
  expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: '' })
  expect(output()).toHaveLength(20)
  expect(output().map(row => row.sequence)).toEqual(Array.from({ length: 20 }, (_, i) => i+1))
  expect(output().every(row => row.event === 'result' && row.payload.process.data.length === 1500)).toBe(true)
  expect(output().map(row => row.payload.observedAt)).toEqual(Array.from({ length: 20 }, (_, i) => 1000+i))
})
it('cancels while output waits for drain and releases only the private CLI reader', async () => {
  const p = await start([opening(observation(1500))], { linger: true })
  await vi.waitFor(async () => expect(Number(await readFile(p.pid, 'utf8'))).toBeGreaterThan(0))
  await new Promise(resolve => setTimeout(resolve, 200)); p.child.kill('SIGTERM')
  const watchdog = setTimeout(() => p.child.kill('SIGKILL'), 2000)
  const result = await p.exited; clearTimeout(watchdog); p.child.stdout.resume()
  expect(result).toMatchObject({ code: 0, signal: null })
  const readerPid = Number(await readFile(p.pid, 'utf8'))
  expect(() => process.kill(readerPid, 0)).toThrow()
})
it('preserves fragmented UTF8 and multiple frames in one chunk', async () => {
  const data = observation(), p = await start([opening(data), event(1, 'snapshot', data), event(2, 'end')], { fragment: 7 }), output = await read(p.child)
  expect(await p.closed).toMatchObject({ code: 0, signal: null })
  expect(output().map(row => row.payload)).toEqual([data, data])
})
it.each(['gap', 'wrong-reader', 'malformed-schema', 'incomplete', 'invalid-utf8'])('rejects %s at the actual official script boundary', async kind => {
  const data = observation(), bad: any = event(1, 'snapshot', data)
  if (kind === 'gap') bad.params.sequence = 2
  if (kind === 'wrong-reader') bad.params.subscriptionId = 'other'
  if (kind === 'malformed-schema') bad.params.event.data = { schema: 'agentmux.metrics.v1' }
  const p = await start([opening(data), bad], kind === 'incomplete' ? { rawHex: Buffer.from('{').toString('hex') } : kind === 'invalid-utf8' ? { rawHex: 'c3280a' } : {}), output = await read(p.child)
  expect(await p.closed).toMatchObject({ code: 1, signal: null })
  expect(output().at(-1)?.event).toBe('error')
})
async function publicCli() {
  const root = await mkdtemp(join(tmpdir(), 'amx-cli-pending-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const data = observation(1500), dispose = vi.fn(), created = vi.fn()
  const owner = new AgentMuxControlServer({ socketPath: join(root,'control.sock'), coreClients: () => [], execute: vi.fn(), metrics: { async subscribe(push) {
    created(); push(data)
    const timer = setInterval(() => push(data), 2)
    return { dispose() { clearInterval(timer); dispose() } }
  } } }); await owner.start(); cleanups.push(() => owner.stop())
  const child = spawn(process.execPath, [process.env.AGENTMUX_PROTOCOL_PUBLIC_CLI ?? resolve('packages/core/bin/amux'), 'system','metrics','watch'], { env: objectCliEnvironment(root), stdio: ['pipe','pipe','pipe'] })
  cleanups.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes.toString() })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code,signal) => resolve({code,signal})))
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code,signal) => resolve({code,signal})))
  return { child, closed, exited, dispose, created, stderr: () => stderr }
}
it('public CLI admits a legal large frame and cancels a nonreading pipe without an error or leaked subscription', async () => {
  const p = await publicCli()
  await vi.waitFor(() => expect(p.created).toHaveBeenCalledOnce())
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(p.stderr()).toBe(''); expect(p.dispose).not.toHaveBeenCalled()
  p.child.kill('SIGTERM')
  const watchdog = setTimeout(() => p.child.kill('SIGKILL'), 2000)
  const result = await p.exited; clearTimeout(watchdog); p.child.stdout.resume()
  expect(result).toEqual({ code: 0, signal: null })
  expect(p.stderr()).toBe('')
  await vi.waitFor(() => expect(p.dispose).toHaveBeenCalledOnce())
})
it('public CLI refuses actual pending byte overflow, releases the reader and exits a nonreading pipe', async () => {
  const p = await publicCli()
  await vi.waitFor(() => expect(p.stderr()).toContain('CLI pending output exceeds its byte budget'), { timeout: 8000 })
  await vi.waitFor(() => expect(p.dispose).toHaveBeenCalledOnce())
  const watchdog = setTimeout(() => p.child.kill('SIGKILL'), 2000)
  expect(await p.exited).toEqual({ code: 1, signal: null })
  clearTimeout(watchdog); p.child.stdout.resume()
})
