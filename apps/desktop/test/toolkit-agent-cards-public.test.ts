import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../../../packages/core/src/control'
import * as resultChannel from '../../../packages/core/src/toolkit-result-channel.js'
const openResultChannel = resultChannel.openToolkitResultChannel
import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("tmp"), getAppPath: () => process.cwd() } }))
import { parseToolkitResultDocument, type ToolkitResultDocument } from '../../../packages/core/src/toolkit-result-document'
import { parseMetricsObservation } from '../../../packages/core/src/metrics'
import { parseToolkitSnapshot } from '../../../packages/core/src/toolkit'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { deepMetricsSnapshot } from '../../../packages/core/test/helpers/toolkit-metrics'
import { ProcessResourceSampler, type ResourceSample } from '../src/main/process-resource-sampler'
import { createResourceMetricsPort } from '../src/main/resource-usage-control'
import { PerformanceToolkitOwner } from '../src/main/toolkit-owner'
import type { ToolkitRunPort } from '../src/main/toolkit-run-port'
import { ConfigOwner } from '../src/main/config-owner'
import { DEFAULT_CONFIG } from '../src/main/config-store'

declare const __AGENTMUX_TOOLKIT_PERFORMANCE_SOURCE__: string
const scriptPath = resolve('apps/desktop/resources/toolkit/performance.mjs')
const scriptSource = typeof __AGENTMUX_TOOLKIT_PERFORMANCE_SOURCE__ === 'string'
  ? __AGENTMUX_TOOLKIT_PERFORMANCE_SOURCE__ : readFileSync(scriptPath, 'utf8')
const closes: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
})
const document = (): ToolkitResultDocument => ({ schema: 'agentmux.toolkit.result.v1', summary: 'Result',
  notice: '', links: [{ label: 'Reference', url: 'https://example.test/' }], items: [{ label: 'Value', value: 'original' }],
  agentCards: { fields: ['avatar', 'name', 'status', 'runId'], omittedItems: 0, items: [
    { reference: { kind: 'session', hostId: 'host-a', sessionId: 'session-a' }, metrics: [{ label: 'Queue', value: '3' }] },
    { reference: { kind: 'run', hostId: 'host-b', runId: 'run-a' }, metrics: [] }
  ] } })

it('parses the public data-only document in a browser without Buffer and preserves original Unicode text semantics', () => {
  const original = globalThis.Buffer
  vi.stubGlobal('Buffer', undefined)
  try {
    const value = document(); value.items[0]!.value = '界'.repeat(4096)
    expect(() => parseToolkitResultDocument(value)).not.toThrow()
    expect(parseToolkitResultDocument(value)).toBe(value)
    value.agentCards!.items[0]!.reference.hostId = '界'.repeat(4096)
    expect(() => parseToolkitResultDocument(value)).not.toThrow()
    expect(parseToolkitResultDocument(value)).toBe(value)
    value.agentCards!.items[0]!.reference.hostId = 'valid\tidentity'
    expect(() => parseToolkitResultDocument(value)).not.toThrow()
    expect(parseToolkitResultDocument(value)).toBe(value)
    const { agentCards: _, ...oldDocument } = value
    expect(parseToolkitResultDocument(oldDocument)).toBe(oldDocument)
    expect(parseToolkitResultDocument({ ...value, agentCards: { ...value.agentCards!, fields: [] } })).toBeDefined()
  } finally { vi.stubGlobal('Buffer', original) }
})

