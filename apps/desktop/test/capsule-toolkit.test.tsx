// @vitest-environment happy-dom
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, type AgentMuxClientEvent, type AgentMuxRun, type AgentMuxRunAttachment } from '@agentmux/core'
import { NodeCapsuleOwner } from '@agentmux/capsule/node'
import { parseToolkitResultDocument, type ToolkitResultDocument } from '@agentmux/core/toolkit-result-document'
import { parseToolkitSnapshot, type ToolkitConfirmedResult, type ToolkitScriptSnapshot, type ToolkitToolDefinition } from '@agentmux/core/control'
import type { CapsuleInspection, CapsulePort } from '@agentmux/core/capsule'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { ConfigOwner } from '../src/main/config-owner'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { ToolkitOwner } from '../src/main/toolkit-owner'
import type { ToolkitRunPort } from '../src/main/toolkit-run-port'
import { api } from '../src/renderer/src/lib/api'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { UserToolkitResult } from '../src/renderer/src/components/toolkit/UserToolkitResult'
import { createClientUiRoot } from './helpers/client-ui-render'

vi.mock('electron', () => ({ app: { getPath: () => process.cwd(), getAppPath: () => process.cwd() } }))

let directory: string, sourcePath: string, capsuleOwner: NodeCapsuleOwner, service: AgentMuxRpcService
let container: HTMLDivElement, root: Root, first: CapsuleInspection, second: CapsuleInspection
let capsuleTransport: CapsulePort['call'], flights: Set<Promise<unknown>>
let presentation: ReturnType<typeof vi.fn>, toolRun: ReturnType<typeof vi.spyOn>, toolAction: ReturnType<typeof vi.spyOn>
const principal = { transport: 'unix' as const, principal: { kind: 'user' as const, id: 'toolkit-capsule-user' } }
const definition = (): ToolkitToolDefinition => ({ id: 'original-capsule-tool', revision: 'captured-revision', name: 'Original page generator', icon: 'terminal', enabled: true,
  statusBar: 'icon', workspacePath: sourcePath, script: 'originalScript()', args: [], actions: [{ id: 'rerun', label: 'Generate again', script: 'actionScript()', args: [] }] })
