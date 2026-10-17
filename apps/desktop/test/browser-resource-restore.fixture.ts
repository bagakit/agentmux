// @vitest-environment happy-dom
// The isolated parent supplies private HOME, compiled CLI/register, source and evidence paths.
// This is a Node owner model, not complete Electron initialization or Native input proof.
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import { AgentMuxError } from '@agentmux/core'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec.js'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { browserColdDescriptor } from '../src/main/browser-cold-descriptor.js'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge.js'
import { nameChangeRequests, unknownNameContext, desktopNameContext } from '../src/main/name-change-audit.js'
import { senderTrust, assertSenderTrusted } from '../src/main/ipc-sender-trust.js'

const native = await vi.hoisted(async () => (await import('./helpers/browser-resource-directory-ports')).directoryNativePorts())
vi.mock('electron', () => ({ BaseWindow: native.BaseWindow, WebContentsView: native.View,
  app: { getPath: () => process.env.AGENTMUX_COLD_PRIVATE_ROOT } }))
import { BrowserViewManager } from '../src/main/browser-view-manager.js'
import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store.js'

const managers: BrowserViewManager[] = [], roots: string[] = [], originalApp = useAppStore.getState()
afterEach(() => {
  useAppStore.setState(originalApp, true)
  for (const manager of managers.splice(0)) manager.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'browser-restore-owner-')); roots.push(directory)
  const views: InstanceType<typeof native.View>[] = []
  const window = { webContents: new native.Contents(), isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), contentView: {
      children: views, addChildView(view: InstanceType<typeof native.View>, index = views.length) {
        const previous = views.indexOf(view); if (previous !== -1) views.splice(previous, 1)
        views.splice(index, 0, view)
      }, removeChildView(view: InstanceType<typeof native.View>) { const index = views.indexOf(view); if (index !== -1) views.splice(index, 1) }
    } }
  const manager = new BrowserViewManager(window as never,
    { defaultProfileId: () => 'default', resolvePartition: profile => 'persist:' + profile },
    new BrowserRefLedgerStore(directory), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
  managers.push(manager)
  return { manager, views }
}

// Execute only the original production function bytes with controlled transport ports.
const ipcSource = readFileSync(process.env.AGENTMUX_COLD_IPC_SOURCE ?? new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
function ipcFunction(name: string, ports: Record<string, unknown>) {
  const file = ts.createSourceFile('ipc.ts', ipcSource, ts.ScriptTarget.Latest, true)
  const found: ts.Node[] = []
  function walk(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer) found.push(node.initializer)
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'handleWithEvent' && node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === name) found.push(node.arguments[1]!)
    ts.forEachChild(node, walk)
  }
  walk(file); expect(found).toHaveLength(1)
  const code = ts.transpile(`const execute = ${found[0]!.getText(file)}`, { target: ts.ScriptTarget.ES2022 })
  return new Function(...Object.keys(ports), code + ';return execute')(...Object.values(ports))
}
function mainPorts(manager: BrowserViewManager) {
  // A warm restore must not reach saved state; the case installs its throwing counter before use.
  const spatialState = { read: vi.fn(async () => null) }
  const browserProfiles = { initialize: vi.fn(async () => {}) }
  const config = { workspaces: [{ id: 'workspace' }], browser: { agentAutomation: true } }
  const ensureBrowser = ipcFunction('ensureBrowser', { browsers: manager, browserColdDescriptor, spatialState, browserProfiles, config,
    workspace: (_config: unknown, id: string) => { if (id !== 'workspace') throw new Error('Wrong workspace') } })
  return { spatialState, ensureBrowser }
}

// Only these production function bytes are extracted; no claim of a whole Electron registration.
function preloadRestore(ipcRenderer: { invoke(channel: string, ...args: unknown[]): Promise<unknown> }) {
  const text = readFileSync(process.env.RESTORE_PRELOAD_SOURCE!, 'utf8')
  const file = ts.createSourceFile('preload.ts', text, ts.ScriptTarget.Latest, true)
  const found: ts.Expression[] = []
  const walk = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'restoreResource') found.push(node.initializer)
    ts.forEachChild(node, walk)
  }
  walk(file); expect(found).toHaveLength(1)
  const code = ts.transpile('const relay = ' + found[0]!.getText(file), { target: ts.ScriptTarget.ES2022 })
  return new Function('ipcRenderer', code + '; return relay')(ipcRenderer) as (...args: unknown[]) => Promise<any>
}

