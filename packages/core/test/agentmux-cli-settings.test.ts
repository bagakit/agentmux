import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentMuxControlServer, parseAgentMuxControlReceipt } from '../src/control-host.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxControlRequest,
  type AgentMuxControlResult, type AgentMuxControlSettingEntry } from '../src/control.js'
import { AgentMuxError } from '../src/errors.js'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/agentmux', import.meta.url))
const initial: AgentMuxControlSettingEntry[] = [
  { key: 'client.mode', kind: 'string', value: 'quiet', default: 'quiet', enum: ['quiet', 'bright'] },
  { key: 'client.copy', kind: 'boolean', value: true, default: false },
  { key: 'client.scale', kind: 'number', value: 2, default: 1 },
  { key: 'client.label', kind: 'string', value: '', default: '' }
]

describe('settings CLI over the public Control socket', () => {
  let root: string
  let server: AgentMuxControlServer
  let entries: AgentMuxControlSettingEntry[]
  let seen: AgentMuxControlRequest[]

  beforeEach(async () => {
    root = await mkdtemp('/tmp/amux-settings-cli-')
    entries = structuredClone(initial)
    seen = []
    server = new AgentMuxControlServer({ async execute(request): Promise<AgentMuxControlResult> {
      seen.push(request)
      if (request.operation === 'settings.get') {
        const selected = request.target === undefined || request.target === '' || request.target === 'client'
          ? entries : entries.filter(({ key }) => key === request.target)
        if (selected.length === 0) throw new AgentMuxError('Unsupported setting target.', 'UNSUPPORTED_SETTING')
        return { operation: request.operation, entries: selected, partial: true }
      }
      if (request.operation === 'settings.set') {
        if (request.key === 'client.conflict') throw new AgentMuxError('Setting changed.', 'CONFIG_CONFLICT')
        const entry = entries.find(({ key }) => key === request.key)
        if (!entry) throw new AgentMuxError('Unsupported setting.', 'UNSUPPORTED_SETTING')
        if (entry.kind !== 'string' || (entry.enum && !entry.enum.includes(request.value))) {
          throw new AgentMuxError('Invalid setting value.', 'INVALID_SETTING_VALUE')
        }
        entry.value = request.value
        return { operation: request.operation, entry }
      }
      throw new Error(`Settings must not invoke ${request.operation}`)
    } }, join(root, 'control.sock'))
    await server.start()
  })

  afterEach(async () => {
    await server?.stop()
    if (root) await rm(root, { recursive: true })
  })

  async function run(args: readonly string[]) {
    const options = { timeout: 5_000, env: { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: root,
      AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined } }
    try {
      const output = await exec(process.execPath, [cli, ...args], options)
      return { code: 0, ...output }
    } catch (error) {
      return error as { code: number; stdout: string; stderr: string }
    }
  }

  it('gets real host scalar facts without a managed caller or View and forwards an exact target', async () => {
    const all = await run(['settings', 'get'])
    expect(all.code).toBe(0)
    expect(parseAgentMuxControlReceipt(JSON.parse(all.stdout))).toEqual({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: expect.any(String), ok: true, operation: 'settings.get', result: { entries: initial, partial: true } })
    const selected = await run(['settings', 'get', 'client.copy'])
    expect(selected.code).toBe(0)
    expect(JSON.parse(selected.stdout).result).toEqual({ entries: [initial[1]], partial: true })
    expect(seen.map(({ requestId, ...request }) => request)).toEqual([
      { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'settings.get' },
      { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'settings.get', target: 'client.copy' }
    ])
  })

  it('sets through the owner and reports the subsequent committed facts', async () => {
    const written = await run(['settings', 'set', 'client.mode', 'bright'])
    expect(written.code).toBe(0)
    expect(parseAgentMuxControlReceipt(JSON.parse(written.stdout))).toEqual({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: expect.any(String), ok: true, operation: 'settings.set',
      result: { entry: { ...initial[0], value: 'bright' } } })
    const read = await run(['settings', 'get', 'client.mode'])
    expect(read.code).toBe(0)
    expect(JSON.parse(read.stdout).result).toEqual({ entries: [{ ...initial[0], value: 'bright' }], partial: true })
    expect(seen.map(({ requestId, ...request }) => request)).toEqual([
      { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'settings.set', key: 'client.mode', value: 'bright' },
      { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'settings.get', target: 'client.mode' }
    ])
  })

  it.each(['--help', '-h', '', 'a value with spaces'])('preserves positional scalar data %j', async (value) => {
    const written = await run(['settings', 'set', 'client.label', value])
    expect(written.code).toBe(0)
    expect(JSON.parse(written.stdout).result).toEqual({ entry: { ...initial[3], value } })
    expect(seen).toEqual([{ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: expect.any(String),
      operation: 'settings.set', key: 'client.label', value }])
  })

  it.each([
    [['settings'], 'settings'],
    [['settings', 'get', 'a', 'b'], 'settings.get'],
    [['settings', 'get', '--target', 'a'], 'settings.get'],
    [['settings', 'set'], 'settings.set'],
    [['settings', 'set', 'client.mode'], 'settings.set'],
    [['settings', 'set', 'client.mode', 'bright', 'extra'], 'settings.set'],
    [['settings', 'set', '--key', 'value'], 'settings.set'],
    [['settings', 'set', 'client.mode', 'bright', '--help'], 'settings.set'],
    [['settings', '--help', '--help'], 'settings'],
    [['settings', 'apply', '{}'], 'settings.apply']
  ])('rejects malformed CLI arguments %j before reaching the owner', async (args, operation) => {
    const rejected = await run(args as string[])
    expect(rejected.code).toBe(1)
    expect(rejected.stdout).toBe('')
    expect(JSON.parse(rejected.stderr)).toMatchObject({ ok: false, operation, error: { code: 'INVALID_CLI_ARGUMENT' } })
    expect(seen).toEqual([])
  })

  it.each([
    [['settings', 'get', 'unknown'], 'settings.get', 'UNSUPPORTED_SETTING'],
    [['settings', 'set', 'unknown', 'bright'], 'settings.set', 'UNSUPPORTED_SETTING'],
    [['settings', 'set', 'client.mode', 'invalid'], 'settings.set', 'INVALID_SETTING_VALUE'],
    [['settings', 'set', 'client.conflict', 'bright'], 'settings.set', 'CONFIG_CONFLICT']
  ])('preserves a host error code for %j', async (args, operation, code) => {
    const failed = await run(args as string[])
    expect(failed.code).toBe(1)
    expect(failed.stdout).toBe('')
    expect(parseAgentMuxControlReceipt(JSON.parse(failed.stderr))).toMatchObject({ ok: false, operation, error: { code } })
    expect(seen).toHaveLength(1)
    expect(entries).toEqual(initial)
  })

  it.each([['settings', '--help'], ['settings', 'get', '--help'], ['settings', 'set', '-h']])(
    'provides offline help at syntax positions %j', async (...args) => {
      await server.stop()
      const output = await run(args)
      expect(output.code).toBe(0)
      expect(output.stdout).toContain('agentmux settings')
      expect(output.stdout).toContain('CONTROL_UNAVAILABLE')
      expect(output.stdout).not.toContain('client.mode')
      expect(output.stdout).not.toContain('bright')
      expect(seen).toEqual([])
    })

  it('fails accurately when the owner is offline and never substitutes local writes', async () => {
    await server.stop()
    const failed = await run(['settings', 'set', 'client.mode', 'bright'])
    expect(failed.code).toBe(1)
    expect(JSON.parse(failed.stderr)).toMatchObject({ ok: false, operation: 'settings.set',
      error: { code: 'CONTROL_UNAVAILABLE' } })
    expect(entries).toEqual(initial)
    expect(seen).toEqual([])
  })

  it('exposes settings in both top-level discovery and Agent instructions', async () => {
    const help = await run(['--help'])
    const skill = await run(['--skill'])
    expect(help.code).toBe(0)
    expect(skill.code).toBe(0)
    expect(help.stdout).toContain('settings    Read or change preferences')
    expect(skill.stdout).toContain('agentmux settings get')
    expect(skill.stdout).toContain('agentmux settings set <key> <value>')
    expect(skill.stdout).toContain('partial means other settings')
    expect(seen).toEqual([])
  })

  async function raw(request: unknown): Promise<unknown> {
    return await new Promise((resolve, reject) => {
      const socket = createConnection(server.path)
      let output = ''
      socket.setEncoding('utf8')
      socket.once('connect', () => socket.end(`${JSON.stringify(request)}\n`))
      socket.on('data', (chunk) => { output += chunk })
      socket.once('end', () => { try { resolve(JSON.parse(output)) } catch (error) { reject(error) } })
      socket.once('error', reject)
    })
  }

  it.each([
    { operation: 'settings.get', target: false },
    { operation: 'settings.get', path: 'client.mode' },
    { operation: 'settings.get', caller: { agentSessionId: 'any' } },
    { operation: 'settings.set', key: 'client.mode', value: false },
    { operation: 'settings.set', key: {}, value: 'bright' },
    { operation: 'settings.set', key: 'client.mode' },
    ...['path', 'op', 'patch', 'expected', 'target', 'caller'].map((field) => ({
      operation: 'settings.set', key: 'client.mode', value: 'bright', [field]: 'unexpected'
    }))
  ])('rejects malformed wire fields before executing %j', async (fields) => {
    const receipt = await raw({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'bad-wire', ...fields })
    expect(parseAgentMuxControlReceipt(receipt)).toMatchObject({ requestId: 'bad-wire', ok: false,
      operation: fields.operation, error: { code: 'INVALID_CONTROL_REQUEST' } })
    expect(seen).toEqual([])
    expect(entries).toEqual(initial)
  })
})