const documentFor = (capsuleId: string, label = 'Generated report'): ToolkitResultDocument => ({ schema: 'agentmux.toolkit.result.v1', summary: 'Generated artifact', items: [], links: [], notice: '', capsules: [{ label, capsuleId }] })
function result(document: ToolkitResultDocument | null, executionId = 'original-execution', value = definition()): ToolkitConfirmedResult {
  return { executionId, invocationId: 'original-invocation', definition: value, expectedLatestExecutionId: null, target: { workspacePath: value.workspacePath },
    run: { hostId: 'local', runId: 'original-run-' + executionId }, startedAt: 1, endedAt: 2, text: '', state: 'succeeded', reason: null, exitCode: 0, document }
}
function snapshot(value: ToolkitConfirmedResult): ToolkitScriptSnapshot {
  return parseToolkitSnapshot({ schema: 'agentmux.toolkit.v1', kind: 'script', toolId: value.definition.id, definition: value.definition,
    state: value.state, reason: null, admission: null, latestConfirmed: value, consumerCount: 1, sequence: 1 }) as ToolkitScriptSnapshot
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  directory = await mkdtemp('/tmp/capsule-toolkit-'); sourcePath = join(directory, 'build')
  await mkdir(sourcePath); await writeFile(join(sourcePath, 'index.html'), '<!doctype html><title>Published report</title>Original content')
  presentation = vi.fn(async (params: { capsuleId: string; operationId: string }, _context, resolved: { endpoint: unknown }) => ({ ...params, endpoint: resolved.endpoint,
    rendering: { status: 'available', browserId: 'original-browser', tabId: 'original-tab', regionId: 'original-region' } }))
  capsuleOwner = await NodeCapsuleOwner.open({ stateDirectory: join(directory, 'capsules'), presentation: { open: presentation } })
  first = await capsuleOwner.call('capsule.create', { operationId: 'first-published-page', sourcePath, title: 'First page', source: { toolId: 'untrusted-declared-tool', executionId: 'untrusted-declared-execution' } })
  second = await capsuleOwner.call('capsule.create', { operationId: 'second-published-page', sourcePath, title: 'Second page' })
  service = new AgentMuxRpcService({ coreClients: () => [], capsules: capsuleOwner })
  capsuleTransport = (method, params) => service.call(method, params, principal) as ReturnType<CapsulePort['call']>
  flights = new Set()
  vi.spyOn(api.capsules, 'call').mockImplementation(((method, params) => {
    const promise = capsuleTransport(method, params); flights.add(promise)
    void promise.then(() => flights.delete(promise), () => flights.delete(promise)); return promise
  }) as CapsulePort['call'])
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  toolRun = vi.spyOn(api.toolkit, 'run'); toolAction = vi.spyOn(api.toolkit, 'action')
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); service.dispose(); await capsuleOwner.close(); await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks() })
async function settle() { await act(async () => { while (flights.size) await Promise.allSettled([...flights]) }) }
async function mount(initial: ToolkitScriptSnapshot, extra = {}) {
  let current = parseToolkitSnapshot(initial), publish!: (value: ToolkitScriptSnapshot) => void
  vi.spyOn(api.toolkit, 'observe').mockImplementation((_id, read) => { publish = read; read(current); return { dispose() {} } })
  vi.spyOn(api.toolkit, 'get').mockImplementation(async () => current)
  await act(async () => root.render(<SettingsNavigation.Provider value={{ open() {}, openToolkit() {} }}><UserToolkitResult definition={initial.definition} active close={() => {}} {...extra} /></SettingsNavigation.Provider>))
  return async (next: ToolkitScriptSnapshot) => { current = parseToolkitSnapshot(next); await act(async () => publish(current as ToolkitScriptSnapshot)) }
}
function row(id = first.record.capsuleId) { return container.querySelector<HTMLElement>(`[data-toolkit-capsule="${id}"]`)! }
function button(name: string, scope: ParentNode = container) { const value = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === name); expect(value, name).toBeDefined(); return value! }
async function click(name: string, scope: ParentNode = container) { await act(async () => button(name, scope).click()); await settle() }

it('accepts only explicit bounded Capsule object references in the original public document', () => {
  const good = documentFor(first.record.capsuleId)
  expect(parseToolkitResultDocument(good)).toEqual(good)
  for (const capsuleId of ['http://127.0.0.1:4000/', 'amux://capsule/' + first.record.capsuleId, 'not-an-object-id', '000000000000']) {
    expect(() => parseToolkitResultDocument({ ...good, capsules: [{ label: 'Bad', capsuleId }] })).toThrow()
  }
  for (const capsules of [[{ ...good.capsules![0], toolId: 'forged', executionId: 'forged' }], [...good.capsules!, ...good.capsules!], Array(17).fill(good.capsules![0]), null]) {
    expect(() => parseToolkitResultDocument({ ...good, capsules })).toThrow()
  }
  expect(() => parseToolkitResultDocument({ ...good, links: [{ label: 'Wrong channel', url: 'amux://capsule/' + first.record.capsuleId }] })).toThrow()
})

it('copies and opens the exact Capsule without rerunning its tool or borrowing declared provenance', async () => {
  await mount(snapshot(result(documentFor(first.record.capsuleId))), { copyOnRun: true, primaryActionId: 'rerun' })
  expect(row()).not.toBeNull()
  expect(api.capsules.call).not.toHaveBeenCalled(); expect(presentation).not.toHaveBeenCalled()
  expect(row().textContent).toContain('original-execution'); expect(row().textContent).toContain('captured-revision')
  expect(row().textContent).not.toContain('untrusted-declared')
  await click('Copy Capsule link', row())
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith('amux://capsule/' + first.record.capsuleId)
  expect(api.capsules.call).not.toHaveBeenCalled()
  await click('Open page', row())
  expect(presentation).toHaveBeenCalledOnce()
  expect(presentation.mock.calls[0][0]).toMatchObject({ capsuleId: first.record.capsuleId })
  expect(row().textContent).toContain('Opened in the original Browser workface.')
  expect(toolRun).not.toHaveBeenCalled(); expect(toolAction).not.toHaveBeenCalled()
})

