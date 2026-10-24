import { afterEach, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { NativeConnection, NativeDesktop, type JsonObject } from '../../../packages/native-desktop/src/index.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { parseNativeDesktopParams, parseNativeDesktopResult } from '../../../packages/core/src/public-rpc-native-desktop.js'
import { createNativeDesktopPublicOwner } from '../src/main/native-desktop-public.js'
import { agentMuxCliModuleCatalog } from '../../../packages/core/src/agentmux-cli-module-skills.js'
import { AgentMuxError } from '../../../packages/core/src/errors.js'
const instanceId = 'native-instance-original'
const scope = { hostId: 'local', instanceId }
const target = { pid: 777, processStartedAt: 1234.5, windowId: 42 }
const pngData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
const captured = { state: 'captured', screenshot: { data: pngData, format: 'png', width: 1, height: 1, scale: 2 }, engine: 'protocol-fixture', selectionRect: { x: -10, y: 0, width: .5, height: .5 } }
const context = { principal: { kind: 'user' as const, id: 'fixture-person' }, transport: 'unix' as const }
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function nativeFixture(captureResults = new Map<string, unknown>()) {
  const directory = await mkdtemp(join(tmpdir(), 'amn-public-'))
  const socketPath = join(directory, 'native.sock'), calls: JsonObject[] = [], sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket))
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); calls.push(request)
        if (request.token !== 'private-token') { socket.destroy(); return }
        let result: unknown
        if (request.method === 'handshake') result = { provider: 'agentmux-native-macos', providerVersion: '1.0.0', protocolVersion: 1, platform: 'darwin', instanceId, supports: { apps: { list: true } } }
        else if (request.method === 'listApps') result = { apps: [{ name: 'Fixture', bundleId: null, pid: target.pid, processStartedAt: target.processStartedAt, isRunning: true, lastUsedAt: null, useCount: null }] }
        else if (request.method === 'clipboardRead') result = { state: 'read', format: request.params.format, data: ' \n原文\n ', changeCount: 7 }
        else if (request.method === 'clipboardWrite') result = { state: 'written', format: request.params.format, byteLength: Buffer.byteLength(request.params.data), changeCount: 8 }
        else if (request.method === 'captureScreenshot') result = captureResults.has(request.operationId) ? captureResults.get(request.operationId) : request.operationId === 'capture-png' ? captured : { state: 'cancelled' }
        else if (request.method === 'getAppState') result = { snapshotId: 'snapshot-original', snapshot: { id: 'snapshot-original', app: { name: 'Fixture', bundleId: null, pid: target.pid, processStartedAt: target.processStartedAt }, window: { id: target.windowId, title: 'Fixture window', x: 0, y: 0, width: 100, height: 80 }, coordinateSpace: 'window', treeText: 'label', elementCount: 1, elements: [{ index: 0, actions: ['AXPress'], frame: null }], focusedElementId: 0, truncation: { truncated: false, maxNodes: 1500, maxDepth: 20, maxDepthReached: false } }, screenshot: null, screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' } }
        else if (request.method === 'click' && request.operationId === 'lose-action') { socket.destroy(); return }
        else if (request.method === 'click') result = { action: { path: 'accessibility', actionName: 'AXPress', fallbackReason: null, targetWindowId: target.windowId, verification: { state: 'accepted' } }, observation: { state: 'failed', error: { code: 'window_gone', message: 'Original window disappeared after the accepted action' } } }
        else result = { unsupported: request.method }
        socket.write(JSON.stringify({ id: request.id, instanceId, ...(request.operationId ? { operationId: request.operationId } : {}), ok: true, result }) + '\n')
      }
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve)); await chmod(socketPath, 0o600)
  const connection = await NativeConnection.connect({ socketPath, token: 'private-token' })
  const port: Pick<NativeDesktop, 'request' | 'inspectOperation'> = {
    request: (method, params = {}, options) => connection.request(method, params, options),
    inspectOperation: (operationId, instance) => connection.inspectOperation(operationId) ?? { operationId, instanceId: instance, state: 'unknown', reason: 'original_receipt_unavailable' }
  }
  const owner = createNativeDesktopPublicOwner(port, { hostId: 'local' })
  const service = new AgentMuxRpcService({ coreClients: () => [], nativeDesktop: owner })
  cleanups.push(async () => { connection.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }) })
  return { connection, owner, service, calls, directory }
}

