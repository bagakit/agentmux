// The isolated parent supplies private HOME and the original CLI/source paths.
// Controlled Electron ports model the native owner; this is not Native input proof.
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import ts from 'typescript'
import { AgentMuxError } from '@agentmux/core'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec.js'
import { nameChangeRequests, unknownNameContext } from '../src/main/name-change-audit.js'
import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store.js'

const native = await vi.hoisted(async () => (await import('./helpers/browser-resource-directory-ports')).directoryNativePorts())
vi.mock('electron', () => ({ BaseWindow: native.BaseWindow, WebContentsView: native.View,
  app: { getPath: () => process.env.AGENTMUX_COLD_PRIVATE_ROOT } }))
import { BrowserViewManager } from '../src/main/browser-view-manager.js'

const managers: BrowserViewManager[] = [], roots: string[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose()
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.restoreAllMocks()
})

it('public release reaches the original Main owner without acquiring or relaying pages', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-release-')); roots.push(directory)
  const views: InstanceType<typeof native.View>[] = []
  const window = { webContents: new native.Contents(), isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), contentView: {
      addChildView(view: InstanceType<typeof native.View>) { views.push(view) },
      removeChildView(view: InstanceType<typeof native.View>) { const index = views.indexOf(view); if (index !== -1) views.splice(index, 1) }
    } }
  const manager = new BrowserViewManager(window as never,
    { defaultProfileId: () => 'default', resolvePartition: profile => 'persist:' + profile },
    new BrowserRefLedgerStore(directory), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
  managers.push(manager)
  const quiet = await manager.create('quiet', 'https://fixture.invalid/quiet', 'workspace', 'original')
  const quietContents = views[0]!.webContents
  const used = await manager.create('used', 'https://fixture.invalid/used', 'workspace', 'original')
  const usedContents = views[1]!.webContents
  usedContents.emit('input-event', {}, { type: 'mouseDown' })
  const uncertain = await manager.create('uncertain', 'https://fixture.invalid/uncertain', 'workspace', 'original')
  const uncertainContents = views[2]!.webContents
  uncertainContents.close.mockImplementation(() => {})
  await Promise.resolve(); await Promise.resolve()
  const create = vi.spyOn(manager, 'create'), ensure = vi.spyOn(manager, 'ensure'), restore = vi.spyOn(manager, 'restore')
  const targets = vi.spyOn(manager, 'targets'), resources = vi.spyOn(manager, 'resourceTargets'), program = vi.spyOn(manager, 'getOperation')
  const relay = vi.fn(async () => { throw new AgentMuxError('Unexpected Renderer relay for native release.', 'CONTROL_FAILED') })
  const contexts: unknown[] = [], requests: any[] = [], wire: any[] = []
  const release = manager.release.bind(manager)
  vi.spyOn(manager, 'release').mockImplementation(async (...args) => {
    contexts.push(structuredClone(nameChangeRequests.getStore())); return await release(...args)
  })

  const source = readFileSync(process.env.RELEASE_IPC_SOURCE!, 'utf8')
  const file = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.Latest, true)
  function expression(name: string, ports: Record<string, unknown>) {
    const found: ts.Expression[] = []
    function walk(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer) found.push(node.initializer)
      ts.forEachChild(node, walk)
    }
    walk(file); expect(found).toHaveLength(1)
    const code = ts.transpile('const run = ' + found[0]!.getText(file), { target: ts.ScriptTarget.ES2022 })
    return new Function(...Object.keys(ports), code + '; return run')(...Object.values(ports))
  }
  const executeControlOwner = expression('executeControlOwner', { browsers: manager, controlBridge: { execute: relay },
    projectBrowserControlResult: (value: unknown) => value })
  const executeControl = expression('executeControl', { nameChangeRequests, unknownNameContext, executeControlOwner })
  const publicContexts: any[] = []
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'rpc.sock'), execute: (request, context) => {
    requests.push(structuredClone(request)); publicContexts.push(structuredClone(context)); return executeControl(request, context)
  } })
  const dispatcher = (server as any).dispatcher, receive = dispatcher.receive.bind(dispatcher)
  vi.spyOn(dispatcher, 'receive').mockImplementation((request: any, context: any) => {
    if (request.method === 'browser.release') wire.push({ id: request.id, params: structuredClone(request.params) })
    return receive(request, context)
  })
  async function cli(label: string, args: string[]) {
    const child = spawn(process.execPath, ['--import', process.env.RESTORE_REGISTER!, process.env.RESTORE_CLI_ENTRY!, ...args], {
      cwd: process.env.AGENTMUX_COLD_PRIVATE_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 1024 * 1024) child.kill('SIGKILL') })
    child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 128 * 1024) child.kill('SIGKILL') })
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000)
    const exit = await new Promise<{ code: number | null; signal: string | null }>((yes, no) => {
      child.once('error', no); child.once('close', (code, signal) => yes({ code, signal }))
    }).finally(() => clearTimeout(timer))
    writeFileSync(join(process.env.RESTORE_EVIDENCE!, label + '.json'), JSON.stringify({ ...exit, stdout, stderr, pid: child.pid }))
    expect(exit.signal).toBeNull()
    const channel = (exit.code === 0 ? stdout : stderr).trim()
    return { ...exit, stdout, body: channel.startsWith('{') ? JSON.parse(channel) : null }
  }
  async function request(id: string, navigation: string, operationId: string) {
    return cli(operationId, ['--endpoint', 'unix://' + server.path, 'browser', 'release', '--browser', id,
      '--navigation', navigation, '--operation-id', operationId])
  }
  try {
    await server.start()
    const result = await request(quiet.id, quiet.navigationId, 'release-quiet')
    expect(result.code).toBe(0)
    expect(result.body.operationId).toBe('release-quiet')
    expect(result.body.result.receipt).toEqual({ browserId: quiet.id, navigationId: quiet.navigationId, status: 'released', reasons: [] })
    expect(quietContents.dead).toBe(true); expect(quietContents.close).toHaveBeenCalledTimes(1)
    expect((manager as any).releasedEntries.get(quiet.id)).toMatchObject({ id: quiet.id, workspaceId: 'workspace', storage: { profileId: quiet.profileId } })

    const retained = await request(used.id, used.navigationId, 'release-used')
    expect(retained.code).toBe(0); expect(retained.body.result.receipt).toMatchObject({ status: 'retained', reasons: expect.arrayContaining(['document-used']) })
    expect(usedContents.close).not.toHaveBeenCalled(); expect(usedContents.dead).toBe(false)
    const changed = await request(used.id, 'old-navigation', 'release-old-source')
    expect(changed.code).toBe(0); expect(changed.body.result.receipt).toMatchObject({ status: 'retained', reasons: ['source-changed'] })
    const unknown = await request(uncertain.id, uncertain.navigationId, 'release-uncertain')
    expect(unknown.code).toBe(0); expect(unknown.body.result.receipt).toMatchObject({ status: 'unknown', reasons: ['close-unconfirmed'] })
    expect(uncertainContents.close).toHaveBeenCalledTimes(1); expect(uncertainContents.dead).toBe(false)
    expect((manager as any).entries.get(uncertain.id).view.webContents).toBe(uncertainContents)
    expect(requests).toHaveLength(4); expect(contexts).toHaveLength(4)
    for (let index = 0; index < requests.length; index++) {
      expect(requests[index]).not.toHaveProperty('operationId')
      expect(contexts[index]).toEqual({ operationId: requests[index].requestId, context: publicContexts[index] })
      expect(publicContexts[index]).toMatchObject({ actor: { verified: true }, entryPoint: 'browser.release' })
      expect(wire[index].params.operationId).toBe(requests[index].requestId); expect(wire[index].id).not.toBe(requests[index].requestId)
    }
    const receipt = result.body.result.receipt
    expect(parseRpcControlResult('browser.release', { receipt }, { browserId: quiet.id, navigationId: quiet.navigationId })).toEqual({ receipt })
    for (const foreign of [{ ...receipt, browserId: 'other' }, { ...receipt, navigationId: 'other' }, { ...receipt, reasons: ['visible'] }]) {
      expect(() => parseRpcControlResult('browser.release', { receipt: foreign }, { browserId: quiet.id, navigationId: quiet.navigationId })).toThrow()
    }
    expect(create).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled()
    expect(targets).not.toHaveBeenCalled(); expect(resources).not.toHaveBeenCalled(); expect(program).not.toHaveBeenCalled(); expect(relay).not.toHaveBeenCalled()
    expect(usedContents.focus).not.toHaveBeenCalled(); expect(uncertainContents.focus).not.toHaveBeenCalled()
    const help = await cli('help', ['browser', 'release', '--help'])
    expect(help.code).toBe(0); expect(help.stdout).toContain('released, retained or unknown')
    const skill = await cli('skill', ['browser', '--skill'])
    expect(skill.code).toBe(0); expect(skill.stdout).toContain('browser release')
    writeFileSync(join(process.env.RESTORE_EVIDENCE!, 'consumer.json'), JSON.stringify({ passed: true, requests, wire, contexts,
      publicContexts, receipts: [result.body, retained.body, changed.body, unknown.body], native: false,
      scope: 'Actual public CLI/Unix/strict codecs and original Main function expressions with the production BrowserViewManager on controlled native ports.' }, null, 2))
  } finally { await server.stop() }
})