it.each(['field', 'duplicate-field', 'identity-arm', 'missing-identity', 'identity-budget', 'identity-control', 'avatar', 'action', 'metrics-budget', 'cards-budget', 'text-budget', 'document-budget', 'url', 'negative-omission'])('rejects invalid %s without weakening the general protocol', kind => {
  const value: any = document(), cards = value.agentCards
  if (kind === 'field') cards.fields = ['html']
  if (kind === 'duplicate-field') cards.fields = ['name', 'name']
  if (kind === 'identity-arm') cards.items[0].reference.runId = 'other'
  if (kind === 'missing-identity') delete cards.items[0].reference.sessionId
  if (kind === 'identity-budget') cards.items[0].reference.hostId = '界'.repeat(4097)
  if (kind === 'identity-control') cards.items[0].reference.hostId = 'host\nother'
  if (kind === 'avatar') cards.items[0].reference.avatar = 'https://example.test/avatar'
  if (kind === 'action') cards.items[0].action = { script: 'never execute' }
  if (kind === 'metrics-budget') cards.items[0].metrics = Array.from({ length: 17 }, () => ({ label: 'x', value: 'y' }))
  if (kind === 'cards-budget') cards.items = Array.from({ length: 129 }, () => document().agentCards!.items[0])
  if (kind === 'text-budget') value.notice = 'x'.repeat(4097)
  if (kind === 'document-budget') value.items = Array.from({ length: 4 }, () => ({ label: 'bytes', value: '界'.repeat(4096) }))
  if (kind === 'url') value.links[0].url = 'https://user:secret@example.test/'
  if (kind === 'negative-omission') cards.omittedItems = -1
  expect(() => parseToolkitResultDocument(value)).toThrow()
})

it('checks descriptors before serialization and preserves failed optional formatting as original text', () => {
  const value: any = document(), getter = vi.fn(() => 'private')
  Object.defineProperty(value.agentCards.items[0].reference, 'hostId', { get: getter, enumerable: true })
  expect(() => parseToolkitResultDocument(value)).toThrow(); expect(getter).not.toHaveBeenCalled()
  const snapshot = deepMetricsSnapshot()
  snapshot.document = document()
  expect(parseToolkitSnapshot(snapshot)).toBe(snapshot)
  const bad: any = structuredClone(snapshot); bad.document.agentCards.fields = ['execute']
  expect(() => parseToolkitSnapshot(bad)).toThrow()
  const text = JSON.stringify({ ...document(), summary: 'confirmed script output', html: '<script>never</script>' })
  expect(() => parseToolkitResultDocument(JSON.parse(text))).toThrow()
  // Interpretation failure does not mutate the captured original bytes.
  expect(text).toContain('confirmed script output')
})

function harness(table = '100 1 10 90\n200 1 20 0') {
  let text = table, wall = 1000, mono = 1000, error: Error | null = null
  const read = vi.fn(async () => { if (error) throw error; return text })
  vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 1 as any)
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
  const sampler = new ProcessResourceSampler(read, () => wall, () => [], () => mono)
  const snapshots: ResourceSample[] = [], off = sampler.subscribe(value => snapshots.push(value))
  closes.push(() => { off(); sampler.dispose() })
  return { sampler, snapshots, read, off, latest: () => snapshots.at(-1)!,
    async sample(next = text, at = mono) {
      text = next; mono = at; wall -= 100
      await (sampler as any).sampleOnce()
      return snapshots.at(-1)!
    }, fail(value: Error | null) { error = value } }
}

it('sums one batch before the total peak: disjoint Run peaks are never added and RSS stays latest', async () => {
  const f = harness(); f.sampler.trackRun('a', 100, 'local'); f.sampler.trackRun('b', 200, 'local')
  await f.sample()
  const second = await f.sample('100 1 30 0\n200 1 40 90', 2000)
  expect(second.runs.map(run => run.cpuPercent)).toEqual([90, 90])
  expect(second.runTotals).toEqual({ coverage: { trackedRuns: 2, observedRoots: 2, missingRoots: 0 },
    processCount: 2, cpuPercent: 90, rssKib: 70 })
  const third = await f.sample('100 1 3 0\n200 1 4 0', 3000)
  expect(third.runTotals!.cpuPercent).toBe(90); expect(third.runTotals!.rssKib).toBe(7)
  const expired = await f.sample('100 1 3 0\n200 1 4 0', 13001)
  expect(expired.runTotals!.cpuPercent).toBe(0)
})

it('counts shared/nested/duplicate roots as observed but unique claimed PIDs once, and missing roots as unknown totals', async () => {
  const f = harness('100 1 10 1\n101 100 20 2\n102 101 30 3')
  f.sampler.trackRun('outer', 100, 'local'); f.sampler.trackRun('inner', 101, 'local'); f.sampler.trackRun('same-root', 100, 'local')
  const complete = await f.sample()
  expect(complete.runs.map(run => run.processCount)).toEqual([3, null, null])
  expect(complete.runTotals).toEqual({ coverage: { trackedRuns: 3, observedRoots: 3, missingRoots: 0 },
    processCount: 3, cpuPercent: 6, rssKib: 60 })
  f.sampler.trackRun('missing', 999, 'local')
  expect((await f.sample()).runTotals).toEqual({ coverage: { trackedRuns: 4, observedRoots: 3, missingRoots: 1 },
    processCount: null, cpuPercent: null, rssKib: null })
})

