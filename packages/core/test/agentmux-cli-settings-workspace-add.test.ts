import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentMuxControlServer, parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from '../src/control-host.js'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, AGENTMUX_CONTROL_SCHEMA_VERSION,
  isAgentMuxControlOperation, type AgentMuxControlRequest, type AgentMuxControlResult } from '../src/control.js'
import type { AgentMuxControlSettingsWorkspaceAddRequest, AgentMuxControlSettingsResourceItem } from '../src/index.js'
import { AgentMuxError } from '../src/errors.js'

const cli = fileURLToPath(new URL('../bin/agentmux', import.meta.url))
const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'workspace-add-proof' }
const operation = 'settings.workspaces.add'
const command = ['settings', 'workspaces', 'add']
const committed: AgentMuxControlSettingsResourceItem = { id: 'owner-assigned-workspace', value: {
  hostId: 'owner-host', path: 'owner literal path ', name: 'Owner-selected name', kind: 'future-host-kind',
  repoPath: '$LITERAL/repository', branch: '--help', hostFact: { retained: true }
} }

describe('Workspace add built CLI consumes the public owner without a caller or View', () => {
  let root: string, server: AgentMuxControlServer, seen: AgentMuxControlRequest[], changed: boolean, ownerError: AgentMuxError | undefined
  beforeEach(async () => {
    root = await mkdtemp('/tmp/amux-workspace-add-cli-')
    seen = []; changed = true; ownerError = undefined
    // This is an opaque host fixture, not a Desktop registration or location implementation.
    server = new AgentMuxControlServer({ async execute(request): Promise<AgentMuxControlResult> {
      seen.push(request)
      if (request.operation !== operation) throw new Error(`Unexpected ${request.operation}`)
      if (ownerError) throw ownerError
      return { operation, item: structuredClone(committed), changed }
    } }, join(root, 'control.sock'))
    await server.start()
  })
  afterEach(async () => { await server?.stop(); if (root) await rm(root, { recursive: true }) })

  async function run(args: readonly string[], input?: string | Buffer) {
    return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], { cwd: root,
        env: { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined },
        stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('Workspace add CLI did not finish.')) }, 5_000)
      child.stdout.setEncoding('utf8').on('data', data => { stdout += data })
      child.stderr.setEncoding('utf8').on('data', data => { stderr += data })
      child.stdin.on('error', () => {}) // Rejection may close a bounded reader before its writer finishes.
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
      child.stdin.end(input)
    })
  }
  async function file(value: unknown, name = 'input.json') {
    await writeFile(join(root, name), JSON.stringify(value)); return name
  }
  async function raw(fields: unknown) {
    return await new Promise<unknown>((resolve, reject) => {
      const socket = createConnection(server.path); let output = ''
      socket.setEncoding('utf8'); socket.once('connect', () => socket.end(`${JSON.stringify(fields)}\n`))
      socket.on('data', data => { output += data })
      socket.once('end', () => { try { resolve(JSON.parse(output)) } catch (error) { reject(error) } })
      socket.once('error', reject)
    })
  }
  function success(output: { code: number; stdout: string; stderr: string }) {
    expect(output.code, output.stderr).toBe(0); expect(output.stderr).toBe('')
    const receipt = parseAgentMuxControlReceipt(JSON.parse(output.stdout))
    expect(receipt).toMatchObject({ ok: true, operation })
    if (!receipt.ok || receipt.operation !== operation) throw new Error('Expected a workspace add receipt.')
    return receipt
  }
  function rejected(output: { code: number; stdout: string; stderr: string }, code = 'INVALID_CLI_ARGUMENT') {
    expect(output.code).toBe(1); expect(output.stdout).toBe('')
    expect(JSON.parse(output.stderr)).toMatchObject({ ok: false, operation, error: { code } })
  }

  it.each(['file', 'stdin'])('forwards a literal field object through %s and returns the actual owner item', async carrier => {
    const input = { hostId: '--help', path: '~/literal folder/$ENV/$(literal) `literal` ', name: '  explicit name  ' }
    const path = carrier === 'stdin' ? '-' : await file(input, '--help')
    expect(success(await run([...command, '--input', path], carrier === 'stdin' ? JSON.stringify(input) : undefined)).result)
      .toEqual({ item: committed, changed: true })
    expect(seen).toEqual([{ ...base, requestId: expect.any(String), operation, input }])
  })

  it('preserves generic own keys and nested literal JSON instead of defining a host schema or defaults', async () => {
    const input = JSON.parse('{"__proto__":{"literal":"data"},"constructor":"--help","futureField":[null,false,4,{"text":"one\\ntwo"}]}')
    success(await run([...command, '--input', '-'], JSON.stringify(input)))
    const actual = seen[0]
    if (actual?.operation !== operation) throw new Error('Expected the real add request.')
    expect(actual.input).toEqual(input)
    expect(Object.keys(actual.input)).toEqual(['__proto__', 'constructor', 'futureField'])
    expect(Object.hasOwn(actual.input, '__proto__')).toBe(true)
    success(await run([...command, '--input', await file({})]))
    expect(seen[1]).toEqual({ ...base, requestId: expect.any(String), operation, input: {} })
  })

  it.each(['--help', '--input', '-h', 'file with spaces.json'])('treats the input filename %j as literal data', async name => {
    const input = { hostId: 'opaque', path: 'literal path' }
    success(await run([...command, '--input', await file(input, name)]))
    expect(seen).toEqual([{ ...base, requestId: expect.any(String), operation, input }])
  })

  it.each([undefined, '', '  ', '--help'])('leaves optional name %j and the literal path for the owner to interpret', async name => {
    const input = { hostId: 'opaque-host', path: 'relative/path ', ...(name === undefined ? {} : { name }) }
    expect(success(await run([...command, '--input', await file(input)])).result.item).toEqual(committed)
    expect(seen).toEqual([{ ...base, requestId: expect.any(String), operation, input }])
  })

  it('preserves committed identity and the explicit changed=false fact from the owner', async () => {
    changed = false
    expect(success(await run([...command, '--input', await file({ hostId: 'same', path: 'same', name: 'Different requested name' })])).result)
      .toEqual({ item: committed, changed: false })
    expect(seen.map(request => request.operation)).toEqual([operation])
  })

  it.each(['INVALID_SETTING_VALUE', 'CONTROL_UNAVAILABLE', 'CONFIG_CONFLICT', 'CONTROL_FAILED'])('preserves the typed owner failure %s', async code => {
    ownerError = new AgentMuxError('Owned fixture failure.', code)
    rejected(await run([...command, '--input', await file({ hostId: 'opaque', path: 'literal' })]), code)
    expect(seen.map(request => request.operation)).toEqual([operation])
    expect(committed.value.path).toBe('owner literal path ')
  })

  it.each([
    ['settings', 'workspaces'], command, [...command, 'positional-folder'], [...command, '--input'],
    [...command, '--input', '-', 'extra'], [...command, '--input', '-', '--help'],
    [...command, '--input', '-', '--input', '-'], [...command, '--input=-'],
    ['settings', 'workspaces', 'list'], ['settings', 'workspaces', 'get', 'id'],
    ['settings', 'workspaces', 'update', 'id', '--input', '-'], ['settings', 'workspaces', 'remove', 'id']
  ])('rejects unsupported syntax %j before the owner', async (...args) => {
    const output = await run(args, '{}')
    expect(output.code).toBe(1); expect(output.stdout).toBe('')
    expect(JSON.parse(output.stderr)).toMatchObject({ ok: false, error: { code: 'INVALID_CLI_ARGUMENT' } })
    expect(seen).toEqual([])
  })

  it.each([null, false, 4, 'literal', []])('requires a pure JSON field object rather than %j', async value => {
    rejected(await run([...command, '--input', await file(value)]))
    expect(seen).toEqual([])
  })

  it.each(['file', 'stdin'])('rejects unreadable UTF-8/JSON and oversized bytes through the shared %s loader', async carrier => {
    for (const bytes of [
      Buffer.concat([Buffer.from('{"path":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}')]),
      Buffer.from('{"path":'), Buffer.from(' '.repeat(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) + '{}')
    ]) {
      const path = carrier === 'stdin' ? '-' : 'bad.json'
      if (carrier === 'file') await writeFile(join(root, path), bytes)
      rejected(await run([...command, '--input', path], carrier === 'stdin' ? bytes : undefined))
    }
    expect(seen).toEqual([])
  })

  it('rejects an unreadable local input without sending a path or invoking the owner', async () => {
    rejected(await run([...command, '--input', 'missing.json']))
    expect(seen).toEqual([])
  })

  it.each(['file', 'stdin'])('bounds the complete CLI envelope for %s as an argument error', async carrier => {
    const input = JSON.stringify({ path: 'x'.repeat(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES - 40) })
    expect(Buffer.byteLength(input)).toBeLessThan(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES)
    const path = carrier === 'stdin' ? '-' : 'frame.json'
    if (carrier === 'file') await writeFile(join(root, path), input)
    rejected(await run([...command, '--input', path], carrier === 'stdin' ? input : undefined))
    expect(seen).toEqual([])
  })

  it.each([['settings', 'workspaces', '--help'], [...command, '-h']])('prints the correct offline help at %j', async (...args) => {
    await server.stop()
    const output = await run(args)
    expect(output.code).toBe(0); expect(output.stderr).toBe('')
    expect(output.stdout).toContain('settings workspaces add --input <file|->')
    expect(output.stdout).toContain('including trailing spaces'); expect(output.stdout).toContain('Main trims the optional name')
    expect(output.stdout).toContain('changed=false'); expect(output.stdout).toContain('CONTROL_UNAVAILABLE')
    expect(output.stdout).toContain('No managed Agent caller or open View is required')
    expect(seen).toEqual([])
  })

  it('exposes registration in settings discovery and Agent instructions without contacting an owner', async () => {
    await server.stop()
    for (const args of [['settings', '--help'], ['--skill']]) {
      const output = await run(args)
      expect(output.code).toBe(0); expect(output.stderr).toBe('')
      expect(output.stdout).toContain('settings workspaces add --input <file|->')
    }
    expect(seen).toEqual([])
  })

  it('reports an offline owner without directly writing configuration', async () => {
    await server.stop()
    rejected(await run([...command, '--input', await file({ hostId: 'opaque', path: 'literal' }, '--help')]), 'CONTROL_UNAVAILABLE')
    expect(seen).toEqual([]); expect(committed).toEqual({ id: 'owner-assigned-workspace', value: {
      hostId: 'owner-host', path: 'owner literal path ', name: 'Owner-selected name', kind: 'future-host-kind',
      repoPath: '$LITERAL/repository', branch: '--help', hostFact: { retained: true }
    } })
  })

  it.each([
    {}, { input: null }, { input: [] }, { input: false },
    ...['caller', 'path', 'hostId', 'value', 'expected', 'confirm', 'launch'].map(field => ({ input: {}, [field]: 'extra' }))
  ])('rejects a malformed public request %j before the owner', async fields => {
    expect(parseAgentMuxControlReceipt(await raw({ ...base, operation, ...fields })))
      .toMatchObject({ ok: false, operation, error: { code: 'INVALID_CONTROL_REQUEST' } })
    expect(seen).toEqual([])
  })
})