it('keeps a retained display Capsule attached to its own original execution and configuration', async () => {
  const value = { ...definition(), display: { script: 'displayScript()', args: [] } }
  const retained = result(documentFor(first.record.capsuleId), 'retained-display-execution', value)
  const newer = result(null, 'newest-ordinary-execution', { ...value, revision: 'newest-revision' })
  const current = snapshot(newer)
  current.display = { state: 'failed', reason: 'Latest display failed', admission: null, sequence: 2,
    latestConfirmed: { ...result(null, 'failed-display-execution', value), state: 'failed', exitCode: 1 }, lastSucceeded: retained }
  await mount(current)
  expect(row().textContent).toContain('retained-display-execution'); expect(row().textContent).toContain('captured-revision')
  expect(row().textContent).not.toContain('newest-ordinary-execution'); expect(row().textContent).not.toContain('newest-revision')
  await click('Open page', row()); expect(presentation.mock.calls[0][0].capsuleId).toBe(first.record.capsuleId)
  expect(toolRun).not.toHaveBeenCalled(); expect(toolAction).not.toHaveBeenCalled()
})

it('checks a lost original open receipt and preserves that page through a newer tool result', async () => {
  const original = capsuleTransport
  let lost = false
  capsuleTransport = (async (method, params) => {
    const value = await original(method, params)
    if (method === 'capsule.open' && !lost) { lost = true; throw new Error('Original open reply lost') }
    return value
  }) as CapsulePort['call']
  const publish = await mount(snapshot(result(documentFor(first.record.capsuleId))))
  await click('Open page', row())
  const open = vi.mocked(api.capsules.call).mock.calls.find(([method]) => method === 'capsule.open')![1] as { operationId: string }
  expect(row().textContent).toContain(open.operationId)
  await publish(snapshot(result(documentFor(second.record.capsuleId, 'New result'), 'new-execution')))
  expect(row().textContent).toContain('original-execution'); expect(row(second.record.capsuleId)).not.toBeNull()
  await click('Check original open', row())
  expect(api.capsules.call).toHaveBeenCalledWith('capsule.operation.inspect', { operationId: open.operationId })
  expect(vi.mocked(api.capsules.call).mock.calls.filter(([method]) => method === 'capsule.open')).toHaveLength(1)
  expect(presentation).toHaveBeenCalledOnce()
  expect(row()).toBeNull() // The old row leaves only after its original operation is confirmed.
  expect(row(second.record.capsuleId).textContent).toContain('new-execution')
})

it('keeps an unobserved open unknown while another referenced Capsule remains usable', async () => {
  const original = capsuleTransport
  capsuleTransport = (async (method, params) => {
    if (method === 'capsule.open' && 'capsuleId' in params && params.capsuleId === first.record.capsuleId) throw new Error('Transport unobserved')
    return original(method, params)
  }) as CapsulePort['call']
  const doc = documentFor(first.record.capsuleId); doc.capsules!.push({ label: 'Independent page', capsuleId: second.record.capsuleId })
  await mount(snapshot(result(doc)))
  await click('Open page', row()); await click('Check original open', row())
  expect(row().textContent).toContain('still unconfirmed'); expect(button('Open page', row()).disabled).toBe(true)
  await click('Copy Capsule link', row()); await click('Open page', row(second.record.capsuleId))
  expect(presentation).toHaveBeenCalledOnce(); expect(presentation.mock.calls[0][0].capsuleId).toBe(second.record.capsuleId)
  expect(toolRun).not.toHaveBeenCalled(); expect(toolAction).not.toHaveBeenCalled()
})