it('retains same-sample totals on failure, bounds history, stops at last lease and clears it on reopen', async () => {
  const f = harness(); f.sampler.trackRun('a', 100, 'local')
  const before = await f.sample()
  f.fail(new Error('synthetic table unavailable'))
  const stale = await f.sample()
  expect(stale.runTotals).toEqual(before.runTotals); expect(stale.processObservedAt).toBe(before.processObservedAt)
  expect(stale.unavailable).toBe('synthetic table unavailable')
  f.fail(null)
  for (let i = 0; i < 100; i++) await f.sample('100 1 10 0', 2000 + i)
  expect((f.sampler as any).runTotalSamples.length).toBeLessThanOrEqual(11)
  const count = f.read.mock.calls.length; f.off()
  expect((f.sampler as any).timer).toBeNull(); expect((f.sampler as any).runTotalSamples).toEqual([])
  expect(f.read).toHaveBeenCalledTimes(count)
  const off = f.sampler.subscribe(value => f.snapshots.push(value)); closes.push(off)
  expect((await f.sample('100 1 10 0', 3000)).runTotals!.cpuPercent).toBe(0)
  f.sampler.forgetRun('a')
  expect((await f.sample()).runTotals).toEqual({ coverage: { trackedRuns: 0, observedRoots: 0, missingRoots: 0 }, processCount: 0, cpuPercent: 0, rssKib: 0 })
})

it('strictly binds totals coverage and availability to the original process source', () => {
  const value = deepMetricsSnapshot().observation!
  value.process = { state: 'available', data: [{ runId: 'a', hostId: 'local', rootPid: 1, processCount: 1,
    cpuPercent: 1, rssKib: 2, rootRssKib: 2, descendantsRssKib: 0, descendantProcessCount: 0 }], observedAt: 1000, lastSuccessAt: 1000, reason: null }
  value.runTotals = { coverage: { trackedRuns: 1, observedRoots: 1, missingRoots: 0 }, processCount: 1, cpuPercent: 1, rssKib: 2 }
  expect(parseMetricsObservation(value)).toBe(value)
  for (const change of [(v: any) => { v.runTotals = null }, (v: any) => { v.runTotals.coverage.trackedRuns = 2 },
    (v: any) => { v.runTotals.coverage.observedRoots = 2 },
    (v: any) => { v.runTotals.coverage.missingRoots = 1; v.runTotals.coverage.observedRoots = 0 }, (v: any) => { v.process.data = null; v.process.state = 'pending'; v.process.observedAt = null; v.process.lastSuccessAt = null }]) {
    const bad = structuredClone(value); change(bad); expect(() => parseMetricsObservation(bad)).toThrow()
  }
})

