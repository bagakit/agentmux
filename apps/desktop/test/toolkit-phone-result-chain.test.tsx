// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, defaultAgentMuxControlSocketPath, type AgentMuxClientEvent, type AgentMuxRun, type AgentMuxRunAttachment } from '@agentmux/core'
import { type ToolkitScriptSnapshot } from '@agentmux/core/control'
import { connectionLinkUrl, connectionOfferUrl, parseConnectionLinkUrl } from '../../../packages/relay/src/connection-offer'
import { createDeviceAdministration } from '../../host/src/device-administration'
import { DeviceAuthority } from '../../host/src/device-authority'
import { ConfigOwner } from '../src/main/config-owner'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { ToolkitOwner } from '../src/main/toolkit-owner'
import type { ToolkitRunPort } from '../src/main/toolkit-run-port'
import { MobileConnectionResult } from '../src/renderer/src/components/toolkit/MobileConnectionResult'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { api } from '../src/renderer/src/lib/api'
import { MOBILE_CONNECTION_TOOL_ID } from '../src/shared/toolkit-preferences'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { composerDOM } from './helpers/composer-dom-fixture'
vi.mock('electron', () => ({ app: { getPath: () => process.cwd(), getAppPath: () => process.cwd() } }))

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const dom = composerDOM()
const appOrigin = 'https://10.0.0.44:4700'
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
let moduleDirectory: string, cli: string, preload: string
let cliSha256: string, helperSha256: string
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
beforeAll(async () => {
  moduleDirectory = await mkdtemp(fixturePath('tmp/amux-phone-cli-'))
  cli = resolve(repository, 'packages/core/dist/agentmux.js'); preload = join(moduleDirectory, 'observe-env.mjs')
  cliSha256 = hash(await readFile(cli)); helperSha256 = hash(await readFile(join(dirname(cli), 'toolkit-result-channel.js')))
  await writeFile(preload, `import {appendFileSync} from 'node:fs';
const device=process.argv.includes('device');
appendFileSync(process.env.PRIVATE_ENV_REPORT,JSON.stringify({device,args:process.argv.slice(2),pathPresent:Boolean(process.env.AGENTMUX_TOOLKIT_RESULT_PATH),tokenPresent:Boolean(process.env.AGENTMUX_TOOLKIT_RESULT_TOKEN),sessionPresent:Boolean(process.env.AGENTMUX_AGENT_SESSION_ID),capabilityPresent:Boolean(process.env.AGENTMUX_AGENT_CAPABILITY)})+'\\n');
if(!device&&process.env.PRIVATE_NATIVE_DIAGNOSTIC)process.stderr.write(process.env.PRIVATE_NATIVE_DIAGNOSTIC);
`)
}, 30000)
afterAll(async () => { if (moduleDirectory) await rm(moduleDirectory, { recursive: true }) })

