import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseToolkitCommand } from '../src/toolkit-cli.js'
import { AgentMuxControlServer, parseAgentMuxControlReceipt, parseAgentMuxControlRequest, requestAgentMuxControl } from '../src/control-host.js'
import { subscribeAgentMuxToolkit } from '../src/toolkit-control.js'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, AGENTMUX_CONTROL_SCHEMA_VERSION, agentMuxControlTimeoutMs } from '../src/control.js'
import { parseToolkitResult, parseToolkitSnapshot, parseToolkitToolFields,
  type AgentMuxToolkitPort, type ToolkitScriptSnapshot, type ToolkitToolDefinition } from '../src/toolkit.js'

const definition: ToolkitToolDefinition = { id: 'summary', revision: 'revision-one', name: 'Summary', icon: 'terminal',
  enabled: true, statusBar: 'icon', workspacePath: '/project', script: "console.log('ready')", args: [] }
const { id: _id, revision: _revision, ...fields } = definition
const input = { invocationId: 'explicit-invocation', expectedRevision: definition.revision, expectedLatestExecutionId: null }
const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'custom-owning' } as const
const snapshot = (): ToolkitScriptSnapshot => ({ schema: 'agentmux.toolkit.v1', kind: 'script', toolId: definition.id,
  definition, state: 'idle', reason: null, admission: null, latestConfirmed: null, consumerCount: 0, sequence: 0 })
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks() })
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'toolkit-custom-core-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir
}