async function publicLoop(count: number, id: (i: number) => string = i => 'run-' + i) {
  const root = await mkdtemp(join(tmpdir(), 'amux-card-public-')); closes.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'node_modules', '@agentmux'), { recursive: true })
  await symlink(resolve('packages/core'), join(root, 'node_modules', '@agentmux', 'core'))
  const file = join(root, 'performance.mjs'); await writeFile(file, scriptSource)
  const f = harness(Array.from({ length: count }, (_, i) => `${100 + i} 1 10 1`).join('\n'))
  for (let i = 0; i < count; i++) f.sampler.trackRun(id(i), 100 + i, 'local')
  await f.sample()
  const port = createResourceMetricsPort({ sampler: f.sampler, currentWindow: () => null })
  closes.push(() => port.dispose())
  let child: ChildProcess | null = null, cursor = 0, listener: (event: any) => void = () => {}
  const frames: any[] = []; let buffer = '', stderr = '', exited: Promise<unknown> = Promise.resolve(), recorded = false
  const launches: any[] = []
  const runPort: ToolkitRunPort = {
    async create(input, onEvent) {
      launches.push(input); listener = onEvent
      child = spawn(input.command, input.args, { cwd: input.workspacePath, env: input.env, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stderr!.on('data', bytes => { stderr += bytes })
      child.stdout!.on('data',bytes=>{ const startByte=cursor;cursor+=bytes.length;listener({type:'terminal-output',dataBytes:new Uint8Array(bytes),evidence:{outputByteRange:{startByte,endByte:cursor}}}) })
      exited = new Promise(done => child!.once('close', done))
      return { runId: 'owned-toolkit', pid: child.pid, kind: 'terminal' } as any
    },
    async attach() { return { replay: [], gap: null } as any }, async replay() { return { replay: [], gap: null } as any },
    async stop() { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited },
    async release() {}, async remove() {}
  }
  let resultBytes: (bytes:Uint8Array)=>Promise<void>|void=()=>{}
  vi.spyOn(resultChannel,'openToolkitResultChannel').mockImplementation(args=>{
    resultBytes=async bytes=>{try{await args.onBytes(bytes)}catch(error){args.onError(error)}}
    return openResultChannel({...args,onBytes:async bytes=>{
        buffer += bytes.toString()
        while (buffer.includes('\n')) { const n = buffer.indexOf('\n'); frames.push(JSON.parse(buffer.slice(0, n))); buffer = buffer.slice(n + 1) }
        const evidence = process.env.AGENTMUX_TERMINAL_INPUT_LOADED
        if (evidence && frames.length && !recorded) {
          recorded = true
          const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
          const loadedPath = evidence.replace('.ast-loaded.jsonl', '.loaded.json'), loaded = JSON.parse(readFileSync(loadedPath, 'utf8'))
          loaded[scriptPath] = digest; writeFileSync(loadedPath, JSON.stringify(loaded))
          appendFileSync(evidence + '.script', JSON.stringify({ path: scriptPath, sourceSHA256: digest, executedFile: file,
            childPid: child!.pid, frames: frames.length, launchArgs: launches[0].args,
            boundary: 'actual frozen official script -> compiled CLI -> Unix Metrics owner -> ordered Main Toolkit owner' }) + '\n')
        }
      await args.onBytes(bytes)
    }})
  })
  const owner = new PerformanceToolkitOwner({ openRunPort: async () => runPort, launch: () => ({ runner: process.execPath,
    script: file, cli: resolve('packages/core/bin/amux'), cwd: root, env: objectCliEnvironment(root) as Record<string, string> }),
    enabled: () => true, receipts: { read: async () => null, save: async () => {} } })
  closes.push(() => owner.dispose())
  const server = new AgentMuxControlServer({ coreClients: () => [], execute: vi.fn(), metrics: port, toolkit: owner }, join(root, 'control.sock'))
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'control.sock') } })
  closes.push(() => rpc.dispose())
  const lease = await rpc.subscribe('toolkit.watch', { toolId: 'performance' }, { onInitial() {}, onEvent() {}, onEnd() {} })
  closes.push(() => lease.dispose())
  await vi.waitFor(() => { expect(owner.current.sequence, JSON.stringify({ stderr, reason:owner.current.reason,state:owner.current.state,frames })).toBeGreaterThan(0) }, { timeout: 5000 })
  return { f, owner, rpc, root, launches, frames, listener, resultBytes, get cursor() { return cursor } }
}

