import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { fixturePath } from './helpers/fixture-values.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { objectCliReceipt } from './helpers/object-cli-receipt.js'
import { settingsIconCatalogFixture } from './helpers/settings-icon-catalog-fixture.js'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentMuxControlServer, parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from '../src/control-host.js'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, AGENTMUX_CONTROL_SCHEMA_VERSION,
  type AgentMuxControlRequest, type AgentMuxControlResult, type AgentMuxControlSettingsResourceFields,
  type AgentMuxControlSettingsResourceKind } from '../src/control.js'
import { AgentMuxError } from '../src/errors.js'

const cli = fileURLToPath(new URL('../bin/amux', import.meta.url))
const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'resource-proof' }
const initial = { label: 'Original', parts: ['one'], attributes: { color: 'quiet' } }
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

// This owner is deliberately opaque to Core: these field names are not a Desktop schema.
describe('resource CLI consumes the public Control owner without a caller or View', () => {
  let root: string
  let server: AgentMuxControlServer
  let seen: AgentMuxControlRequest[]
  let records: Record<AgentMuxControlSettingsResourceKind, Map<string, AgentMuxControlSettingsResourceFields>>

  beforeEach(async () => {
    root = await mkdtemp(fixturePath("tmp/amux-resource-cli-"))
    seen = []
    records = { executors: new Map([['first', structuredClone(initial)]]), prompts: new Map(), themes: new Map() }
    server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], async execute(request): Promise<AgentMuxControlResult> {
      seen.push(request)
      if (!('resource' in request)) throw new Error(`Unexpected ${request.operation}`)
      const store = records[request.resource]
      if (request.operation === 'settings.resource.list') {
        if (request.resource === 'themes') return { operation: request.operation, resource: request.resource,
          items: [...store].map(([id, value]) => ({ id, value })), partial: true, iconCatalog: settingsIconCatalogFixture() }
        return { operation: request.operation, resource: request.resource,
          items: [...store].map(([id, value]) => ({ id, value })), partial: true }
      }
      if (request.operation === 'settings.resource.add') {
        if (store.has(request.id)) throw new AgentMuxError('Resource exists.', 'SETTING_RESOURCE_EXISTS')
        store.set(request.id, request.value)
        return { operation: request.operation, resource: request.resource,
          item: { id: request.id, value: request.value }, changed: true }
      }
      const value = store.get(request.id)
      if (!value) throw new AgentMuxError('Resource missing.', 'SETTING_RESOURCE_NOT_FOUND')
      if (request.operation === 'settings.resource.get') {
        return { operation: request.operation, resource: request.resource, item: { id: request.id, value } }
      }
      if (request.operation === 'settings.resource.update') {
        if (Object.hasOwn(request.changes, 'id')) throw new AgentMuxError('Identity is immutable.', 'SETTING_IDENTITY_IMMUTABLE')
        if (request.expected && Object.entries(request.expected).some(([key, expected]) => !same(value[key], expected))) {
          throw new AgentMuxError('Resource changed.', 'CONFIG_CONFLICT')
        }
        const updated = { ...value, ...request.changes }, changed = !same(value, updated)
        store.set(request.id, updated)
        return { operation: request.operation, resource: request.resource, item: { id: request.id, value: updated }, changed }
      }
      if (request.id === 'held') throw new AgentMuxError('Retained reference.', 'SETTING_RESOURCE_IN_USE')
      if (request.id === 'unknown-references') throw new AgentMuxError('Reference facts unavailable.', 'SETTING_RESOURCE_REFERENCES_UNKNOWN')
      if (request.expected && !same(value, request.expected)) throw new AgentMuxError('Resource changed.', 'CONFIG_CONFLICT')
      store.delete(request.id)
      return { operation: request.operation, resource: request.resource, id: request.id, removed: true }
    } })
    await server.start()
  })

  afterEach(async () => {
    await server?.stop()
    if (root) await rm(root, { recursive: true })
  })

  async function run(args: readonly string[], input?: string | Buffer) {
    return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], { cwd: root,
        env: { ...objectCliEnvironment(root), AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'durable'), AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined },
        stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('Resource CLI did not finish.')) }, 5_000)
      child.stdout.setEncoding('utf8').on('data', data => { stdout += data })
      child.stderr.setEncoding('utf8').on('data', data => { stderr += data })
      child.stdin.on('error', () => {}) // A bounded reader can close stdin before an oversized writer finishes.
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
      child.stdin.end(input)
    })
  }

  async function file(value: unknown, name = 'input.json') {
    await writeFile(join(root, name), JSON.stringify(value))
    return name
  }

  async function raw(fields: unknown) {
    return await new Promise<unknown>((resolve, reject) => {
      const socket = createConnection(server.path)
      let output = ''
      socket.setEncoding('utf8')
      socket.once('connect', () => socket.end(`${JSON.stringify(fields)}\n`))
      socket.on('data', data => { output += data })
      socket.once('end', () => { try { resolve(JSON.parse(output)) } catch (error) { reject(error) } })
      socket.once('error', reject)
    })
  }

  function success(output: { code: number; stdout: string; stderr: string }) {
    expect(output.code, output.stderr).toBe(0)
    expect(output.stderr).toBe('')
    const receipt = objectCliReceipt(JSON.parse(output.stdout))
    expect(receipt.ok).toBe(true)
    if (!receipt.ok) throw new Error('Expected success.')
    return receipt
  }

  it('preserves theme readonly metadata, issues and exact raw deletion expectations over the public codec', () => {
    const request = parseAgentMuxControlRequest({ ...base, operation: 'settings.resource.remove', resource: 'themes', id: 'custom.raw', expected: null })
    expect(request).toMatchObject({ expected: null })
    const result = parseAgentMuxControlReceipt({ ...base, ok: true, operation: 'settings.resource.list', result: {
      resource: 'themes', partial: true, items: [{ id: 'graphite', value: initial, readonly: true }],
      iconCatalog: settingsIconCatalogFixture(),
      issues: [{ id: 'custom.raw', message: 'Original retained.' }, { id: '', message: 'Malformed identity retained.' }]
    } })
    expect(result).toMatchObject({ result: { items: [{ readonly: true }], issues: [{ id: 'custom.raw' }, { id: '' }] } })
  })

  it('lists nonempty and empty owner collections and gets an exact item', async () => {
    expect(success(await run(['settings', 'executors', 'ls'])).result).toEqual({ resource: 'executors',
      items: [{ id: 'first', value: initial }], partial: true })
    expect(success(await run(['settings', 'prompts', 'ls'])).result).toEqual({ resource: 'prompts', items: [], partial: true })
    expect(success(await run(['settings', 'executors', 'inspect', 'first'])).result).toEqual({ resource: 'executors', item: { id: 'first', value: initial } })
    expect(seen.map(({ requestId, ...request }) => request)).toEqual([
      { schemaVersion: base.schemaVersion, operation: 'settings.resource.list', resource: 'executors' },
      { schemaVersion: base.schemaVersion, operation: 'settings.resource.list', resource: 'prompts' },
      { schemaVersion: base.schemaVersion, operation: 'settings.resource.get', resource: 'executors', id: 'first' }
    ])
  })

  it('commits add/update/remove through the owner with exact expected and whole-field replacements', async () => {
    const value = { label: 'Fresh', parts: ['a', 'b'], attributes: { x: 'one' } }
    expect(success(await run(['settings', 'prompts', 'create', 'new', '--input', await file(value)])).result)
      .toEqual({ resource: 'prompts', item: { id: 'new', value }, changed: true })
    const edit = { changes: { parts: [], attributes: {} }, expected: { parts: ['a', 'b'], attributes: { x: 'one' } } }
    const updated = { label: 'Fresh', parts: [], attributes: {} }
    expect(success(await run(['settings', 'prompts', 'update', 'new', '--input', await file(edit)])).result)
      .toEqual({ resource: 'prompts', item: { id: 'new', value: updated }, changed: true })
    expect(success(await run(['settings', 'prompts', 'update', 'new', '--input', await file({ changes: edit.changes })])).result)
      .toEqual({ resource: 'prompts', item: { id: 'new', value: updated }, changed: false })
    expect(success(await run(['settings', 'prompts', 'delete', 'new', '--input', await file({ expected: updated })])).result)
      .toEqual({ resource: 'prompts', id: 'new', removed: true })
    expect(records.prompts.size).toBe(0)
    expect(seen.map(({ requestId, ...request }) => request)).toEqual([
      { schemaVersion: base.schemaVersion, operation: 'settings.resource.add', resource: 'prompts', id: 'new', value },
      { schemaVersion: base.schemaVersion, operation: 'settings.resource.update', resource: 'prompts', id: 'new', ...edit },
      { schemaVersion: base.schemaVersion, operation: 'settings.resource.update', resource: 'prompts', id: 'new', changes: edit.changes },
      { schemaVersion: base.schemaVersion, operation: 'settings.resource.remove', resource: 'prompts', id: 'new', expected: updated }
    ])
  })

  it('preserves literal strings and special own keys over file, stdin, wire and receipt', async () => {
    const fields = { args: ['', 'gpt 5', 'a\\b', '$HOME', '--help', 'a"b\'c'],
      env: JSON.parse('{"__proto__":"exact","constructor":"literal","EMPTY":"","LINES":" one\\n two "}'),
      body: '  line one\nline two\n  ' }
    const added = success(await run(['settings', 'prompts', 'create', '--help', '--input', await file(fields, '--help')]))
    expect(added.result).toEqual({ resource: 'prompts', item: { id: '--help', value: fields }, changed: true })
    const got = success(await run(['settings', 'prompts', 'inspect', '--help']))
    expect(got.result).toEqual({ resource: 'prompts', item: { id: '--help', value: fields } })
    const env = records.prompts.get('--help')!.env
    if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('Expected the preserved field object.')
    expect(Object.keys(env)).toEqual(['__proto__', 'constructor', 'EMPTY', 'LINES'])
    expect(Object.hasOwn(env, '__proto__')).toBe(true)
    const stdinValue = { ...fields, body: ' stdin \n untouched ', unbind: null }
    expect(success(await run(['settings', 'prompts', 'update', '--help', '--input', '-'], JSON.stringify({ changes: stdinValue }))).result)
      .toEqual({ resource: 'prompts', item: { id: '--help', value: stdinValue }, changed: true })
    expect(records.prompts.get('--help')).toEqual(stdinValue)
    expect(Object.hasOwn(Object.prototype, 'exact')).toBe(false)
    expect(seen.map(({ requestId, ...request }) => request)).toEqual([
      { schemaVersion: base.schemaVersion, operation: 'settings.resource.add', resource: 'prompts', id: '--help', value: fields },
      { schemaVersion: base.schemaVersion, operation: 'settings.resource.get', resource: 'prompts', id: '--help' },
      { schemaVersion: base.schemaVersion, operation: 'settings.resource.update', resource: 'prompts', id: '--help', changes: stdinValue }
    ])
  })

  it.each(['-h', 'self', '  literal ID  ', '__proto__', 'constructor'])('keeps positional ID %j literal without a caller', async id => {
    records.prompts.set(id, initial)
    expect(success(await run(['settings', 'prompts', 'inspect', id])).result).toEqual({ resource: 'prompts', item: { id, value: initial } })
    expect(success(await run(['settings', 'prompts', 'delete', id])).result).toEqual({ resource: 'prompts', id, removed: true })
    expect(records.prompts.has(id)).toBe(false)
  })

  it.each([
    ['executors', '--help'], ['prompts', '-h'], ['executors', 'ls', '--help'], ['prompts', 'ls', '-h']
  ])('prints resource help offline only at syntax positions %j', async (...args) => {
    await server.stop()
    const output = await run(['settings', ...args])
    expect(output.code).toBe(0)
    expect(output.stdout).toContain('settings')
    expect(output.stdout).toContain('--input <file|->')
    expect(output.stdout).toContain('"changes"')
    expect(output.stdout).toContain('CONTROL_UNAVAILABLE')
    expect(seen).toEqual([])
  })

  it.each([
    ['executors', 'ls', 'extra'], ['executors', 'inspect'], ['prompts', 'inspect', 'first', '--input', '-'],
    ['prompts', 'create', 'new'], ['prompts', 'update', 'first'], ['prompts', 'create', 'new', '--input', '-', '--help'],
    ['prompts', 'create', 'new', '--input', '-', '--input', '-'], ['prompts', 'delete', 'first', '--input'],
    ['prompts', 'replace', 'first'], ['other', 'list'], ['prompts', 'inspect', '  ']
  ])('rejects malformed arguments %j before reaching the owner', async (...args) => {
    const output = await run(['settings', ...args], '{}')
    expect(output.code).toBe(1)
    expect(output.stdout).toBe('')
    expect(JSON.parse(output.stderr)).toMatchObject({ ok: false, error: { code: args.at(-1) === '  ' ? 'INVALID_CONTROL_REQUEST' : 'INVALID_CLI_ARGUMENT' } })
    expect(seen).toEqual([])
  })

  it.each([
    ['create', null], ['create', []], ['create', { id: 'new', label: 'invalid envelope' }],
    ['update', {}], ['update', { changes: {} }], ['update', { changes: [] }],
    ['update', { changes: { label: 'new' }, expected: [] }], ['update', { changes: { label: 'new' }, extra: true }],
    ['delete', { label: 'bare expected is not a wrapper' }], ['delete', { expected: null }]
  ])('rejects malformed %s input %j before reaching the owner', async (action, value) => {
    const output = await run(['settings', 'prompts', String(action), 'new', '--input', await file(value)])
    expect(output.code).toBe(1)
    expect(output.stdout).toBe('')
    expect(JSON.parse(output.stderr)).toMatchObject({ ok: false, error: { code: 'INVALID_CONTROL_REQUEST' } })
    expect(seen).toEqual([])
  })

  it.each(['file', 'stdin'])('rejects oversized %s input even when whitespace hides a small valid JSON object', async source => {
    const oversized = `${' '.repeat(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES)}{"label":"small"}`
    if (source === 'file') await writeFile(join(root, 'large.json'), oversized)
    const output = await run(['settings', 'prompts', 'create', 'large', '--input', source === 'file' ? 'large.json' : '-'],
      source === 'stdin' ? oversized : undefined)
    expect(output.code).toBe(1)
    expect(JSON.parse(output.stderr)).toMatchObject({ error: { code: 'INVALID_CLI_ARGUMENT' } })
    expect(seen).toEqual([])
    expect(records.prompts.size).toBe(0)
  })

  it.each([Buffer.from('{"label":'), Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d])])(
    'rejects malformed JSON or UTF-8 without sending partial input', async content => {
      const output = await run(['settings', 'prompts', 'create', 'new', '--input', '-'], content)
      expect(output.code).toBe(1)
      expect(JSON.parse(output.stderr)).toMatchObject({ error: { code: 'INVALID_CLI_ARGUMENT' } })
      expect(seen).toEqual([])
    })

  it('rejects unreadable input and a ninth container level before reaching the owner', async () => {
    const deep = JSON.parse(`${'{"x":'.repeat(9)}0${'}'.repeat(9)}`)
    for (const [path, code] of [['missing.json', 'INVALID_CLI_ARGUMENT'], [await file(deep), 'INVALID_CONTROL_REQUEST']] as const) {
      const output = await run(['settings', 'prompts', 'create', 'new', '--input', path])
      expect(output.code).toBe(1)
      expect(JSON.parse(output.stderr)).toMatchObject({ error: { code } })
    }
    expect(seen).toEqual([])
  })

  it.each([
    ['inspect', 'missing', undefined, 'SETTING_RESOURCE_NOT_FOUND'],
    ['create', 'first', {}, 'SETTING_RESOURCE_EXISTS'],
    ['update', 'first', { changes: { id: 'other' } }, 'SETTING_IDENTITY_IMMUTABLE'],
    ['update', 'first', { changes: { label: 'new' }, expected: { label: 'stale' } }, 'CONFIG_CONFLICT'],
    ['delete', 'first', { expected: {} }, 'CONFIG_CONFLICT'],
    ['delete', 'held', undefined, 'SETTING_RESOURCE_IN_USE'],
    ['delete', 'unknown-references', undefined, 'SETTING_RESOURCE_REFERENCES_UNKNOWN']
  ])('preserves named owner error for %s %s', async (action, id, input, code) => {
    records.executors.set('held', initial)
    records.executors.set('unknown-references', initial)
    const before = [...records.executors]
    const output = await run(['settings', 'executors', String(action), String(id),
      ...(input === undefined ? [] : ['--input', await file(input)])])
    expect(output.code).toBe(1)
    expect(objectCliReceipt(JSON.parse(output.stderr))).toMatchObject({ ok: false,
      operation: `settings.executors.${action}`, error: { code } })
    expect(seen).toHaveLength(1)
    expect([...records.executors]).toEqual(before)
  })

  it('reports an unavailable owner without reading or writing any alternative configuration', async () => {
    await server.stop()
    const output = await run(['settings', 'prompts', 'create', 'new', '--input', await file({ label: 'fresh' })])
    expect(output.code).toBe(1)
    expect(objectCliReceipt(JSON.parse(output.stderr))).toMatchObject({ ok: false,
      operation: 'settings.prompts.create', error: { code: 'CONTROL_UNAVAILABLE' } })
    expect(seen).toEqual([])
    expect(records.prompts.size).toBe(0)
  })

  it.each([
    { operation: 'settings.resource.list', resource: 'other' },
    { operation: 'settings.resource.list', resource: 'prompts', id: 'extra' },
    { operation: 'settings.resource.get', resource: 'prompts', id: 'first', caller: { agentSessionId: 'guess' } },
    { operation: 'settings.resource.add', resource: 'prompts', id: 'new', value: [] },
    { operation: 'settings.resource.add', resource: 'prompts', id: 'new', value: { id: 'duplicate' } },
    { operation: 'settings.resource.update', resource: 'prompts', id: 'first', changes: {} },
    { operation: 'settings.resource.update', resource: 'prompts', id: 'first', changes: { label: 'new' }, expected: [] },
    { operation: 'settings.resource.remove', resource: 'prompts', id: 'first', expected: null },
    ...['path', 'input', 'AppConfig', 'registry'].map(key => ({ operation: 'settings.resource.get', resource: 'prompts', id: 'first', [key]: 'extra' }))
  ])('rejects malformed wire before its owner %j', async fields => {
    expect(() => parseAgentMuxControlRequest({ ...base, ...fields })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    expect(seen).toEqual([])
  })

  it('rejects an unknown operation and preserves special own keys from a raw socket request', async () => {
    expect(() => parseAgentMuxControlRequest({ ...base, operation: 'settings.resource.replace', resource: 'prompts', id: 'new', value: {} })).toThrow()
    expect(seen).toEqual([])
    const value = JSON.parse('{"__proto__":{"literal":true},"constructor":"data"}')
    expect(success(await run(['settings', 'prompts', 'create', 'own', '--input', await file(value)])).result).toMatchObject({ item: { id: 'own', value } })
    expect(Object.keys(records.prompts.get('own')!)).toEqual(['__proto__', 'constructor'])
    expect(Object.hasOwn(records.prompts.get('own')!, '__proto__')).toBe(true)
  })
})