type ProcessRun = { id: string; child: ChildProcess; bytes: Buffer; state: 'running' | 'exited'; exitCode: number | null; listener: (event: AgentMuxClientEvent) => void }
function nodeProcessPort() {
  const runs = new Map<string, ProcessRun>(), children: ChildProcess[] = [], launches: Array<{ cwd: string; args: string[] }> = []
  const facts = (run: ProcessRun) => ({ runId: run.id, kind: 'terminal', state: run.state, pid: run.child.pid, cols: 80, rows: 24,
    observedAt: _newTailFixtureEpoch(0, 0, 1), latestOutputBytes: run.bytes.length, acceptedInputBytes: 0, ...(run.state === 'exited' ? { exitCode: run.exitCode } : {}) }) as AgentMuxRun
  const snapshot = (run: ProcessRun, after: number): AgentMuxRunAttachment => ({ run: facts(run), gap: null, resizeRevision: 0, terminal: { type: 'not-requested' },
    replay: run.bytes.length > after ? [{ runId: run.id, type: 'data', startByte: after, endByte: run.bytes.length, dataBytes: run.bytes.subarray(after), data: '' }] : [] })
  const port: ToolkitRunPort = { prepare: async () => { throw new Error('This finite-tool fixture does not prepare TUI Runs') }, createPrepared: async () => { throw new Error('This finite-tool fixture does not create TUI Runs') }, observe: () => () => {},
    async create(input, listener) {
      expect(input.args?.slice(0, 2)).toEqual(['--input-type=module', '--eval'])
      expect(input.workspacePath.startsWith(repository)).toBe(false)
      launches.push({ cwd: input.workspacePath, args: input.args ?? [] })
      const child = spawn(input.command!, input.args ?? [], { cwd: input.workspacePath, env: { ...process.env, ...input.env,
        AGENTMUX_AGENT_SESSION_ID: 'private-untrusted-claim', AGENTMUX_AGENT_CAPABILITY: 'private-untrusted-capability' }, stdio: ['ignore', 'pipe', 'pipe'] })
      children.push(child)
      const run: ProcessRun = { id: `private-process-${input.createOperationId}`, child, bytes: Buffer.alloc(0), state: 'running', exitCode: null, listener }
      runs.set(run.id, run)
      const output = (bytes: Buffer) => { const startByte = run.bytes.length; run.bytes = Buffer.concat([run.bytes, bytes]); listener({ type: 'terminal-output', run: { runId: run.id }, data: '', dataBytes: bytes,
        evidence: { source: 'terminal-output', observedAt: _newTailFixtureEpoch(0, 0, 1), outputByteRange: { startByte, endByte: run.bytes.length } } }) }
      child.stdout!.on('data', output); child.stderr!.on('data', output)
      child.once('close', code => { run.state = 'exited'; run.exitCode = code; listener({ type: 'process-state', run: { runId: run.id }, state: 'exited', exitCode: code, evidence: { source: 'run-process', observedAt: _newTailFixtureEpoch(0, 0, 1) } }) })
      await once(child, 'spawn'); return facts(run)
    },
    async attach(ref, after, listener) { const run = runs.get(ref.runId)!; if (listener) run.listener = listener; return snapshot(run, after) },
    async replay(ref, after) { return snapshot(runs.get(ref.runId)!, after) },
    async status(ref) { const run = runs.get(ref.runId); return run ? facts(run) : null },
    async release() {},
    async remove(ref) { expect(runs.get(ref.runId)?.state).toBe('exited'); runs.delete(ref.runId) },
    async stop(ref) { runs.get(ref.runId)?.child.kill('SIGTERM') }
  }
  return { port, launches, async close() { for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'close') } } }
}