it('exact public Browser restore returns one current native row without catalog fanout', async () => {
  const evidence = process.env.RESTORE_EVIDENCE!, { manager, views } = fixture(), ports = mainPorts(manager)
  const original = await manager.create('page-0', 'https://fixture.invalid/original', 'workspace', 'original', 'normal', 'desktop')
  const contents = views[0]!.webContents
  const workbench = createWorkbenchTab('resource-tab', { ...original, kind: 'browser', regionId: 'resource-region', browserId: original.id, workspaceId: 'workspace' })
  useAppStore.setState({ tabs: { [workbench.id]: workbench } })
  const beforeState = useAppStore.getState(), beforeTabs = beforeState.tabs, beforeLayouts = beforeState.layouts
  const beforeWorkface = { activeWorkspaceId: beforeState.activeWorkspaceId, mainSurface: beforeState.mainSurface, retainedSpatialFocus: beforeState.retainedSpatialFocus }
  const counters = { catalog: 0, graph: 0, metrics: 0, nativeLists: 0, ensure: 0 }
  const forbidden = (name: keyof typeof counters) => () => { counters[name]++; throw new Error('Unexpected full resource fanout: ' + name) }
  ports.spatialState.read.mockImplementation(forbidden('graph'))
  vi.spyOn(manager, 'targets').mockImplementation(forbidden('nativeLists'))
  vi.spyOn(manager, 'resourceTargets').mockImplementation(forbidden('nativeLists'))
  const catalog = vi.spyOn(api.browser, 'listTargets').mockImplementation(forbidden('catalog'))
  const create = vi.spyOn(manager, 'create'), navigate = vi.spyOn(manager, 'navigate'), close = vi.spyOn(manager, 'close')
  const programLookup = vi.spyOn(manager, 'getOperation')
  const requests: any[] = [], rawRequests: any[] = [], contexts: any[] = []
  const ensureContexts: any[] = [], desktopContexts: any[] = [], wrongAdmissions: any[] = []
  let registered: (...args: any[]) => Promise<any>
  let lastSnapshotNavigation: string | undefined
  const ensureBrowser = async (id: string) => {
    counters.ensure++
    ensureContexts.push(structuredClone(nameChangeRequests.getStore()))
    const snapshot = await ports.ensureBrowser(id)
    lastSnapshotNavigation = snapshot.navigationId
    // An actual lifecycle event on the same model WC advances its current document after Snapshot.
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://fixture.invalid/concurrent' })
    return snapshot
  }
  let bridge: DesktopControlIpcBridge
  bridge = new DesktopControlIpcBridge({
    isAvailable: () => true,
    sendRequest(request) {
      requests.push(structuredClone(request))
      void (async () => {
        if (requests.length === 1) {
          const before = counters.ensure
          await expect(registered({ sender: trustedContents }, 'foreign-browser', request.requestId)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
          expect(counters.ensure).toBe(before)
          wrongAdmissions.push({ trustedSender: true, activeRequestId: request.requestId, wrongBrowserId: 'foreign-browser', ensureBefore: before, ensureAfter: counters.ensure })
        }
        return await useAppStore.getState().executeControl(request as any, undefined, { admittedControlRequestId: request.requestId })
      })().then(result => {
        bridge.accept({ requestId: request.requestId, ok: true, result } as any)
      }, error => bridge.accept({ requestId: request.requestId, ok: false, error: { code: error.code ?? 'CONTROL_FAILED', message: error.message } } as any))
    },
    sendCancellation() { /* The original reader ends; this fixture does not stop or repeat an owner. */ }
  })
  const mainExecute = ipcFunction('executeControl', { nameChangeRequests, unknownNameContext, executeControlOwner: (request: any, signal: AbortSignal) => bridge.execute(request, signal) })
  const trustedContents = (manager as any).window.webContents
  const requireTrustedSender = (channel: any, event: any) => assertSenderTrusted(senderTrust(channel, event.sender, trustedContents))
  const resume = ipcFunction('browser:restoreResource', { ensureBrowser, browsers: manager, controlBridge: bridge, nameChangeRequests, requireTrustedSender, AgentMuxError,
    app: { getAppMetrics: forbidden('metrics') } })
  const registrations = new Map<string, (...args: any[]) => Promise<any>>()
  const handleWithEvent = ipcFunction('handleWithEvent', { channels: [], ipcMain: { handle: (channel: string, listener: (...args: any[]) => Promise<any>) => registrations.set(channel, listener) },
    nameChangeRequests, desktopNameContext, randomUUID, contents: trustedContents, args: { window: { id: 1 } } })
  handleWithEvent('browser:restoreResource', (event: unknown, ...values: unknown[]) => {
    desktopContexts.push({ browserId: values[0], admittedControlRequestId: values[1], ...structuredClone(nameChangeRequests.getStore()) })
    return resume(event, ...values)
  })
  registered = registrations.get('browser:restoreResource')!
  const relay = preloadRestore({ invoke: async (channel, ...args) => {
    expect(channel).toBe('browser:restoreResource')
    return await registered({ sender: trustedContents }, ...args)
  } })
  vi.spyOn(api.browser, 'restoreResource').mockImplementation((...args) => relay(...args))
  const directory = mkdtempSync(join(tmpdir(), 'browser-restore-cli-')); roots.push(directory)
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'rpc.sock'), execute: (request, context) => {
    contexts.push({ operationId: request.requestId, actorVerified: context?.actor.verified, entryPoint: context?.entryPoint, context: structuredClone(context) })
    return mainExecute(request, context)
  } })
  const dispatcher = (server as any).dispatcher, receive = dispatcher.receive.bind(dispatcher)
  vi.spyOn(dispatcher, 'receive').mockImplementation((request: any, context: any) => {
    if (request.method === 'browser.restore') rawRequests.push({ wireId: request.id, operationId: request.params?.operationId })
    return receive(request, context)
  })
  async function cli(label: string, args: string[]) {
    const child = spawn(process.execPath, ['--import', process.env.RESTORE_REGISTER!, process.env.RESTORE_CLI_ENTRY!, ...args], {
      cwd: process.env.AGENTMUX_COLD_PRIVATE_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', b => { stdout += b; if (stdout.length > 1024 * 1024) child.kill('SIGKILL') })
    child.stderr.on('data', b => { stderr += b; if (stderr.length > 128 * 1024) child.kill('SIGKILL') })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 12000)
    const exit = await new Promise<{ code: number | null; signal: string | null }>((yes, no) => {
      child.once('error', no); child.once('close', (code, signal) => yes({ code, signal }))
    }).finally(() => clearTimeout(timeout))
    writeFileSync(join(evidence, label + '.json'), JSON.stringify({ ...exit, stdout, stderr, pid: child.pid }))
    expect(exit.signal).toBeNull()
    const resultChannel = exit.code === 0 ? stdout : stderr
    return { ...exit, body: resultChannel.trim().startsWith('{') ? JSON.parse(resultChannel) : null, stdout }
  }
  try {
    await server.start()
    const args = ['--endpoint', 'unix://' + server.path, 'browser', 'restore', '--browser', original.id]
    const receipt = await cli('ready', [...args, '--operation-id', 'restore-ready-operation'])
    // The sole loaded Store inverse fails this actual CLI assertion, after real restore occurred.
    expect(receipt.code).toBe(0)
    expect(receipt.body.operationId).toBe('restore-ready-operation')
    expect(receipt.body.result.target).toMatchObject({ id: original.id, workspaceId: 'workspace', source: 'embedded', status: 'ready', mode: 'normal' })
    expect(receipt.body.result.target.navigationId).not.toBe(lastSnapshotNavigation)
    expect(receipt.body.result.target).not.toHaveProperty('resource')
    expect(receipt.body.result).not.toHaveProperty('targets'); expect(receipt.body.result).not.toHaveProperty('coverage')
    expect(requests[0]).toMatchObject({ operation: 'browser.restore', browserId: original.id, requestId: 'restore-ready-operation' })
    expect(requests[0]).not.toHaveProperty('operationId')
    expect(rawRequests[0].operationId).toBe('restore-ready-operation'); expect(rawRequests[0].wireId).not.toBe(rawRequests[0].operationId)
    expect(contexts[0]).toMatchObject({ operationId: 'restore-ready-operation', actorVerified: true, entryPoint: 'browser.restore' })
    expect(ensureContexts[0]).toEqual({ operationId: 'restore-ready-operation', context: contexts[0].context })
    const desktop = desktopContexts.find(row => row.browserId === original.id && row.admittedControlRequestId === 'restore-ready-operation')
    expect(desktop.context).toMatchObject({ source: 'desktop-ui', entryPoint: 'browser:restoreResource', transport: 'electron-ipc' })
    expect(desktop.operationId).not.toBe('restore-ready-operation')
    expect(desktop.context).not.toEqual(ensureContexts[0].context)
    expect(wrongAdmissions).toEqual([{ trustedSender: true, activeRequestId: 'restore-ready-operation', wrongBrowserId: 'foreign-browser', ensureBefore: 0, ensureAfter: 0 }])
    const target = receipt.body.result.target
    expect(parseRpcControlResult('browser.restore', { target }, { browserId: original.id })).toEqual({ target })
    for (const foreign of [{ ...target, id: 'foreign' }, { ...target, source: 'external' }, { ...target, status: 'unavailable' }, { ...target, resource: { state: 'cold', locations: [], processes: [] } }]) {
      expect(() => parseRpcControlResult('browser.restore', { target: foreign }, { browserId: original.id })).toThrow()
    }
    const lost = vi.spyOn(manager, 'target').mockReturnValueOnce(null)
    const unknown = await cli('unknown', [...args, '--operation-id', 'restore-unknown-operation'])
    expect(unknown.code).toBe(1); expect(unknown.body.operationId).toBe('restore-unknown-operation')
    expect(unknown.body.error.code).toBe('CONTROL_UNAVAILABLE')
    expect(unknown.body.error.message).toContain('unconfirmed')
    expect(unknown.body.error.message).toContain('do not automatically repeat')
    expect(ensureContexts[1]).toEqual({ operationId: 'restore-unknown-operation', context: contexts[1].context })
    lost.mockRestore()
    expect(manager.target(original.id)?.status).toBe('ready')
    expect(counters).toEqual({ catalog: 0, graph: 0, metrics: 0, nativeLists: 0, ensure: 2 })
    expect(catalog).not.toHaveBeenCalled(); expect(programLookup).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
    expect(contents.loads).toEqual(['https://fixture.invalid/original']); expect(contents.focus).not.toHaveBeenCalled(); expect(contents.dead).toBe(false)
    expect(views).toHaveLength(1)
    expect((manager as any).entries.get(original.id).view.webContents).toBe(contents)
    expect((manager as any).entries.get(original.id).storage.profileId).toBe(original.profileId)
    expect((manager as any).entries.get(original.id).workspaceId).toBe('workspace')
    expect(useAppStore.getState().tabs).toBe(beforeTabs); expect(useAppStore.getState().layouts).toBe(beforeLayouts)
    expect({ activeWorkspaceId: useAppStore.getState().activeWorkspaceId, mainSurface: useAppStore.getState().mainSurface, retainedSpatialFocus: useAppStore.getState().retainedSpatialFocus }).toEqual(beforeWorkface)
    await expect(registered({ sender: {} }, original.id, 'not-admitted')).rejects.toThrow(/Untrusted/)
    expect(counters.ensure).toBe(2)
    const actionHelp = await cli('help', ['browser', 'restore', '--help'])
    expect(actionHelp.code).toBe(0); expect(actionHelp.stdout).toContain('one current native target'); expect(actionHelp.stdout).toContain('unknown reply')
    const skill = await cli('skill', ['browser', '--skill'])
    expect(skill.code).toBe(0); expect(skill.stdout).toContain('browser restore')
    writeFileSync(join(evidence, 'consumer.json'), JSON.stringify({ passed: true, counters, requests, rawRequests, contexts, ensureContexts, desktopContexts, wrongAdmissions,
      target, unknown: unknown.body, workspace: 'workspace', profile: original.profileId, sameBrowser: original.id,
      originalRegion: 'resource-region', native: false,
      qualification: 'Production Store/Core/bridge and source-extracted actual Main/preload function expressions; real Unix and per-module compiled CLI. Electron native owner is the existing factory model. No whole preload initialization or Native claim.' }, null, 2))
  } finally { await server.stop(); bridge.dispose() }
})