describe('Workspace add protocol transports bounded generic JSON with closed receipts', () => {
  const request = (input: unknown) => ({ ...base, operation, input })
  const receipt = (result: unknown) => ({ ...base, operation, ok: true, result })

  it('derives a nonempty operation set from the public union and preserves actual host-owned fields', () => {
    expect([operation].filter(isAgentMuxControlOperation)).toEqual([operation])
    const input = JSON.parse('{"hostId":"literal","path":"~/literal ","name":" ","kind":"Main validates this","__proto__":{"data":true},"constructor":"data"}')
    const typed: AgentMuxControlSettingsWorkspaceAddRequest = { ...base, operation, input }
    expect(parseAgentMuxControlRequest(typed)).toEqual(typed)
    expect(parseAgentMuxControlReceipt(receipt({ item: committed, changed: true })))
      .toEqual(receipt({ item: committed, changed: true }))
  })

  it.each([
    undefined, null, [], { field: undefined }, { field: NaN }, { field: Infinity }, { field: 1n },
    { field: () => 0 }, { field: new Date() }, { field: Array(1) }, Object.create({ inherited: true }),
    Object.defineProperty({}, 'hidden', { value: true }), { [Symbol('extra')]: true },
    Object.defineProperty({}, 'path', { enumerable: true, get: () => { throw new Error('Do not invoke.') } })
  ])('rejects input that JSON serialization could erase or change (case %#)', input => {
    expect(() => parseAgentMuxControlRequest(request(input))).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
  })

  it('uses the existing eight-container and whole-envelope byte budgets', () => {
    const nested = (levels: number) => JSON.parse(`${'{"field":'.repeat(levels)}0${'}'.repeat(levels)}`)
    expect(parseAgentMuxControlRequest(request(nested(8)))).toEqual(request(nested(8)))
    expect(() => parseAgentMuxControlRequest(request(nested(9)))).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    expect(() => parseAgentMuxControlRequest(request({ path: 'x'.repeat(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES - 40) })))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    expect(() => parseAgentMuxControlReceipt(receipt({ item: { id: 'owner', value: { path: 'x'.repeat(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES - 40) } }, changed: true })))
      .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })

  it.each([
    {}, { item: committed }, { item: committed, changed: 'true' }, { item: committed, changed: true, resource: 'workspaces' },
    { item: null, changed: true }, { item: { id: '', value: {} }, changed: true },
    { item: { id: 'owner', value: [] }, changed: true }, { item: { id: 'owner', value: { id: 'duplicated' } }, changed: true },
    { item: { id: 'owner', value: {}, extra: true }, changed: false }, { item: { id: 'owner', value: { lost: undefined } }, changed: true }
  ])('rejects an incomplete or misleading commit result %j', result => {
    expect(() => parseAgentMuxControlReceipt(receipt(result))).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })

  it('rejects extra public envelope fields instead of silently discarding them', () => {
    expect(() => parseAgentMuxControlRequest({ ...request({}), extra: true }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    expect(() => parseAgentMuxControlReceipt({ ...receipt({ item: committed, changed: false }), inputFile: 'extra' }))
      .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })
})