it.each(['', 'Native bridge diagnostic\n', 'NativeError: logger initialization\n  at originalProbe (node:internal/bridge)\n'])('official external-cwd Phone producer reaches the public typed receipt and QR with diagnostics %j', async diagnostic => {
  const directory = await mkdtemp(fixturePath('tmp/amux-phone-result-')), work = join(directory, 'external-cwd'), envReport = join(directory, 'child-env.jsonl')
  await mkdir(work)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', directory)
  const authority = await DeviceAuthority.open(join(directory, 'devices.json'), () => 1)
  const device = await authority.authorizeKey(Buffer.alloc(32, 7).toString('base64'))
  await authority.hello(device.deviceId, 'Original phone')
  const connection = authority.observe(device, { address: '192.0.2.24', userAgent: 'Private browser declaration' })
  const offer = { v: 2 as const, serverId: authority.hostId, daemonPublicKeyB64: Buffer.alloc(32, 9).toString('base64'), relay: { endpoint: '10.0.0.44:4700', useTls: true } }
  const completeURL = connectionLinkUrl(appOrigin + '/', offer)
  expect(parseConnectionLinkUrl(completeURL)).toEqual({ kind: 'pin', pin: { daemonPublicKeyB64: offer.daemonPublicKeyB64 } })
  const devices = createDeviceAdministration(() => Promise.resolve(authority), () => ({ state: 'connected', message: 'Original private Host', origin: appOrigin }), async () => ({ url: completeURL, offer, candidates: [] }))
  const config = new ConfigOwner({ read: () => DEFAULT_CONFIG, save: async value => value, publish() {} }), processes = nodeProcessPort()
  const owner = new ToolkitOwner({ openRunPort: async () => processes.port, enabled: () => true, config, receiptPath: join(directory, 'receipts.json'),
    launch: () => ({ runner: process.execPath, cli, script: resolve(repository, 'apps/desktop/resources/toolkit/performance.mjs'), cwd: work,
      env: { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: `--import=${preload}`, PRIVATE_ENV_REPORT: envReport, PRIVATE_NATIVE_DIAGNOSTIC: diagnostic } }) })
  const server = new AgentMuxControlServer({ socketPath: defaultAgentMuxControlSocketPath(), coreClients: () => [], toolkit: owner, deviceAdministration: devices })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const subscriptions: Array<Promise<{ dispose(): Promise<void> }>> = []
  try {
    const settingsLink = await rpc.call('device.link', {}), settingsDevices = await rpc.call('device.ls', {})
    expect(settingsLink.url).toBe(completeURL); expect(settingsDevices.devices[0]?.deviceId).toBe(device.deviceId)
    const get = vi.spyOn(api.toolkit, 'get').mockImplementation(async () => (await rpc.call('toolkit.inspect', { toolId: MOBILE_CONNECTION_TOOL_ID })).snapshot)
    const evaluate = vi.spyOn(api.toolkit, 'evaluate').mockImplementation(async () => (await rpc.call('toolkit.evaluate', { toolId: MOBILE_CONNECTION_TOOL_ID })).snapshot)
    const run = vi.spyOn(api.toolkit, 'run'), action = vi.spyOn(api.toolkit, 'action'), clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
    vi.spyOn(api.toolkit, 'observe').mockImplementation((toolId, read, end, options) => {
      const sub = rpc.subscribe('toolkit.watch', { toolId, evaluateOnDisplay: options?.evaluateOnDisplay }, {
        onInitial: value => { expect(value.toolId).toBe(toolId) }, onEvent: value => { if (value.type === 'snapshot') read(value.data) }, onEnd: error => end?.(error?.message ?? 'Original toolkit observation ended') })
      subscriptions.push(sub); return { dispose() { void sub.then(value => value.dispose()) } }
    })
    const navigate = vi.fn()
    await dom.render(<SettingsNavigation.Provider value={{ open: navigate, openToolkit() {} }}><MobileConnectionResult active close={() => {}} /></SettingsNavigation.Provider>)
    await vi.waitFor(async () => {
      const value = (await rpc.call('toolkit.inspect', { toolId: MOBILE_CONNECTION_TOOL_ID })).snapshot as ToolkitScriptSnapshot
      expect(value.display?.latestConfirmed?.document?.links[0]?.url, JSON.stringify(value.display)).toBe(settingsLink.url)
    }, { timeout: 10000 })
    await act(async () => { await Promise.resolve() })
    expect(dom.container.querySelector('svg[role="img"]')).not.toBeNull()
    const snapshot = (await rpc.call('toolkit.inspect', { toolId: MOBILE_CONNECTION_TOOL_ID })).snapshot as ToolkitScriptSnapshot
    expect(snapshot.display?.latestConfirmed).toMatchObject({ state: 'succeeded', exitCode: 0, document: { links: [{ url: settingsLink.url }], items: [{ label: 'Original phone', value: 'Connected · 192.0.2.24' }] } })
    expect(snapshot.display?.latestConfirmed?.text).toBe(diagnostic)
    expect(snapshot.display?.latestConfirmed?.run?.runId).toMatch(/^private-process-/u)
    const textarea = dom.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Phone connection link"]')!
    expect(textarea.value).toBe(settingsLink.url)
    const copy = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Copy shown link')!
    await act(async () => copy.click())
    expect(clipboard).toHaveBeenCalledExactlyOnceWith(settingsLink.url)
    const manage = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Phone settings')!
    await act(async () => manage.click())
    expect(navigate).toHaveBeenCalledExactlyOnceWith('mobile')
    expect(evaluate).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled()
    expect(processes.launches).toHaveLength(1)
    const observed = (await readFile(envReport, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(observed.filter(value => !value.device)).toHaveLength(1)
    expect(observed.filter(value => !value.device)[0]).toMatchObject({ pathPresent: true, tokenPresent: true })
    expect(observed.filter(value => value.device)).toHaveLength(2)
    for (const child of observed.filter(value => value.device)) expect(child).toMatchObject({ pathPresent: false, tokenPresent: false, sessionPresent: false, capabilityPresent: false })
    const persisted = JSON.parse(await readFile(join(directory, 'receipts.json'), 'utf8'))
    expect(persisted.tools[MOBILE_CONNECTION_TOOL_ID].display.latestConfirmed.document).toEqual(snapshot.display!.latestConfirmed!.document)
    if (process.env.AGENTMUX_TOOLKIT_CONSUMER_EVIDENCE) await appendFile(join(process.env.AGENTMUX_TOOLKIT_CONSUMER_EVIDENCE, 'producer-chain.jsonl'), JSON.stringify({
      diagnostic, compiledCli: { cliSha256, helperSha256 }, settingsLink, settingsDevices, snapshot, observed, launches: processes.launches.map(value => ({ externalCwd: !value.cwd.startsWith(repository), argv: value.args.slice(0, 2), scriptSha256: hash(value.args[2]!), cliModule: value.args.at(-3) === cli })),
      publicCalls: { get: get.mock.calls.length, evaluate: evaluate.mock.calls.length, run: run.mock.calls.length, action: action.mock.calls.length }, clipboard: clipboard.mock.calls,
      sources: Object.fromEntries(await Promise.all(['apps/desktop/resources/toolkit/mobile-connection/query.mjs', 'apps/desktop/src/main/toolkit-custom-owner.ts', 'apps/desktop/src/renderer/src/components/toolkit/MobileConnectionResult.tsx', 'packages/core/src/toolkit.ts', 'packages/core/src/toolkit-result-channel.ts'].map(async path => [path, hash(await readFile(resolve(repository, path)))])))
    }) + '\n')
  } finally {
    await dom.render(<p>Closed</p>)
    for (const sub of subscriptions) await (await sub).dispose()
    await rpc.dispose(); await server.stop(); await owner.dispose(); await processes.close(); connection.dispose(); await authority.flush()
    await rm(directory, { recursive: true }); vi.unstubAllEnvs()
  }
}, 30000)

/** Reuse the real finite process/result-channel and public Host/Toolkit owners. */
async function currentLinkChain() {
  const directory = await mkdtemp(fixturePath('tmp/amux-current-phone-')), work = join(directory, 'external-cwd'), envReport = join(directory, 'child-env.jsonl')
  await mkdir(work); vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', directory)
  const authority = await DeviceAuthority.open(join(directory, 'devices.json'), () => 1), processes = nodeProcessPort()
  let endpoint = '192.0.2.44:4700', gate: Promise<void> | null = null, release: (() => void) | null = null, loseNext = false, creates = 0
  const hostLink = vi.fn(async () => {
    if (gate) await gate
    const offer = { v: 2 as const, serverId: authority.hostId, daemonPublicKeyB64: Buffer.alloc(32, 9).toString('base64'), relay: { endpoint, useTls: true } }
    return { url: connectionOfferUrl('https://' + endpoint + '/mobile/', offer), offer, candidates: [] }
  })
  const devices = createDeviceAdministration(() => Promise.resolve(authority), () => ({ state: 'connected', message: 'Controlled original Host' }), hostLink)
  const config = new ConfigOwner({ read: () => DEFAULT_CONFIG, save: async value => value, publish() {} })
  const owner = new ToolkitOwner({ openRunPort: async () => ({ ...processes.port, create: async (input, listener) => {
    creates++; const result = await processes.port.create(input, listener)
    if (loseNext) { loseNext = false; throw Error('Controlled original display creation reply lost') }
    return result
  } }), enabled: () => true, config, receiptPath: join(directory, 'receipts.json'),
    launch: () => ({ runner: process.execPath, cli, script: resolve(repository, 'apps/desktop/resources/toolkit/performance.mjs'), cwd: work,
      env: { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: `--import=${preload}`, PRIVATE_ENV_REPORT: envReport } }) })
  const server = new AgentMuxControlServer({ socketPath: defaultAgentMuxControlSocketPath(), coreClients: () => [], toolkit: owner, deviceAdministration: devices })
  await server.start(); const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const subscriptions: Array<Promise<{ dispose(): Promise<void> }>> = []
  const get = vi.spyOn(api.toolkit, 'get').mockImplementation(async () => {
    const value = await rpc.call('toolkit.inspect', { toolId: MOBILE_CONNECTION_TOOL_ID })
    return value.snapshot
  })
  const evaluate = vi.spyOn(api.toolkit, 'evaluate').mockImplementation(async (toolId, input) => {
    return (await rpc.call('toolkit.evaluate', { toolId, ...(input ? { input } : {}) })).snapshot
  })
  const run = vi.spyOn(api.toolkit, 'run'), action = vi.spyOn(api.toolkit, 'action'), clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  vi.spyOn(api.toolkit, 'observe').mockImplementation((toolId, read, end, options) => {
    const sub = rpc.subscribe('toolkit.watch', { toolId, evaluateOnDisplay: options?.evaluateOnDisplay }, {
      onInitial: value => { expect(value.toolId).toBe(toolId) }, onEvent: value => { if (value.type === 'snapshot') read(value.data) }, onEnd: error => end?.(error?.message ?? 'Original toolkit observation ended') })
    subscriptions.push(sub); return { dispose() { void sub.then(value => value.dispose()) } }
  })
  const inspect = async () => (await rpc.call('toolkit.inspect', { toolId: MOBILE_CONNECTION_TOOL_ID })).snapshot as ToolkitScriptSnapshot
  const press = async (label: string) => { await act(async () => {
    const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === label)
    expect(button, label).toBeDefined(); expect(button!.disabled, label).toBe(false); button!.click()
  }) }
  await dom.render(<MobileConnectionResult active close={() => {}} />)
  await vi.waitFor(async () => {
    const snapshot = await inspect()
    expect(snapshot.display?.latestConfirmed?.document?.links).toHaveLength(1)
    expect(snapshot.display?.admission, 'The original owner must finish its exact Run cleanup before another display admission').toBeNull()
    const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === 'Refresh & copy link')
    expect(button?.disabled).toBe(false)
  }, { timeout: 10000 })
  return { authority, owner, rpc, inspect, evaluate, clipboard, run, action, hostLink, processes, press, creates: () => creates,
    change: (value: string) => { endpoint = value }, hold: () => { gate = new Promise<void>(resolve => { release = resolve }) },
    release: () => { release?.(); gate = null; release = null }, loseNext: () => { loseNext = true },
    close: async () => {
      release?.(); gate = null; await dom.render(<p>Closed</p>)
      for (const sub of subscriptions) await (await sub).dispose()
      await rpc.dispose(); await server.stop(); await owner.dispose(); await processes.close(); await authority.flush()
      await rm(directory, { recursive: true }); vi.unstubAllEnvs()
    } }
}