it('runs actual official script -> one compiled CLI watch -> Unix sampler -> Main Toolkit -> public inspect/watch', async () => {
  const f = await publicLoop(2)
  const initial: any = (await f.rpc.call('toolkit.inspect', { toolId: 'performance' })).snapshot
  expect(initial.document).toBeDefined(); expect(initial.document).not.toBeNull()
  expect(initial.document.agentCards.items.map((v: any) => v.reference)).toEqual([
    { kind: 'run', hostId: 'local', runId: 'run-0' }, { kind: 'run', hostId: 'local', runId: 'run-1' }])
  expect(initial.document.agentCards.fields).toEqual(['avatar', 'name', 'status', 'provider', 'workspace'])
  expect(initial.document.agentCards.items.every((v: any) => v.metrics.length === 0)).toBe(true)
  expect(initial.observation.runTotals).toEqual({ coverage: { trackedRuns: 2, observedRoots: 2, missingRoots: 0 }, processCount: 2, cpuPercent: 2, rssKib: 20 })
  expect(initial.document.items.find((v: any) => v.label.startsWith('CPU')).value).toBe('2%')
  expect(f.launches).toHaveLength(1); expect(f.frames[0].payload).toEqual(initial.observation)
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const cli = await runCompiledObjectCli(['--endpoint', 'unix://' + join(f.root, 'control.sock'), 'toolkit', 'inspect', 'performance'], objectCliEnvironment(f.root))
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.snapshot.document).toEqual(initial.document)
  const child = spawn(process.execPath, [resolve('packages/core/bin/amux'), '--endpoint', 'unix://' + join(f.root, 'control.sock'),
    'toolkit', 'watch', 'performance'], { env: objectCliEnvironment(f.root), stdio: ['ignore', 'pipe', 'pipe'] })
  const ended = new Promise(done => child.once('close', done))
  closes.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await ended } })
  let output = '', error = ''
  child.stdout!.on('data', bytes => { output += bytes }); child.stderr!.on('data', bytes => { error += bytes })
  await vi.waitFor(() => expect(output, error).toContain('\n'))
  const first = JSON.parse(output.split('\n')[0]!)
  expect(first.result.initial).toEqual({ toolId: 'performance' })
  await vi.waitFor(() => expect(output.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(frame =>
    frame.method === 'system.subscription.event' && frame.params.event.type === 'snapshot' &&
    frame.params.event.data.document?.agentCards?.items.length === 2)).toBe(true))
  child.kill('SIGTERM'); await ended
  let observed: any
  const watch = await f.rpc.subscribe('toolkit.watch', { toolId: 'performance' }, { onInitial(value) { expect(value).toEqual({toolId:'performance'}) }, onEvent(event) { if (event.type === 'snapshot') observed = event.data }, onEnd() {} })
  closes.push(() => watch.dispose())
  await f.f.sample('100 1 5 0\n101 1 6 0', 2000)
  await vi.waitFor(() => expect(f.owner.current.sequence).toBeGreaterThan(initial.sequence))
  expect(f.owner.current.document!.items.find(v => v.label.startsWith('RSS'))!.value).toBe('11')
  await vi.waitFor(() => expect(observed.document).toEqual(f.owner.current.document))
  const framesBefore = f.frames.length
  const bytes = Buffer.from(JSON.stringify({ ...f.frames.at(-1), sequence: f.owner.current.sequence + 1,
    document: { ...document(), agentCards: { ...document().agentCards!, fields: ['execute'] } } }) + '\n')
  await f.resultBytes(bytes)
  await vi.waitFor(()=>expect(f.owner.current.state).toBe('failed'))
  expect(f.owner.current.observation).not.toBeNull(); expect(f.owner.current.document!.agentCards!.fields).not.toContain('execute')
  expect(framesBefore).toBeGreaterThan(0)
})

it('clips only whole cards by count and UTF8 bytes, reports omissions, and preserves full totals and opaque metrics IDs', async () => {
  const f = await publicLoop(150)
  const result = f.owner.current
  expect(result.document!.agentCards!.items).toHaveLength(128)
  expect(result.document!.agentCards!.omittedItems).toBe(22)
  expect(result.observation!.runTotals!.processCount).toBe(150)
  expect(result.document!.items.find(v => v.label.startsWith('RSS'))!.value).toBe('1500')
  expect(Buffer.byteLength(JSON.stringify(result.document))).toBeLessThanOrEqual(32768)
  const g = await publicLoop(128, i => '"'.repeat(124) + i)
  expect(g.owner.current.document!.agentCards!.omittedItems).toBeGreaterThan(0)
  expect(g.owner.current.document!.agentCards!.items.length).toBeGreaterThan(0)
  expect(Buffer.byteLength(JSON.stringify(g.owner.current.document))).toBeLessThanOrEqual(32768)
  const h = await publicLoop(2, i => i === 0 ? 'opaque-' + 'x'.repeat(200) : 'valid')
  expect(h.owner.current.observation!.process.data).toHaveLength(2)
  expect(h.owner.current.document!.agentCards!.items[0]!.reference).toMatchObject({ runId: 'opaque-' + 'x'.repeat(200) })
  expect(h.owner.current.document!.agentCards!.omittedItems).toBe(0)
})