describe('settings receipt scalar boundaries', () => {
  const get = (result: unknown) => ({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId: 'facts', ok: true, operation: 'settings.get', result })

  it.each([
    { entries: [], partial: true },
    { entries: initial, partial: false },
    { entries: initial, partial: true, schema: {} },
    { entries: [initial[0], initial[0]], partial: true },
    ...[
      { ...initial[0], kind: 'object' },
      { ...initial[0], value: false },
      { ...initial[0], default: false },
      { ...initial[0], enum: [] },
      { ...initial[0], enum: ['quiet', false] },
      { ...initial[0], value: 'outside' },
      { ...initial[0], default: 'outside' },
      { ...initial[0], path: 'arbitrary' },
      { ...initial[2], value: Infinity }
    ].map((entry) => ({ entries: [entry], partial: true }))
  ])('rejects misleading scalar facts %j', (result) => {
    expect(() => parseAgentMuxControlReceipt(get(result))).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })

  it('requires one typed committed entry for set', () => {
    const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'commit', ok: true, operation: 'settings.set' }
    expect(parseAgentMuxControlReceipt({ ...envelope, result: { entry: initial[1] } })).toEqual({
      ...envelope, result: { entry: initial[1] } })
    for (const result of [{}, { entry: initial[1], committed: true }, { entry: { ...initial[1], value: 'true' } }]) {
      expect(() => parseAgentMuxControlReceipt({ ...envelope, result })).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    }
  })
})