it('never infers a Capsule from terminal text or a localhost link in an ordinary result', async () => {
  const doc: ToolkitResultDocument = { schema: 'agentmux.toolkit.result.v1', summary: 'Plain link', items: [], links: [{ label: 'Ordinary local URL', url: first.endpoint.status === 'available' ? first.endpoint.url : 'http://127.0.0.1:4000/' }], notice: '' }
  await mount(snapshot({ ...result(doc), text: JSON.stringify(documentFor(first.record.capsuleId)) }))
  expect(container.querySelector('[data-toolkit-capsule]')).toBeNull()
  expect(api.capsules.call).not.toHaveBeenCalled(); expect(toolRun).not.toHaveBeenCalled()
})

type ProcessRun = { id: string; child: ChildProcess; bytes: Buffer; state: 'running' | 'exited'; exitCode: number | null; listener: (event: AgentMuxClientEvent) => void }
function processPort() {
  const runs = new Map<string, ProcessRun>(), children: ChildProcess[] = [], launches: string[] = []
  const facts = (run: ProcessRun) => ({ runId: run.id, kind: 'terminal', state: run.state, pid: run.child.pid, cols: 80, rows: 24, observedAt: 1,
    latestOutputBytes: run.bytes.length, acceptedInputBytes: 0, ...(run.state === 'exited' ? { exitCode: run.exitCode } : {}) }) as AgentMuxRun
  const attached = (run: ProcessRun, after: number): AgentMuxRunAttachment => ({ run: facts(run), gap: null, resizeRevision: 0, terminal: { type: 'not-requested' }, replay: run.bytes.length > after
    ? [{ runId: run.id, type: 'data', startByte: after, endByte: run.bytes.length, dataBytes: run.bytes.subarray(after), data: '' }] : [] })
  const port: ToolkitRunPort = { observe: () => () => {},
    async create(input, listener) {
      launches.push(input.createOperationId!)
      const env = { ...process.env, ...input.env }
      delete env.AGENTMUX_AGENT_SESSION_ID; delete env.AGENTMUX_AGENT_CAPABILITY
      const child = spawn(input.command!, input.args ?? [], { cwd: input.workspacePath, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
      const run: ProcessRun = { id: 'toolkit-process-' + input.createOperationId, child, bytes: Buffer.alloc(0), state: 'running', exitCode: null, listener }; runs.set(run.id, run)
      const output = (bytes: Buffer) => { const startByte = run.bytes.length; run.bytes = Buffer.concat([run.bytes, bytes]); run.listener({ type: 'terminal-output', run: { runId: run.id }, data: '', dataBytes: bytes, evidence: { source: 'terminal-output', observedAt: 1, outputByteRange: { startByte, endByte: run.bytes.length } } }) }
      child.stdout!.on('data', output); child.stderr!.on('data', output)
      child.once('close', code => { run.state = 'exited'; run.exitCode = code; run.listener({ type: 'process-state', run: { runId: run.id }, state: 'exited', exitCode: code, evidence: { source: 'run-process', observedAt: 1 } }) })
      await once(child, 'spawn'); return facts(run)
    },
    async attach(ref, after, listener) { const run = runs.get(ref.runId)!; if (listener) run.listener = listener; return attached(run, after) },
    async replay(ref, after) { return attached(runs.get(ref.runId)!, after) }, async status(ref) { const run = runs.get(ref.runId); return run ? facts(run) : null },
    async release() {}, async remove(ref) { expect(runs.get(ref.runId)?.state).toBe('exited'); runs.delete(ref.runId) }, async stop(ref) { runs.get(ref.runId)?.child.kill('SIGTERM') }
  }
  return { port, launches, async close() { for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'close') } } }
}