it('real current phone producer waits for the new exact display receipt after the original Host address changes', async () => {
  const f = await currentLinkChain()
  try {
    const before = await f.inspect(), original = before.display!.latestConfirmed!, previousURL = original.document!.links[0]!.url
    f.change('192.0.2.62:4700'); f.hold()
    await f.press('Refresh & copy link')
    await vi.waitFor(() => expect(f.hostLink, JSON.stringify({ evaluations: f.evaluate.mock.calls, creates: f.creates(), ui: dom.container.textContent })).toHaveBeenCalledTimes(2), { timeout: 10000 })
    expect(f.evaluate).toHaveBeenCalledExactlyOnceWith(MOBILE_CONNECTION_TOOL_ID, { invocationId: expect.any(String),
      expectedRevision: before.definition.revision, expectedLatestExecutionId: original.executionId })
    const admitted = (await f.inspect()).display!.admission!
    expect(admitted.invocationId).toBe(f.evaluate.mock.calls[0]![1]!.invocationId)
    expect(admitted.executionId).not.toBe(original.executionId)
    expect(f.clipboard).not.toHaveBeenCalled()
    expect((dom.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(previousURL)
    f.release()
    await vi.waitFor(async () => {
      const live = (await f.inspect()).display!
      expect(f.clipboard, JSON.stringify({ state: live.state, reason: live.reason, admission: live.admission?.executionId,
        result: live.latestConfirmed && { executionId: live.latestConfirmed.executionId, invocationId: live.latestConfirmed.invocationId,
          expectedLatestExecutionId: live.latestConfirmed.expectedLatestExecutionId, revision: live.latestConfirmed.definition.revision,
          workspacePath: live.latestConfirmed.target.workspacePath, state: live.latestConfirmed.state, hasDocument: Boolean(live.latestConfirmed.document) }, ui: dom.container.textContent })).toHaveBeenCalledTimes(1)
    }, { timeout: 10000 })
    const after = await f.inspect(), current = after.display!.latestConfirmed!, url = current.document!.links[0]!.url
    expect(current.executionId).toBe(admitted.executionId)
    expect(new URL(url).origin).toBe('https://192.0.2.62:4700')
    expect(f.clipboard).toHaveBeenCalledExactlyOnceWith(url)
    expect((dom.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(url)
    expect(dom.container.querySelector('svg[role="img"]')).not.toBeNull()
    expect(f.authority.devices()).toEqual([])
    expect(after.admission).toEqual(before.admission); expect(after.latestConfirmed).toEqual(before.latestConfirmed)
    expect(f.run).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled(); expect(f.creates()).toBe(2)
  } finally { await f.close() }
}, 30000)

it('real fresh-copy pins a new invocation and conflicts without resuming an old unknown display admission', async () => {
  const f = await currentLinkChain()
  try {
    const before = await f.inspect(), previous = before.display!.latestConfirmed!
    f.hold(); f.loseNext()
    await f.rpc.call('toolkit.evaluate', { toolId: MOBILE_CONNECTION_TOOL_ID, input: { invocationId: 'controlled-original-unknown-display',
      expectedRevision: before.definition.revision, expectedLatestExecutionId: previous.executionId } }).catch(() => {})
    await vi.waitFor(async () => expect((await f.inspect()).display).toMatchObject({ state: 'unknown', admission: { run: null } }))
    const original = (await f.inspect()).display!.admission!, creates = f.creates()
    await vi.waitFor(() => expect(dom.container.textContent).toContain('Current connection details are unavailable'))
    await f.press('Refresh & copy link')
    await vi.waitFor(() => expect(dom.container.textContent).toContain('Display evaluation targets another in-use request.'))
    const input = f.evaluate.mock.calls[0]![1]!
    expect(input.invocationId).not.toBe(original.invocationId)
    expect(input).toMatchObject({ expectedRevision: before.definition.revision, expectedLatestExecutionId: previous.executionId })
    expect((await f.inspect()).display!.admission).toEqual(original)
    expect(f.creates()).toBe(creates)
    expect(f.clipboard).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled()
    await f.press('Copy shown link')
    expect(f.clipboard).toHaveBeenCalledExactlyOnceWith(previous.document!.links[0]!.url)
    expect(f.creates()).toBe(creates)
  } finally { await f.close() }
}, 30000)
