import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseDesktopFocusSuccessReceipt } from '../src/desktop-focus-parser.js'
import { focusFacts } from './fixtures/desktop-focus-facts.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { parseAppWindowPage, parseAppWindowParams, type AgentMuxRpcWindowsOwner,
  type AppWindowDescriptor, type AppWindowOperation, type AppWindowPage, type AppWindowTarget } from '../src/public-rpc-windows.js'

const target: AppWindowTarget = { kind: 'region', displayWorkspaceId: 'original-display', groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }
const actor = { kind: 'user', id: 'original-user' } as const
const input = { operationId: 'open-original', target }
const original: AppWindowDescriptor = { windowId: 'original-window', documentGeneration: 'original-document', target,
  presentation: 'visible', bounds: { x: -800, y: 30, width: 720, height: 600 }, focused: false }
const operation: AppWindowOperation = { method: 'app.window.open', input, actor, state: 'confirmed', windowId: original.windowId,
  documentGeneration: original.documentGeneration, message: null }
const page = (): AppWindowPage => ({ windows: [structuredClone(original)], recordedOperation: structuredClone(operation) })
let directory: string, cli: string
const servers: AgentMuxControlServer[] = []
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'amx-window-public-')); cli = join(directory, 'amux.mjs')
  await symlink(resolve('packages/core/node_modules'), join(directory, 'node_modules'), 'dir')
  await build({ entryPoints: ['packages/core/src/agentmux.ts'], outfile: cli, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    banner: { js: "import {createRequire as windowRequire} from 'node:module'; const require=windowRequire(import.meta.url);" }, logLevel: 'silent' })
})
afterAll(async () => { for (const server of servers) await server.stop(); if (directory) await rm(directory, { recursive: true, force: true }) })
async function run(args: string[], endpoint: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTMUX_RPC_ENDPOINT: endpoint }
  for (const key of ['AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY', 'AGENTMUX_CLI_CALLER']) delete env[key as keyof typeof env]
  return await new Promise<{ code: number; stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    child.on('error', reject); child.on('close', code => accept({ code: code ?? -1, stdout, stderr }))
  })
}
describe('original client window public capabilities', () => {
  it('requires exact occurrences and opaque native generations without display or cwd guesses', () => {
    expect(parseAppWindowParams('app.window.open', input)).toEqual(input)
    for (const bad of [{ ...input, cwd: 'display hint' }, { ...input, target: { ...target, regionId: 'self' } },
      { ...input, target: { ...target, kind: 'tab' } }, { ...input, target: { ...target, groupId: '' } }]) {
      expect(() => parseAppWindowParams('app.window.open', bad)).toThrow()
    }
    expect(() => parseAppWindowParams('app.window.return', { operationId: 'return-original', windowId: original.windowId, documentGeneration: 1 })).toThrow()
    expect(parseAppWindowParams('app.window.focus', { operationId: 'focus-original', windowId: original.windowId, documentGeneration: 'original-document' })).toMatchObject({ documentGeneration: 'original-document' })
  })
  it('retains explicit background presentation intent and rejects a changed focus receipt', () => {
    const background = { ...input, focus: false }
    expect(parseAppWindowParams('app.window.open', background)).toEqual(background)
    for (const focus of ['false', 0, null]) expect(() => parseAppWindowParams('app.window.open', { ...input, focus })).toThrow()
    const result = page(); result.recordedOperation = { ...operation, input: background }
    expect(parseAppWindowPage('app.window.open', result, background)).toEqual(result)
    result.recordedOperation = { ...operation, input: { ...input, focus: true } }
    expect(() => parseAppWindowPage('app.window.open', result, background)).toThrow('intent')
  })
  it('rejects changed original intent, duplicate ownership and mismatched native document results', () => {
    expect(parseRpcNativeResult('app.window.open', page(), input)).toEqual(page())
    const changed = page(); changed.windows = []; changed.recordedOperation = { ...operation, input: { ...input, target: { ...target, tabId: 'another-tab' } } }
    expect(() => parseRpcNativeResult('app.window.open', changed, input)).toThrow()
    const swapped = page(); swapped.windows[0]!.target = { ...target, regionId: 'another-region' }
    expect(() => parseRpcNativeResult('app.window.open', swapped, input)).toThrow()
    const duplicate = page(); duplicate.windows.push({ ...original, windowId: 'duplicate-window' })
    expect(() => parseRpcNativeResult('app.window.open', duplicate, input)).toThrow()
    const renamed = { operationId: 'return-original', windowId: original.windowId, documentGeneration: 'original-document' }
    expect(() => parseAppWindowPage('app.window.return', { windows: [], recordedOperation: { ...operation,
      method: 'app.window.return', input: renamed, documentGeneration: 'another-document' } }, renamed)).toThrow()
  })
  it('retains unknown observations and historical acknowledgements independently of current windows', () => {
    const pending = page(); pending.windows = [{ ...original, presentation: 'unknown', documentGeneration: null, bounds: null, focused: null }]
    pending.recordedOperation = { ...operation, state: 'unknown', windowId: null, documentGeneration: null, message: 'Original host transfer acknowledgement is unavailable.' }
    expect(parseAppWindowPage('app.window.open', pending, input)).toEqual(pending)
    const historical = page(); historical.windows = [{ ...original, documentGeneration: 'reopened-document', target: { ...target, regionId: 'later-region' } }]
    expect(parseAppWindowPage('app.window.ls', historical, { operationId: input.operationId }).recordedOperation).toEqual(operation)
    expect(parseAppWindowPage('app.window.ls', { windows: [], recordedOperation: operation }, { operationId: input.operationId })).toMatchObject({ windows: [], recordedOperation: operation })
    expect(() => parseAppWindowPage('app.window.ls', page(), {})).toThrow()
    expect(() => parseAppWindowPage('app.window.open', { windows: [original], recordedOperation: null }, input)).toThrow()
  })
  it('keeps missing client support truthful without connecting or changing any Runtime', async () => {
    const service = new AgentMuxRpcService({ coreClients: () => { throw new Error('No Runtime discovery belongs to this presentation read.') } })
    await expect(service.call('app.window.ls', {}, { principal: actor })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    await expect(service.call('app.window.open', input, { principal: actor })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    await service.dispose()
  })
  it('uses the transport actor and refuses a foreign acknowledgement at the original service boundary', async () => {
    const calls: unknown[] = []
    const owner: AgentMuxRpcWindowsOwner = { async call(method, value, context) {
      calls.push({ method, value, actor: context.actor }); return page()
    } }
    const service = new AgentMuxRpcService({ windows: owner, coreClients: () => [] })
    await expect(service.call('app.window.open', input, { principal: actor })).resolves.toEqual(page())
    expect(calls).toEqual([{ method: 'app.window.open', value: input, actor }])
    await expect(service.call('app.window.open', input, { principal: { ...actor, id: 'another-user' } })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    await expect(service.call('app.window.open', input)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(calls).toHaveLength(2)
    const controller = new AbortController(); controller.abort()
    await expect(service.call('app.window.open', input, { principal: actor, signal: controller.signal })).rejects.toThrow()
    expect(calls).toHaveLength(2); expect(input.operationId).toBe('open-original')
  })
  it('forwards the exact original method and request to an existing client route', async () => {
    const calls: unknown[] = []
    const service = new AgentMuxRpcService({ coreClients: () => [], forwardControl: async (method, value) => {
      calls.push({ method, value }); return page() as never
    } })
    expect(await service.call('app.window.open', input, { principal: actor })).toEqual(page())
    expect(calls).toEqual([{ method: 'app.window.open', value: input }])
  })
  it('preserves authenticated intent and actor across the original forwarded client route', async () => {
    const calls: unknown[] = []
    const service = new AgentMuxRpcService({ coreClients: () => [], forwardControl: async (method, value, context) => {
      calls.push({ method, value, principal: context.principal }); return page() as never
    } })
    await expect(service.call('app.window.open', input)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(calls).toHaveLength(0)
    await expect(service.call('app.window.open', input, { principal: { ...actor, id: 'another-user' } })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    expect(calls).toEqual([{ method: 'app.window.open', value: input, principal: { ...actor, id: 'another-user' } }])
    await service.dispose()
  })
  it('runs typed socket calls and shipping CLI through the same borrowed owner without native-window claims', async () => {
    const calls: Array<{ method: string; input: unknown; actor: unknown }> = []
    let recorded: AppWindowOperation | null = null
    const owner: AgentMuxRpcWindowsOwner = { async call(method, value, context) {
      calls.push({ method, input: value, actor: context.actor })
      if (method !== 'app.window.ls') recorded = { ...operation, method, input: value, actor: context.actor } as AppWindowOperation
      return { windows: [original], recordedOperation: value.operationId ? recorded : null }
    } }
    const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), windows: owner, coreClients: () => [] }); servers.push(server); await server.start()
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }), endpoint = 'unix:' + server.path
    try {
      const opened = await client.call('app.window.open', input); expect(opened.recordedOperation?.input).toEqual(input)
      const listed = await run(['app', 'window', 'ls', '--operation-id', input.operationId], endpoint)
      expect(listed.code, listed.stderr + listed.stdout).toBe(0); expect(JSON.parse(listed.stdout).result.recordedOperation.input).toEqual(input)
      for (const action of ['focus', 'return']) {
        const result = await run(['app', 'window', action, '--window', original.windowId, '--document-generation', 'original-document', '--operation-id', action + '-original'], endpoint)
        expect(result.code, result.stderr + result.stdout).toBe(0); expect(JSON.parse(result.stdout).result.recordedOperation).toMatchObject({ method: 'app.window.' + action,
          input: { operationId: action + '-original', windowId: original.windowId, documentGeneration: 'original-document' } })
      }
      const openedCli = await run(['app', 'window', 'open', '--kind', 'region', '--display-workspace', target.displayWorkspaceId, '--group', target.groupId,
        '--tab', target.tabId, '--region', 'original-region', '--background', '--operation-id', 'open-cli'], endpoint)
      expect(openedCli.code, openedCli.stderr + openedCli.stdout).toBe(0)
      expect(calls.map(call => call.method)).toEqual(['app.window.open', 'app.window.ls', 'app.window.focus', 'app.window.return', 'app.window.open'])
      expect(calls.every(call => (call.actor as typeof actor).kind === 'user' && !!(call.actor as typeof actor).id)).toBe(true)
      expect(calls.at(-1)?.input).toEqual({ operationId: 'open-cli', target, focus: false })
      const count = calls.length, invalid = await run(['app', 'window', 'return', '--window', original.windowId, '--document-generation', 'self'], endpoint)
      expect(invalid.code).not.toBe(0); expect(calls).toHaveLength(count)
    } finally { await client.dispose() }
  })
})

function focusedWindow(policy: 'preserve' | 'target' = 'target') {
  const { operation, ...result } = focusFacts({ schemaVersion: 5, requestId: 'original-window-focus', operation: 'focus',
    target: { kind: 'space', tabId: target.tabId, regionId: 'original-region' }, inputPolicy: policy })
  const selection = result.navigation.selection.space!
  const observed = { provenance: 'observed' as const, scope: 'window' as const, windowId: original.windowId,
    documentGeneration: 'original-document', ownerKind: 'composer' as const, tabId: selection.tabId, regionId: selection.regionId,
    sessionId: 'original-session', connected: true, visible: true, inert: false }
  return { schemaVersion: 5, requestId: 'original-window-focus', ok: true, operation,
    result: { ...result, partial: false, issues: [], presentation: { ...result.presentation, provenance: 'observed',
      state: 'window', windowId: original.windowId, documentGeneration: 'original-document' },
      input: { policy, outcome: policy === 'preserve' ? 'preserved' : 'transferred', before: observed, after: observed } } }
}
describe('original desktop document facts', () => {
  it('accepts confirmed original window focus without guessing main-window presentation', () => {
    const receipt = focusedWindow()
    expect(parseDesktopFocusSuccessReceipt(receipt)).toEqual(receipt)
    for (const slot of ['presentation', 'after'] as const) {
      const value = structuredClone(receipt), facts = slot === 'presentation' ? value.result.presentation : value.result.input.after
      delete (facts as { documentGeneration?: string }).documentGeneration
      expect(() => parseDesktopFocusSuccessReceipt(value)).toThrow('must be paired')
    }
    const noPair = structuredClone(receipt)
    delete (noPair.result.presentation as { windowId?: string }).windowId
    delete (noPair.result.presentation as { documentGeneration?: string }).documentGeneration
    expect(() => parseDesktopFocusSuccessReceipt(noPair)).toThrow('must be paired')
  })
  it('rejects a transferred caret in another native window or document', () => {
    for (const key of ['windowId', 'documentGeneration'] as const) {
      const receipt = focusedWindow(); receipt.result.input.after = { ...receipt.result.input.after, [key]: 'another-native-host' }
      expect(() => parseDesktopFocusSuccessReceipt(receipt)).toThrow('confirmation is inconsistent')
    }
  })
  it('requires a transferred caret to match an explicitly observed main document too', () => {
    const receipt = focusedWindow()
    receipt.result.presentation.state = 'main-visible'
    const input = receipt.result.input as { before: { scope: string }; after: { scope: string } }
    input.before.scope = 'main'; input.after.scope = 'main'
    expect(parseDesktopFocusSuccessReceipt(receipt)).toEqual(receipt)
    for (const key of ['windowId', 'documentGeneration'] as const) {
      const forged = structuredClone(receipt); forged.result.input.after[key] = 'another-native-owner'
      expect(() => parseDesktopFocusSuccessReceipt(forged)).toThrow('confirmation is inconsistent')
    }
  })
  it('does not certify preserved input after the native document identity changes', () => {
    const receipt = focusedWindow('preserve')
    expect(parseDesktopFocusSuccessReceipt(receipt)).toEqual(receipt)
    receipt.result.input.after = { ...receipt.result.input.after, documentGeneration: 'another-native-document' }
    expect(() => parseDesktopFocusSuccessReceipt(receipt)).toThrow('confirmation is inconsistent')
  })
})