it('executes an ordinary Custom script and carries its exact confirmed document through Unix and compiled CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-card-custom-')); closes.push(() => rm(root, {recursive:true,force:true}))
  const doc = document()
  doc.agentCards = { fields:['avatar','name','status','provider','workspace','host','sessionId','runId'], omittedItems:0,
    items:[{reference:{kind:'session',hostId:'local',sessionId:'session-codex'},metrics:[{label:'Queue',value:'3'}]}] }
  const script = 'process.stdout.write(' + JSON.stringify(JSON.stringify(doc)) + ')'
  const definition = {id:'card-test',revision:'author-1',name:'Cards',icon:'terminal',enabled:true,statusBar:'icon' as const,
    workspacePath:root,script,args:[],actions:[]}
  let config = {...structuredClone(DEFAULT_CONFIG),toolkit:{tools:[definition]}}
  let combined!: import('../src/main/toolkit-owner').ToolkitOwner, childPid:number|undefined
  let output = Buffer.alloc(0)
  const configOwner = new ConfigOwner({read:()=>config,
    prepare:(current,next)=>combined.prepareConfig(current,next),
    save:async next=>structuredClone(next),publish:saved=>{config=saved as typeof config;combined.configurationChanged()} })
  const metadata = () => ({runId:'actual-custom-run',kind:'terminal',state:'exited',exitCode:0,latestOutputBytes:output.length})
  const attachment = () => ({run:metadata(),gap:null,replay:[{startByte:0,endByte:output.length,dataBytes:output}]})
  const port:ToolkitRunPort = { async create(input) {
    const child=spawn(input.command,input.args,{cwd:input.workspacePath,env:input.env,stdio:['ignore','pipe','pipe']})
    childPid=child.pid
    const chunks:Buffer[]=[];let error=''
    child.stdout!.on('data',bytes=>chunks.push(bytes));child.stderr!.on('data',bytes=>{error+=bytes})
    const code=await new Promise(done=>child.once('close',done))
    expect(code,error).toBe(0);output=Buffer.concat(chunks)
    return metadata() as any
  },async attach(){return attachment() as any},async replay(){return attachment() as any},async stop(){},async release(){},async remove(){} }
  combined=new (await import('../src/main/toolkit-owner')).ToolkitOwner({config:configOwner,receiptPath:join(root,'receipt.json'),
    openRunPort:async()=>port,launch:()=>({runner:process.execPath,script:scriptPath,cli:resolve('packages/core/bin/amux'),cwd:root,env:objectCliEnvironment(root) as Record<string,string>}),enabled:()=>false})
  closes.push(()=>combined.dispose())
  const server=new AgentMuxControlServer({coreClients:()=>[],execute:vi.fn(),toolkit:combined},join(root,'control.sock'))
  await server.start();closes.push(()=>server.stop())
  const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:join(root,'control.sock')}});closes.push(()=>rpc.dispose())
  await rpc.call('toolkit.run',{toolId:'card-test',input:{invocationId:randomUUID(),expectedRevision:'author-1',expectedLatestExecutionId:null}})
  let snapshot:any
  await vi.waitFor(async()=>{snapshot=(await rpc.call('toolkit.inspect',{toolId:'card-test'})).snapshot;expect(snapshot.state).toBe('succeeded')})
  expect(snapshot.latestConfirmed.text).toBe(JSON.stringify(doc));expect(parseToolkitResultDocument(JSON.parse(snapshot.latestConfirmed.text))).toEqual(doc)
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI',resolve('packages/core/bin/amux'))
  const cli=await runCompiledObjectCli(['--endpoint','unix://'+join(root,'control.sock'),'toolkit','inspect','card-test'],objectCliEnvironment(root))
  expect(cli.code,cli.stderr).toBe(0);expect(JSON.parse(cli.stdout).result.snapshot).toEqual(snapshot)
  const evidence=process.env.AGENTMUX_TERMINAL_INPUT_LOADED
  if(evidence) writeFileSync(evidence.replace('.ast-loaded.jsonl','.custom-result.json'),JSON.stringify({snapshot,executionProof:{
    childPid,scriptSHA256:createHash('sha256').update(script).digest('hex'),outputSHA256:createHash('sha256').update(output).digest('hex'),
    boundary:'actual ordinary Node script -> CustomToolkitOwner ordered attachment -> Unix toolkit.inspect -> compiled CLI exact snapshot',
    userRunTouched:false,privateChildExited:true}},null,2)+'\n')
})