async function publicFixture(captureResults = new Map<string, unknown>()) {
  const h = await nativeFixture(captureResults)
  const endpoint = join(h.directory, 'public.sock'), server = new AgentMuxControlServer({ socketPath: endpoint, coreClients: () => [], nativeDesktop: h.owner })
  await server.start(); cleanups.push(() => server.stop())
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: endpoint } })
  cleanups.push(() => client.dispose())
  const cliEntry = process.env.NATIVE_PUBLIC_CLI
  expect(cliEntry, 'verification must build the actual CLI entry').toBeTruthy()
  async function cli(action: string[], input?: unknown) {
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
      const child = spawn(process.execPath, [cliEntry!, '--endpoint', `unix:${endpoint}`, 'native', ...action, ...(input === undefined ? [] : ['--data', '-'])], { env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''; child.stdout.on('data', part => { stdout += part }); child.stderr.on('data', part => { stderr += part })
      child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input === undefined ? '' : JSON.stringify(input))
    })
  }
  return { ...h, client, cli }
}

it('public service consumes the production Node protocol port and preserves exact clipboard text', async () => {
  const h = await nativeFixture()
  await expect(h.service.call('native.capabilities', { hostId: 'local' }, context)).resolves.toMatchObject({ instanceId })
  expect((await h.service.call('native.apps.list', scope, context)).result).toMatchObject({ apps: [{ pid: target.pid, processStartedAt: target.processStartedAt }] })
  expect((await h.service.call('native.clipboard.read', { ...scope, format: 'text' }, context)).result).toMatchObject({ data: ' \n原文\n ' })
  await h.service.call('native.clipboard.write', { ...scope, operationId: 'write-original', format: 'text', data: ' \n原文\n ' }, context)
  expect(h.calls.at(-1)).toMatchObject({ method: 'clipboardWrite', operationId: 'write-original', expectedInstanceId: instanceId, params: { data: ' \n原文\n ' } })
})