it('carries a real authenticated producer through public RPC, durable receipt and the original UI consumer', async () => {
  const cli = resolve('packages/core/dist/agentmux.js'), process = processPort(), receipts = join(directory, 'toolkit-receipts.json')
  let saved = structuredClone(DEFAULT_CONFIG)
  const config = new ConfigOwner({ read: () => saved, save: async value => { saved = value; return value }, publish() {} })
  const toolkit = new ToolkitOwner({ openRunPort: async () => process.port, enabled: () => true, config, receiptPath: receipts,
    launch: () => ({ runner: globalThis.process.execPath, cli, script: resolve('apps/desktop/resources/toolkit/performance.mjs'), cwd: sourcePath, env: {} }) })
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'rpc.sock'), coreClients: () => [], toolkit, capsules: capsuleOwner })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    const script = `import {connectAgentMuxRpc} from ${JSON.stringify(resolve('packages/core/dist/index.js'))};
import {connectToolkitResultChannel} from ${JSON.stringify(resolve('packages/core/dist/toolkit-result-channel.js'))};
import {parseToolkitResultDocument} from ${JSON.stringify(resolve('packages/core/dist/toolkit-result-document.js'))};
const channel=await connectToolkitResultChannel(); const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:${JSON.stringify(server.path)}}});
try {const page=await rpc.call('capsule.create',{operationId:'producer-original-publication',sourcePath:${JSON.stringify(sourcePath)},title:'Producer page',source:{toolId:'untrusted-declared-tool',executionId:'untrusted-declared-execution'}});
channel.end(JSON.stringify(parseToolkitResultDocument({schema:'agentmux.toolkit.result.v1',summary:'Produced page',items:[],links:[],notice:'',capsules:[{label:'Producer report',capsuleId:page.record.capsuleId}]}))+'\\n');
await new Promise((yes,no)=>{channel.once('close',yes);channel.once('error',no)}); console.log('Diagnostic text is separate');}finally{await rpc.dispose();}`
    const { id: _id, revision: _revision, ...fields } = definition()
    const added = await rpc.call('toolkit.create', { toolId: definition().id, value: { ...fields, script } })
    expect(added.definition.id).toBe(definition().id)
    await rpc.call('toolkit.run', { toolId: definition().id })
    let current!: ToolkitScriptSnapshot
    await vi.waitFor(async () => { current = (await rpc.call('toolkit.inspect', { toolId: definition().id })).snapshot as ToolkitScriptSnapshot; expect(current.latestConfirmed?.state, current.reason ?? '').toBe('succeeded'); expect(current.admission).toBeNull() }, { timeout: 10000 })
    const execution = current.latestConfirmed!, id = execution.document!.capsules![0].capsuleId
    expect(execution.text).toBe('Diagnostic text is separate\n'); expect(execution.run!.runId).toContain('toolkit-process-')
    const persisted = JSON.parse(await readFile(receipts, 'utf8')); expect(persisted.tools[current.toolId].latestConfirmed.document).toEqual(execution.document)
    const env = { ...globalThis.process.env }
    delete env.AGENTMUX_AGENT_SESSION_ID; delete env.AGENTMUX_AGENT_CAPABILITY
    const cliRead = await promisify(execFile)(globalThis.process.execPath, [cli, '--endpoint', 'unix:' + server.path, 'toolkit', 'inspect', current.toolId], { env })
    const cliResult = JSON.parse(cliRead.stdout)
    expect(cliResult.ok).toBe(true); expect(cliResult.result.snapshot.latestConfirmed.document).toEqual(execution.document)
    await mount(current)
    capsuleTransport = (method, params) => rpc.call(method, params) as ReturnType<CapsulePort['call']>
    expect(row(id).textContent).toContain(execution.executionId); expect(row(id).textContent).not.toContain('untrusted-declared')
    await click('Open page', row(id)); await click('Copy Capsule link', row(id))
    expect(presentation).toHaveBeenCalledOnce(); expect(presentation.mock.calls[0][0].capsuleId).toBe(id)
    expect(api.ui.writeClipboardText).toHaveBeenCalledWith('amux://capsule/' + id)
    expect(process.launches).toHaveLength(1); expect(toolRun).not.toHaveBeenCalled(); expect(toolAction).not.toHaveBeenCalled()
  } finally { await rpc.dispose(); await server.stop(); await toolkit.dispose(); await process.close() }
})