describe('resource protocol is bounded pure JSON with strict receipts', () => {
  const request = (value: unknown) => ({ ...base, operation: 'settings.resource.add', resource: 'prompts', id: 'new', value })
  const receipt = (operation: string, result: unknown) => ({ ...base, ok: true, operation, result })
  const item = { id: 'one', value: initial }
  const invalid = (fn: () => unknown, code: string) => {
    try { fn(); throw new Error('Expected a typed rejection.') } catch (error) {
      expect(error).toBeInstanceOf(AgentMuxError)
      expect(error).toMatchObject({ code })
    }
  }

  it('admits exactly eight container levels and rejects nine, including cycles', () => {
    const depth = (n: number) => JSON.parse(`${'{"x":'.repeat(n)}0${'}'.repeat(n)}`)
    expect(parseAgentMuxControlRequest(request(depth(8)))).toEqual(request(depth(8)))
    invalid(() => parseAgentMuxControlRequest(request(depth(9))), 'INVALID_CONTROL_REQUEST')
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    invalid(() => parseAgentMuxControlRequest(request(cycle)), 'INVALID_CONTROL_REQUEST')
  })

  it.each([
    ['undefined', { hidden: undefined }], ['NaN', { nan: NaN }], ['infinity', { infinity: Infinity }],
    ['function', { fn: () => true }], ['BigInt', { bigint: 1n }], ['Date', { date: new Date(reshapeFixtureEpoch(0, 0, 0)) }],
    ['sparse array', { sparse: Array(1) }], ['array extra field', { array: Object.assign([], { extra: true }) }],
    ['symbol value', { symbol: Symbol('not-json') }], ['inherited field', Object.create({ inherited: true })],
    ['hidden field', Object.defineProperty({}, 'hidden', { value: true })],
    ['accessor', Object.defineProperty({}, 'accessor', { enumerable: true, get: () => { throw new Error('Do not invoke an accessor.') } })],
    ['symbol key', { [Symbol('own')]: true }]
  ])('rejects non-JSON %s before it can be silently serialized away', (_, value) => {
    invalid(() => parseAgentMuxControlRequest(request(value)), 'INVALID_CONTROL_REQUEST')
  })

  it('rejects full request and aggregate list receipts exceeding the existing message budget', () => {
    invalid(() => parseAgentMuxControlRequest(request({ body: 'x'.repeat(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES - 40) })), 'INVALID_CONTROL_REQUEST')
    const value = { body: 'x'.repeat(Math.floor(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES / 2)) }
    invalid(() => parseAgentMuxControlReceipt(receipt('settings.resource.list', { resource: 'prompts', partial: true,
      items: [{ id: 'a', value }, { id: 'b', value }] })), 'CONTROL_PROTOCOL_ERROR')
  })

  it.each([
    ['settings.resource.list', { resource: 'prompts', partial: false, items: [] }],
    ['settings.resource.list', { resource: 'prompts', partial: true, items: [item, item] }],
    ['settings.resource.list', { resource: 'prompts', partial: true, items: Array(1) }],
    ['settings.resource.list', { resource: 'prompts', partial: true, items: [null] }],
    ['settings.resource.list', { resource: 'prompts', partial: true, items: [], extra: true }],
    ['settings.resource.list', { resource: 'themes', partial: true, items: [], issues: [{ id: 1, message: 'Bad identity' }] }],
    ['settings.resource.list', { resource: 'themes', partial: true, items: [], issues: Array(1) }],
    ['settings.resource.get', { resource: 'themes', item: { ...item, readonly: 'yes' } }],
    ['settings.resource.get', { resource: 'other', item }],
    ['settings.resource.get', { resource: 'prompts', item: { ...item, extra: true } }],
    ['settings.resource.get', { resource: 'prompts', item: { id: 'one', value: { id: 'nested identity' } } }],
    ['settings.resource.add', { resource: 'prompts', item, changed: 'yes' }],
    ['settings.resource.update', { resource: 'prompts', item, changed: true, expected: {} }],
    ['settings.resource.remove', { resource: 'prompts', id: 'one', removed: false }],
    ['settings.resource.remove', { resource: 'prompts', id: 'one', removed: true, item }]
  ])('rejects malformed %s receipt %j', (operation, result) => {
    invalid(() => parseAgentMuxControlReceipt(receipt(String(operation), result)), 'CONTROL_PROTOCOL_ERROR')
  })

  it('returns typed receipts for every operation, including an empty resource list', () => {
    for (const [operation, result] of [
      ['settings.resource.list', { resource: 'prompts', items: [], partial: true }],
      ['settings.resource.get', { resource: 'prompts', item }],
      ['settings.resource.add', { resource: 'prompts', item, changed: true }],
      ['settings.resource.update', { resource: 'prompts', item, changed: false }],
      ['settings.resource.remove', { resource: 'prompts', id: 'one', removed: true }]
    ] as const) expect(parseAgentMuxControlReceipt(receipt(operation, result))).toEqual(receipt(operation, result))
  })

  it('rejects resource receipt envelope extras instead of silently dropping them', () => {
    invalid(() => parseAgentMuxControlReceipt({ ...receipt('settings.resource.get', { resource: 'prompts', item }), path: 'local' }),
      'CONTROL_PROTOCOL_ERROR')
  })
})