it('only transport-authenticated actors can reach the native owner', async () => {
  const h = await nativeFixture(), before = h.calls.length
  const owner = vi.spyOn(h.owner, 'call')
  await expect(h.service.call('native.apps.list', scope)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(owner).not.toHaveBeenCalled()
  await expect(h.service.call('native.apps.list', { ...scope, principal: context.principal } as never, context)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(h.calls).toHaveLength(before)
})

it('revocation during lazy native launch is checked at actual submission', async () => {
  const h = await nativeFixture(), desktop = new NativeDesktop({})
  let finish!: (connection: NativeConnection) => void, began!: () => void
  const started = new Promise<void>(resolve => { began = resolve })
  ;(desktop as unknown as { launch(): Promise<NativeConnection> }).launch = () => { began(); return new Promise(resolve => { finish = resolve }) }
  const service = new AgentMuxRpcService({ coreClients: () => [], nativeDesktop: createNativeDesktopPublicOwner(desktop, { hostId: 'local' }) })
  let revoked = false
  const request = service.call('native.action', { ...scope, target, operationId: 'revoked-action', snapshotId: 'snapshot-original', action: { kind: 'click', elementIndex: 0 } }, { ...context, assertCurrent() { if (revoked) throw new AgentMuxError('Original authority was revoked', 'CONTROL_PERMISSION_DENIED') } })
  const rejected = expect(request).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await started; revoked = true; finish(h.connection); await rejected
  expect(h.calls.filter(call => call.method === 'click')).toHaveLength(0)
  await desktop.dispose()
})

it('Host and old instance mismatches never send an action to a replacement target', async () => {
  const h = await nativeFixture(), before = h.calls.length
  await expect(h.service.call('native.apps.list', { ...scope, hostId: 'other-host' }, context)).rejects.toMatchObject({ code: 'NATIVE_HOST_MISMATCH' })
  const result = await h.service.call('native.action', { ...scope, instanceId: 'old-instance', operationId: 'old-action', target, snapshotId: 'snapshot-original', action: { kind: 'click', elementIndex: 0 } }, context)
  expect(result.error).toMatchObject({ code: 'instance_mismatch' })
  expect(h.calls).toHaveLength(before)
})

it('query defaults to AX-only and keeps machine action references', async () => {
  const h = await nativeFixture()
  const result = await h.service.call('native.snapshot', { ...scope, target }, context)
  expect(result.result).toMatchObject({ snapshotId: 'snapshot-original', snapshot: { elements: [{ index: 0, actions: ['AXPress'] }] } })
  expect(h.calls.at(-1)).toMatchObject({ method: 'getAppState', params: { app: 'pid:777', processStartedAt: 1234.5, windowId: 42, noScreenshot: true, clientScope: 'user:fixture-person' } })
})

it('accurate result codec rejects a foreign process despite identical display labels', () => {
  const input = { ...scope, target: { pid: 777, processStartedAt: 1234.5 } }
  const app = { name: 'same label', bundleId: null, pid: 888, processStartedAt: 1234.5 }
  expect(() => parseNativeDesktopResult('native.windows.list', { ...scope, state: 'responded', result: { app, windows: [] } }, input)).toThrow(/another OS process/)
  expect(() => parseNativeDesktopResult('native.capture', { ...scope, state: 'responded', operationId: 'original', error: { code: 'denied', message: 'Denied' }, operation: { operationId: 'foreign', instanceId: scope.instanceId } }, { ...scope, operationId: 'original', mode: 'selection' })).toThrow(/another operation/)
})

it('typed action codec rejects arbitrary execution and ambiguous targets', () => {
  const base = { ...scope, target, snapshotId: 'original', operationId: 'op' }
  expect(() => parseNativeDesktopParams('native.action', { ...base, action: { kind: 'eval', script: 'doAnything()' } })).toThrow()
  expect(() => parseNativeDesktopParams('native.action', { ...base, action: { kind: 'click', elementIndex: 0, x: 1, y: 1 } })).toThrow()
  expect(() => parseNativeDesktopParams('native.snapshot', { ...scope, target, restoreWindow: true })).toThrow()
  expect(() => parseNativeDesktopParams('native.snapshot', { ...scope, target, noScreenshot: false })).toThrow()
  expect(() => parseNativeDesktopParams('native.clipboard.write', { ...scope, operationId: 'png-op', format: 'png', data: '!!!' })).toThrow()
  expect(() => parseNativeDesktopResult('native.clipboard.read', { ...scope, state: 'responded', result: { format: 'png', state: 'read', data: '!!!', changeCount: 1 } }, { ...scope, format: 'png' })).toThrow()
})

it('a rejected duplicate cannot claim or disclose an earlier GUI receipt', async () => {
  const h = await nativeFixture()
  await h.connection.request('clipboardWrite', { format: 'text', data: 'private GUI text' }, { operationId: 'gui-original' })
  const duplicate = await h.service.call('native.clipboard.write', { ...scope, operationId: 'gui-original', format: 'text', data: 'other text' }, context)
  expect(duplicate.error?.code).toBe('duplicate_operation')
  expect(duplicate.operation).toBeUndefined()
  expect((await h.service.call('native.operation.inspect', { ...scope, operationId: 'gui-original' }, context)).result).toEqual({ operationId: 'gui-original', instanceId, state: 'unknown', reason: 'original_receipt_unavailable' })
})

it('a captured PNG follows the real native response shape through the public codec', async () => {
  const h = await nativeFixture()
  const result = await h.service.call('native.capture', { ...scope, operationId: 'capture-png', capture: { mode: 'selection' } }, context)
  expect(result.result).toEqual(captured)
})

it.each([
  ['provenance', [undefined, '', null, 42].map(engine => ({ ...captured, engine }))],
  ['geometry', [
    undefined, null, {}, { x: -10, y: 0, width: 0, height: .5 }, { x: -10, y: 0, width: .5, height: -1 },
    { x: null, y: 0, width: .5, height: .5 }, { x: -10, y: '0', width: .5, height: .5 },
    { x: -10, y: 0, width: .5, height: .5, displayId: 99 }
  ].map(selectionRect => ({ ...captured, selectionRect }))]
] as Array<[string, unknown[]]>)('public capture %s rejects malformed native replies without losing the original operation', async (kind, replies) => {
  const captureResults = new Map<string, unknown>(), h = await publicFixture(captureResults)
  for (const [index, reply] of replies.entries()) {
    for (const consumer of ['service', 'client'] as const) {
      const operationId = `invalid-${kind}-${index}-${consumer}`
      captureResults.set(operationId, reply)
      const input = { ...scope, operationId, capture: { mode: 'selection' as const } }
      const request = consumer === 'service' ? h.service.call('native.capture', input, context) : h.client.call('native.capture', input)
      await expect(request).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
      expect(h.connection.inspectOperation(operationId)).toMatchObject({ instanceId, operationId, state: 'completed' })
      const inspected = consumer === 'service' ? await h.service.call('native.operation.inspect', { ...scope, operationId }, context) : await h.client.call('native.operation.inspect', { ...scope, operationId })
      expect(inspected.result).toMatchObject({ instanceId, operationId, state: 'completed' })
      expect(h.calls.filter(call => call.operationId === operationId)).toHaveLength(1)
    }
  }
  const operationId = `invalid-${kind}-cli`
  captureResults.set(operationId, replies[0])
  const rejected = await h.cli(['capture'], { ...scope, operationId, capture: { mode: 'selection' } })
  expect(rejected.code).toBe(1)
  expect(JSON.parse(rejected.stderr).error).toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  const inspect = await h.cli(['operation', 'inspect'], { ...scope, operationId })
  expect(inspect.code, inspect.stderr).toBe(0)
  expect(JSON.parse(inspect.stdout).result.result).toMatchObject({ instanceId, operationId, state: 'completed' })
  expect(h.calls.filter(call => call.operationId === operationId)).toHaveLength(1)
  expect((await h.client.call('native.clipboard.read', { ...scope, format: 'text' })).result).toMatchObject({ data: ' \n原文\n ' })
})

it('actual public client and CLI preserve valid capture pixels, provenance and geometry', async () => {
  const captureResults = new Map([['client-captured', captured], ['cli-captured', captured]]), h = await publicFixture(captureResults)
  const result = await h.client.call('native.capture', { ...scope, operationId: 'client-captured', capture: { mode: 'selection' } })
  expect(result).toEqual({ ...scope, operationId: 'client-captured', state: 'responded', result: captured })
  const cli = await h.cli(['capture'], { ...scope, operationId: 'cli-captured', capture: { mode: 'selection' } })
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result).toEqual({ ...scope, operationId: 'cli-captured', state: 'responded', result: captured })
  for (const operationId of ['client-captured', 'cli-captured']) {
    expect(h.calls.filter(call => call.operationId === operationId)).toEqual([expect.objectContaining({ method: 'captureScreenshot', expectedInstanceId: instanceId, params: { mode: 'selection' } })])
  }
})

it('competing actors cannot replace the first admitted operation binding', async () => {
  const h = await nativeFixture()
  const input = { ...scope, operationId: 'competing-write', format: 'text' as const, data: 'first body' }
  const a = h.service.call('native.clipboard.write', input, context)
  const b = h.service.call('native.clipboard.write', input, { ...context, principal: { kind: 'user', id: 'second-person' } })
  const first = await a
  expect(first.state).toBe('responded')
  expect((await b).error?.code).toBe('duplicate_operation')
  expect((await h.service.call('native.operation.inspect', { ...scope, operationId: input.operationId }, context)).result).toMatchObject({ state: 'completed', operationId: input.operationId })
  await expect(h.service.call('native.operation.inspect', { ...scope, operationId: input.operationId }, { ...context, principal: { kind: 'user', id: 'second-person' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
})

it('unknown mutation retains original operation and actor, and inspection sends no new request', async () => {
  const h = await nativeFixture()
  const reply = await h.service.call('native.action', { ...scope, operationId: 'lose-action', target, snapshotId: 'snapshot-original', action: { kind: 'click', elementIndex: 0 } }, context)
  expect(reply).toMatchObject({ state: 'unknown', operationId: 'lose-action', instanceId, error: { code: 'operation_unknown' }, operation: { requestId: 2, state: 'unknown' } })
  const before = h.calls.length
  expect((await h.service.call('native.operation.inspect', { ...scope, operationId: 'lose-action' }, context)).result).toMatchObject({ state: 'unknown', operationId: 'lose-action', instanceId })
  await expect(h.service.call('native.operation.inspect', { ...scope, operationId: 'lose-action' }, { ...context, principal: { kind: 'user', id: 'another-person' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(h.calls).toHaveLength(before)
})

it('actual CLI and public Unix server consume the same native owner and discovery', async () => {
  const h = await publicFixture(), cli = h.cli
  const help = await cli(['--help']); expect(help.code).toBe(0); expect(help.stdout).toContain('operation')
  expect(agentMuxCliModuleCatalog().find(module => module.root === 'native')?.readCommand).toBe('amux native --skill')
  const apps = await cli(['apps', 'list'], scope)
  expect(apps.code, apps.stderr).toBe(0); expect(JSON.parse(apps.stdout).result).toMatchObject({ instanceId, result: { apps: [{ pid: target.pid }] } })
  const capture = await cli(['capture'], { ...scope, operationId: 'cli-capture', capture: { mode: 'selection' } })
  expect(capture.code, capture.stderr).toBe(0); expect(JSON.parse(capture.stdout).result.result.state).toBe('cancelled')
  expect(h.calls.at(-1)).toMatchObject({ method: 'captureScreenshot', operationId: 'cli-capture', expectedInstanceId: instanceId })
  const lost = await cli(['action'], { ...scope, operationId: 'lose-action', target, snapshotId: 'snapshot-original', action: { kind: 'click', elementIndex: 0 } })
  expect(lost.code, lost.stderr).toBe(1)
  expect(JSON.parse(lost.stdout).result).toMatchObject({ state: 'unknown', operationId: 'lose-action', instanceId })
  const before = h.calls.length
  const inspect = await cli(['operation', 'inspect'], { ...scope, operationId: 'lose-action' })
  expect(inspect.code, inspect.stderr).toBe(1)
  expect(JSON.parse(inspect.stdout).result.result).toMatchObject({ operationId: 'lose-action', instanceId, state: 'unknown' })
  expect(h.calls).toHaveLength(before)
})