describe('custom Toolkit public data and authored CLI', () => {
  it('admits only fixed fields, complete invocation scope and durable operation budgets', () => {
    const request = parseAgentMuxControlRequest({ ...base, operation: 'toolkit.add', toolId: definition.id, value: fields })
    expect(request).toEqual({ ...base, operation: 'toolkit.add', toolId: definition.id, value: fields })
    expect(parseAgentMuxControlRequest({ ...base, operation: 'toolkit.run', toolId: definition.id, input })).toEqual({ ...base, operation: 'toolkit.run', toolId: definition.id, input })
    expect(() => parseAgentMuxControlRequest({ ...base, operation: 'toolkit.run', toolId: definition.id })).toThrow()
    expect(() => parseAgentMuxControlRequest({ ...base, operation: 'toolkit.run', toolId: 'performance', input })).toThrow()
    expect(() => parseAgentMuxControlRequest({ ...base, operation: 'toolkit.update', toolId: definition.id, changes: { name: 'new' }, expected: {} })).toThrow()
    expect(() => parseAgentMuxControlRequest({ ...base, operation: 'toolkit.add', toolId: definition.id, value: { ...fields, revision: 'authored' } })).toThrow()
    expect(() => parseAgentMuxControlRequest({ ...base, operation: 'toolkit.add', toolId: definition.id, value: { ...fields, path: 'arbitrary' } })).toThrow()
    expect(agentMuxControlTimeoutMs('toolkit.add')).toBe(agentMuxControlTimeoutMs('settings.resource.add'))
    expect(agentMuxControlTimeoutMs('toolkit.update')).toBe(agentMuxControlTimeoutMs('settings.resource.update'))
    expect(agentMuxControlTimeoutMs('toolkit.remove')).toBe(agentMuxControlTimeoutMs('settings.resource.remove'))
    expect(agentMuxControlTimeoutMs('toolkit.get')).toBeLessThan(agentMuxControlTimeoutMs('toolkit.add'))
  })
  it('bounds the combined authored definition, not only each individually legal argument', () => {
    expect(parseToolkitToolFields(fields)).toEqual(fields)
    expect(() => parseToolkitToolFields({ ...fields, args: Array.from({ length: 32 }, () => 'a'.repeat(4096)) })).toThrow()
    expect(() => parseToolkitToolFields({ ...fields, script: 'a'.repeat(32769) })).toThrow()
    expect(() => parseToolkitToolFields({ ...fields, args: ['bad\0argument'] })).toThrow()
    expect(() => parseToolkitToolFields({ ...fields, name: '\u0001'.repeat(256) })).toThrow()
    expect(() => parseToolkitToolFields({ ...fields, icon: '\u0001'.repeat(64) })).toThrow()
    const accessor = Object.defineProperty({ ...fields }, 'script', { enumerable: true, get: () => { throw new Error('must not invoke getters') } })
    expect(() => parseToolkitToolFields(accessor)).toThrowError('Settings resource JSON is invalid or exceeds its budget.')
  })
  it('rejects accessors before any public header read and rejects cyclic data graphs', () => {
    for (const key of ['schemaVersion', 'requestId']) {
      const getter = vi.fn(() => key === 'schemaVersion' ? base.schemaVersion : base.requestId)
      const request = Object.defineProperty({ ...base, operation: 'toolkit.get', toolId: definition.id }, key, { enumerable: true, get: getter })
      expect(() => parseAgentMuxControlRequest(request)).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
      expect(getter).not.toHaveBeenCalled()
    }
    for (const key of ['schemaVersion', 'requestId', 'ok']) {
      const getter = vi.fn(() => key === 'ok' ? true : key === 'schemaVersion' ? base.schemaVersion : base.requestId)
      const reply = Object.defineProperty({ ...base, operation: 'toolkit.get', ok: true, result: { snapshot: snapshot() } }, key, { enumerable: true, get: getter })
      expect(() => parseAgentMuxControlReceipt(reply)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
      expect(getter).not.toHaveBeenCalled()
    }
    const cyclic: Record<string, unknown> = { ...fields }; cyclic.self = cyclic
    expect(() => parseAgentMuxControlRequest({ ...base, operation: 'toolkit.add', toolId: definition.id, value: cyclic })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
  })
  it('roundtrips all 128 maximum-encoded descriptors through a real Control socket', async () => {
    const maximum = { ...fields, name: '\u0001'.repeat(127), icon: '\u0001'.repeat(31) }
    expect(parseToolkitToolFields(maximum)).toEqual(maximum)
    const tools = [{ kind: 'metrics' as const, toolId: 'performance' as const, name: 'Performance', readonly: true as const },
      ...Array.from({ length: 128 }, (_, index) => ({ kind: 'script' as const, readonly: false as const,
        toolId: '\\'.repeat(124) + index, revision: '\\'.repeat(128), name: maximum.name, icon: maximum.icon, enabled: true, statusBar: 'label' as const }))]
    const frame = { ...base, operation: 'toolkit.list', ok: true, result: { tools } }
    expect(Buffer.byteLength(JSON.stringify(frame) + '\n')).toBeLessThan(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES)
    const path = join(await directory(), 'list.sock')
    const port: AgentMuxToolkitPort = { execute: async () => ({ operation: 'toolkit.list', tools }), subscribe: vi.fn() }
    const server = new AgentMuxControlServer({ execute: vi.fn(), toolkit: port }, path)
    await server.start(); cleanup.push(() => server.stop())
    const receipt = await requestAgentMuxControl({ ...base, operation: 'toolkit.list' }, path)
    expect(receipt).toEqual(frame)
    expect(tools).toHaveLength(129)
  })
  it('keeps metric and script identities distinct, forbids empty or duplicate tool lists', () => {
    const tools = [{ kind: 'metrics', toolId: 'performance', name: 'Performance', readonly: true },
      { kind: 'script', toolId: definition.id, name: definition.name, readonly: false, revision: definition.revision, icon: definition.icon, enabled: true, statusBar: 'icon' }]
    expect(parseToolkitResult('toolkit.list', { tools })).toEqual({ operation: 'toolkit.list', tools })
    expect(() => parseToolkitResult('toolkit.list', { tools: [] })).toThrow()
    expect(() => parseToolkitResult('toolkit.list', { tools: [tools[0], tools[1], tools[1]] })).toThrow()
    expect(() => parseToolkitResult('toolkit.list', { tools: [tools[1]] })).toThrow()
    expect(parseToolkitSnapshot(snapshot())).toEqual(snapshot())
    expect(() => parseToolkitSnapshot({ ...snapshot(), toolId: 'another' })).toThrow()
    expect(() => parseToolkitSnapshot({ ...snapshot(), kind: 'metrics' })).toThrow()
    expect(() => parseToolkitSnapshot({ ...snapshot(), definition: { ...definition, id: 'performance' }, toolId: 'performance' })).toThrow()
  })
  it('only accepts owner-confirmed success and bounded text attached to the captured target', () => {
    const result = { executionId: 'execution-one', invocationId: input.invocationId, definition, expectedLatestExecutionId: null,
      target: { workspacePath: definition.workspacePath }, run: { hostId: 'local', runId: 'run-one' }, startedAt: 10,
      state: 'succeeded', reason: null, endedAt: 12, exitCode: 0, text: '' }
    const parsed = parseToolkitSnapshot({ ...snapshot(), state: 'succeeded', latestConfirmed: result })
    expect(parsed.kind).toBe('script')
    if (parsed.kind !== 'script') throw new Error('Expected the real script result discriminator.')
    expect(parsed.latestConfirmed).toEqual(result)
    expect(() => parseToolkitSnapshot({ ...snapshot(), state: 'succeeded', latestConfirmed: { ...result, run: null } })).toThrow()
    expect(() => parseToolkitSnapshot({ ...snapshot(), state: 'succeeded', latestConfirmed: { ...result, exitCode: 1 } })).toThrow()
    expect(() => parseToolkitSnapshot({ ...snapshot(), state: 'succeeded', latestConfirmed: { ...result, target: { workspacePath: '/changed' } } })).toThrow()
    expect(() => parseToolkitSnapshot({ ...snapshot(), state: 'succeeded', latestConfirmed: { ...result, text: 'a'.repeat(32769) } })).toThrow()
    expect(() => parseToolkitSnapshot({ ...snapshot(), state: 'succeeded', latestConfirmed: { ...result, text: '\0'.repeat(12000) } })).toThrow()
  })
  it('uses one JSON resource syntax with explicit creation defaults and preserves captured inputs', async () => {
    const dir = await directory(), file = join(dir, 'input.json')
    await writeFile(file, JSON.stringify({ name: definition.name, icon: definition.icon, workspacePath: definition.workspacePath, script: definition.script }))
    expect(await parseToolkitCommand(['add', definition.id, '--input', file])).toEqual({ operation: 'toolkit.add', toolId: definition.id, value: fields })
    await writeFile(file, JSON.stringify({ changes: { name: 'New summary' }, expected: { name: definition.name } }))
    expect(await parseToolkitCommand(['update', definition.id, '--input', file])).toEqual({ operation: 'toolkit.update', toolId: definition.id, changes: { name: 'New summary' }, expected: { name: definition.name } })
    await writeFile(file, JSON.stringify(input))
    expect(await parseToolkitCommand(['run', definition.id, '--input', file])).toEqual({ operation: 'toolkit.run', toolId: definition.id, input })
    expect(await parseToolkitCommand(['watch', definition.id])).toEqual({ operation: 'toolkit.watch', toolId: definition.id })
    expect(await parseToolkitCommand(['list'])).toEqual({ operation: 'toolkit.list' })
    await writeFile(file, JSON.stringify({ ...fields, id: 'another' }))
    await expect(parseToolkitCommand(['add', definition.id, '--input', file])).rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
    const malformed = Buffer.from(JSON.stringify({ ...fields, name: '#' }))
    const marker = malformed.indexOf(35)
    expect(marker).toBeGreaterThan(0)
    malformed[marker] = 255
    await writeFile(file, malformed)
    const decoded = await parseToolkitCommand(['add', definition.id, '--input', file]).then(
      value => ({ ok: true, value }), error => ({ ok: false, code: error.code }))
    expect(decoded).toEqual({ ok: false, code: 'INVALID_CLI_ARGUMENT' })
  })
  it('reads and watches a custom tool through real Control sockets without executing it', async () => {
    const path = join(await directory(), 'control.sock'), execute = vi.fn(async () => ({ operation: 'toolkit.get' as const, snapshot: snapshot() }))
    const release = vi.fn()
    const port: AgentMuxToolkitPort = { execute, subscribe: async (toolId, publish) => { expect(toolId).toBe(definition.id); publish(snapshot()); return { dispose: release } } }
    const server = new AgentMuxControlServer({ execute: vi.fn(), toolkit: port }, path)
    await server.start(); cleanup.push(() => server.stop())
    const receipt = await requestAgentMuxControl({ ...base, operation: 'toolkit.get', toolId: definition.id }, path)
    expect(receipt).toMatchObject({ operation: 'toolkit.get', result: { snapshot: snapshot() } })
    execute.mockClear()
    const frames: string[] = [], snapshots: unknown[] = []
    const lease = await subscribeAgentMuxToolkit({ ...base, operation: 'toolkit.watch', toolId: definition.id }, {
      onFrame: frame => { frames.push(frame.event); if (frame.event === 'snapshot') snapshots.push(frame.result.snapshot) }, onEnd: vi.fn()
    }, { path })
    await vi.waitFor(() => expect(snapshots).toEqual([snapshot()]))
    expect(frames).toEqual(['attached', 'snapshot']); expect(execute).not.toHaveBeenCalled()
    lease.dispose(); await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
  })
  it('rejects an actual stream snapshot from another tool before attachment', async () => {
    const path = join(await directory(), 'control.sock'), release = vi.fn()
    const port: AgentMuxToolkitPort = { execute: vi.fn(), subscribe: async (_toolId, publish) => {
      publish({ ...snapshot(), toolId: 'another', definition: { ...definition, id: 'another' } }); return { dispose: release }
    } }
    const server = new AgentMuxControlServer({ execute: vi.fn(), toolkit: port }, path)
    await server.start(); cleanup.push(() => server.stop())
    await expect(subscribeAgentMuxToolkit({ ...base, operation: 'toolkit.watch', toolId: definition.id }, { onFrame: vi.fn(), onEnd: vi.fn() }, { path })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
  })
  it('rejects valid but differently targeted owner replies on the actual get socket', async () => {
    const path = join(await directory(), 'control.sock')
    const other = { ...snapshot(), toolId: 'another', definition: { ...definition, id: 'another' } }
    const port: AgentMuxToolkitPort = { execute: async () => ({ operation: 'toolkit.get', snapshot: other }), subscribe: vi.fn() }
    const server = new AgentMuxControlServer({ execute: vi.fn(), toolkit: port }, path)
    await server.start(); cleanup.push(() => server.stop())
    const reply = await requestAgentMuxControl({ ...base, operation: 'toolkit.get', toolId: definition.id }, path).then(
      value => ({ ok: true, value }), error => ({ ok: false, code: error.code }))
    expect(reply).toEqual({ ok: false, code: 'CONTROL_PROTOCOL_ERROR' })
  })
  it('rejects differently targeted complete success frames from an actual remote socket', async () => {
    const path = join(await directory(), 'remote.sock')
    const other = { ...snapshot(), toolId: 'another', definition: { ...definition, id: 'another' } }
    const server = createServer(socket => socket.once('data', () => socket.end(JSON.stringify({ ...base,
      operation: 'toolkit.get', ok: true, result: { snapshot: other } }) + '\n')))
    await new Promise<void>(resolve => server.listen(path, resolve))
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const reply = await requestAgentMuxControl({ ...base, operation: 'toolkit.get', toolId: definition.id }, path).then(
      value => ({ ok: true, value }), error => ({ ok: false, code: error.code }))
    expect(reply).toEqual({ ok: false, code: 'CONTROL_PROTOCOL_ERROR' })
  })
})
