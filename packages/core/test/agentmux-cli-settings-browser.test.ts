import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentMuxControlServer, parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from '../src/control-host.js'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, AGENTMUX_CONTROL_SCHEMA_VERSION,
  type AgentMuxControlRequest, type AgentMuxControlResult } from '../src/control.js'

const cli = fileURLToPath(new URL('../bin/agentmux', import.meta.url))
const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'browser-settings-proof' }
const initial: [string, string][] = [['first', 'host-defined-choice'], ['neighbor', 'another-choice']]
const listArgs = ['settings', 'browser', 'links', 'list']
const forgetArgs = ['settings', 'browser', 'links', 'forget']

describe('Browser settings built CLI consumes the public Control owner without a caller or View', () => {
  let root: string, server: AgentMuxControlServer, seen: AgentMuxControlRequest[], answers: Map<string, string>

  beforeEach(async () => {
    root = await mkdtemp('/tmp/amux-browser-settings-cli-')
    seen = []; answers = new Map(initial)
    // Choice vocabulary belongs to the owner. Core must not import a Desktop enum.
    server = new AgentMuxControlServer({ async execute(request): Promise<AgentMuxControlResult> {
      seen.push(request)
      if (request.operation === 'settings.browser.links.list') {
        return { operation: request.operation, entries: [...answers].map(([scheme, choice]) => ({ scheme, choice })) }
      }
      if (request.operation === 'settings.browser.links.forget') {
        return { operation: request.operation, scheme: request.scheme, changed: answers.delete(request.scheme) }
      }
      throw new Error(`Unexpected ${request.operation}`)
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
      const timer = setTimeout(() => { child.kill(); reject(new Error('Browser settings CLI did not finish.')) }, 5_000)
      child.stdout.setEncoding('utf8').on('data', data => { stdout += data })
      child.stderr.setEncoding('utf8').on('data', data => { stderr += data })
      child.stdin.on('error', () => {}) // A rejected bounded input may close before the writer finishes.
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
      child.stdin.end(input)
    })
  }
  async function file(value: unknown, name = 'input.json') { await writeFile(join(root, name), JSON.stringify(value)); return name }
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
    const receipt = parseAgentMuxControlReceipt(JSON.parse(output.stdout)); expect(receipt.ok).toBe(true)
    if (!receipt.ok) throw new Error('Expected a successful receipt.')
    return receipt
  }

  it('lists a nonempty opaque choice vocabulary, forgets the processing-time answer and reports absent nochange', async () => {
    expect(success(await run(listArgs)).result).toEqual({ entries: initial.map(([scheme, choice]) => ({ scheme, choice })) })
    answers.set('first', 'a newer current answer')
    expect(success(await run([...forgetArgs, 'first'])).result).toEqual({ scheme: 'first', changed: true })
    expect(success(await run([...forgetArgs, 'first'])).result).toEqual({ scheme: 'first', changed: false })
    expect([...answers]).toEqual([initial[1]])
    expect(seen.map(({ requestId, ...request }) => request)).toEqual([
      { schemaVersion: base.schemaVersion, operation: 'settings.browser.links.list' },
      { schemaVersion: base.schemaVersion, operation: 'settings.browser.links.forget', scheme: 'first' },
      { schemaVersion: base.schemaVersion, operation: 'settings.browser.links.forget', scheme: 'first' }
    ])
    answers.clear()
    expect(success(await run(listArgs)).result).toEqual({ entries: [] })
  })

  it.each(['--help', '-h', '--input', '', '  ', 'Mixed:scheme', '  padded  ', '__proto__', 'constructor', '$HOME $(literal) `literal`', 'line\nbreak'])('preserves one positional scheme %j as literal data', async scheme => {
    answers.set(scheme, 'opaque')
    expect(success(await run([...forgetArgs, scheme])).result).toEqual({ scheme, changed: true })
    expect([...answers]).toEqual(initial)
    expect(seen).toEqual([{ ...base, requestId: expect.any(String), operation: 'settings.browser.links.forget', scheme }])
  })

  it.each(['file', 'stdin'])('round-trips a listed NUL key through bounded JSON %s, preserving its neighbor', async carrier => {
    const scheme = 'short\0stored:key'; answers.set(scheme, 'opaque literal answer')
    const listed = success(await run(listArgs))
    if (listed.operation !== 'settings.browser.links.list') throw new Error('Expected a link list.')
    expect(listed.result.entries).toEqual([...initial, [scheme, 'opaque literal answer']].map(([scheme, choice]) => ({ scheme, choice })))
    const exact = listed.result.entries.find(entry => entry.scheme === scheme)!.scheme
    const input = { scheme: exact }, path = carrier === 'stdin' ? '-' : await file(input, '--help')
    expect(success(await run([...forgetArgs, '--input', path], carrier === 'stdin' ? JSON.stringify(input) : undefined)).result)
      .toEqual({ scheme, changed: true })
    expect(success(await run([...forgetArgs, '--input', path], carrier === 'stdin' ? JSON.stringify(input) : undefined)).result)
      .toEqual({ scheme, changed: false })
    expect([...answers]).toEqual(initial)
    expect(seen.slice(1).map(({ requestId, ...request }) => request)).toEqual([
      { schemaVersion: base.schemaVersion, operation: 'settings.browser.links.forget', scheme },
      { schemaVersion: base.schemaVersion, operation: 'settings.browser.links.forget', scheme }
    ])
  })

  it.each([
    ['settings', 'browser'], ['settings', 'browser', 'links'], [...listArgs, 'extra'], [...listArgs, '--input', '-'],
    forgetArgs, [...forgetArgs, 'first', 'extra'], [...forgetArgs, 'first', '--input', '-'],
    [...forgetArgs, '--input', '-', '--input', '-'], [...forgetArgs, '--input', '-', '--help'],
    [...forgetArgs, '--help', 'extra'], ['settings', 'browser', 'links', 'set', 'first', 'allow'],
    ['settings', 'browser', 'links', 'allow', 'first'], ['settings', 'browser', 'links', 'deny', 'first']
  ])('rejects extra/mixed syntax and choice setters %j before the owner', async (...args) => {
    const output = await run(args, '{"scheme":"first"}')
    expect(output.code).toBe(1); expect(output.stdout).toBe('')
    expect(JSON.parse(output.stderr)).toMatchObject({ ok: false, error: { code: 'INVALID_CLI_ARGUMENT' } })
    expect(seen).toEqual([]); expect([...answers]).toEqual(initial)
  })

  it.each([
    null, [], {}, { scheme: false }, { scheme: 1 }, { scheme: null }, { scheme: [] }, { scheme: {} },
    { scheme: 'first', choice: 'allow' }, { scheme: 'first', expected: 'old' }, { scheme: 'first', confirm: true },
    JSON.parse('{"scheme":"first","__proto__":"extra"}'), { scheme: 'first', constructor: 'extra' }
  ])('requires exactly the string scheme input envelope %j', async input => {
    const output = await run([...forgetArgs, '--input', await file(input)])
    expect(output.code).toBe(1); expect(output.stdout).toBe('')
    expect(JSON.parse(output.stderr)).toMatchObject({ ok: false, operation: 'settings.browser.links.forget', error: { code: 'INVALID_CLI_ARGUMENT' } })
    expect(seen).toEqual([]); expect([...answers]).toEqual(initial)
  })

  it.each(['file', 'stdin'])('rejects non-UTF-8 and malformed JSON through the shared %s reader', async carrier => {
    for (const bytes of [Buffer.concat([Buffer.from('{"scheme":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}')]), Buffer.from('{"scheme":')]) {
      const path = carrier === 'stdin' ? '-' : 'bad.json'
      if (carrier === 'file') await writeFile(join(root, path), bytes)
      const output = await run([...forgetArgs, '--input', path], carrier === 'stdin' ? bytes : undefined)
      expect(output.code).toBe(1); expect(output.stdout).toBe('')
      expect(JSON.parse(output.stderr)).toMatchObject({ ok: false, error: { code: 'INVALID_CLI_ARGUMENT' } })
    }
    expect(seen).toEqual([]); expect([...answers]).toEqual(initial)
  })

  it.each(['file', 'stdin'])('enforces the shared byte budget on %s even before small valid JSON', async carrier => {
    const oversized = ' '.repeat(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) + '{"scheme":"first"}'
    const path = carrier === 'stdin' ? '-' : 'large.json'
    if (carrier === 'file') await writeFile(join(root, path), oversized)
    const output = await run([...forgetArgs, '--input', path], carrier === 'stdin' ? oversized : undefined)
    expect(output.code).toBe(1); expect(output.stdout).toBe('')
    expect(JSON.parse(output.stderr)).toMatchObject({ ok: false, error: { code: 'INVALID_CLI_ARGUMENT' } })
    expect(seen).toEqual([]); expect([...answers]).toEqual(initial)
  })

  it.each(['file', 'stdin'])('classifies the full CLI request budget as an argument error for %s before its owner', async carrier => {
    const input = JSON.stringify({ scheme: 'x'.repeat(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES - 40) })
    expect(Buffer.byteLength(input)).toBeLessThan(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES)
    const path = carrier === 'stdin' ? '-' : 'frame.json'
    if (carrier === 'file') await writeFile(join(root, path), input)
    const output = await run([...forgetArgs, '--input', path], carrier === 'stdin' ? input : undefined)
    expect(output.code).toBe(1); expect(output.stdout).toBe('')
    expect(JSON.parse(output.stderr)).toMatchObject({ ok: false, operation: 'settings.browser.links.forget', error: { code: 'INVALID_CLI_ARGUMENT' } })
    expect(seen).toEqual([]); expect([...answers]).toEqual(initial)
  })

  it('rejects an unreadable local file before the owner and never forwards its path', async () => {
    const output = await run([...forgetArgs, '--input', 'missing.json'])
    expect(output.code).toBe(1); expect(output.stdout).toBe('')
    expect(JSON.parse(output.stderr)).toMatchObject({ ok: false, error: { code: 'INVALID_CLI_ARGUMENT' } })
    expect(seen).toEqual([]); expect([...answers]).toEqual(initial)
  })

  it.each([
    ['settings', 'browser', '--help'], ['settings', 'browser', 'links', '-h'], [...listArgs, '--help']
  ])('prints honest offline help at syntax position %j', async (...args) => {
    await server.stop(); const output = await run(args)
    expect(output.code).toBe(0); expect(output.stderr).toBe('')
    expect(output.stdout).toContain('current Unix user'); expect(output.stdout).toContain('expands browser access')
    expect(output.stdout).toContain('does not establish human approval'); expect(output.stdout).toContain('CONTROL_UNAVAILABLE')
    expect(output.stdout).toContain('exactly {"scheme": string}'); expect(output.stdout).toContain('There is no choice setter')
    expect(seen).toEqual([])
  })

  it('includes links and configuration authority in settings discovery and Agent instructions', async () => {
    for (const args of [['settings', '--help'], ['settings', 'set', '--help'], ['--skill']]) {
      const output = await run(args); expect(output.code).toBe(0)
      expect(output.stdout).toContain('current Unix user'); expect(output.stdout).toContain('does not establish human approval')
    }
    const skill = await run(['--skill'])
    expect(skill.stdout).toContain('settings browser links forget --input <file|->'); expect(seen).toEqual([])
  })

  it('reports an offline owner for list and literal help forget without a local write fallback', async () => {
    await server.stop()
    for (const args of [listArgs, [...forgetArgs, '--help'], [...forgetArgs, '--input', await file({ scheme: 'first' })]]) {
      const output = await run(args); expect(output.code).toBe(1); expect(output.stdout).toBe('')
      expect(parseAgentMuxControlReceipt(JSON.parse(output.stderr))).toMatchObject({ ok: false,
        operation: args === listArgs ? 'settings.browser.links.list' : 'settings.browser.links.forget', error: { code: 'CONTROL_UNAVAILABLE' } })
    }
    expect(seen).toEqual([]); expect([...answers]).toEqual(initial)
  })

  it.each([
    { operation: 'settings.browser.links.list', scheme: 'extra' },
    { operation: 'settings.browser.links.forget' }, { operation: 'settings.browser.links.forget', scheme: false },
    ...['choice', 'expected', 'confirm', 'path', 'input', 'caller'].map(field => ({ operation: 'settings.browser.links.forget', scheme: 'first', [field]: 'extra' }))
  ])('rejects malformed public wire before the owner %j', async fields => {
    expect(parseAgentMuxControlReceipt(await raw({ ...base, ...fields }))).toMatchObject({ ok: false,
      operation: fields.operation, error: { code: 'INVALID_CONTROL_REQUEST' } })
    expect(seen).toEqual([]); expect([...answers]).toEqual(initial)
  })

  it('rejects unknown public choice-setting operations instead of accepting a hidden setter', async () => {
    expect(await raw({ ...base, operation: 'settings.browser.links.set', scheme: 'first', choice: 'allow' }))
      .toMatchObject({ ok: false, operation: null, error: { code: 'INVALID_CONTROL_REQUEST' } })
    expect(seen).toEqual([]); expect([...answers]).toEqual(initial)
  })
})

describe('Browser link protocol keeps bounded literal text and strict primitive receipts', () => {
  const request = (scheme: unknown) => ({ ...base, operation: 'settings.browser.links.forget', scheme })
  const receipt = (operation: string, result: unknown) => ({ ...base, ok: true, operation, result })
  const list = (result: unknown) => receipt('settings.browser.links.list', result)
  const forget = (result: unknown) => receipt('settings.browser.links.forget', result)

  it.each(['', '  ', 'mixed:scheme', 'short\0key', 'x'.repeat(600)])('uses text semantics rather than the ID helper for %j', scheme => {
    expect(parseAgentMuxControlRequest(request(scheme))).toEqual(request(scheme))
    expect(parseAgentMuxControlReceipt(forget({ scheme, changed: false }))).toEqual(forget({ scheme, changed: false }))
    expect(parseAgentMuxControlReceipt(list({ entries: [{ scheme, choice: 'host-owned opaque choice' }] })))
      .toEqual(list({ entries: [{ scheme, choice: 'host-owned opaque choice' }] }))
  })

  it('bounds the whole request and aggregate receipt, including JSON escaping', () => {
    expect(() => parseAgentMuxControlRequest(request('x'.repeat(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES - 20))))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    expect(() => parseAgentMuxControlReceipt(list({ entries: [
      { scheme: 'one', choice: 'x'.repeat(150_000) }, { scheme: 'two', choice: 'y'.repeat(150_000) }
    ] }))).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })

  it.each([
    list({}), list({ entries: null }), list({ entries: [] , extra: true }), list({ entries: Array(1) }),
    list({ entries: [{ scheme: 'one', choice: false }] }), list({ entries: [{ scheme: 'one', choice: 'host', expected: 'old' }] }),
    list({ entries: [{ scheme: 'one', choice: 'a' }, { scheme: 'one', choice: 'b' }] }),
    forget({ scheme: 'one' }), forget({ scheme: 1, changed: true }), forget({ scheme: 'one', changed: 'true' }),
    forget({ scheme: 'one', changed: false, choice: 'allow' }), { ...forget({ scheme: 'one', changed: true }), path: 'extra' }
  ])('rejects misleading or lossy wire facts %j', value => {
    expect(() => parseAgentMuxControlReceipt(value)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })

  it('admits an explicit empty list and arbitrary string choices without defining a host enum', () => {
    const entries = [{ scheme: '', choice: '' }, { scheme: 'constructor', choice: 'future owner choice' }]
    expect(parseAgentMuxControlReceipt(list({ entries }))).toEqual(list({ entries }))
    expect(parseAgentMuxControlReceipt(list({ entries: [] }))).toEqual(list({ entries: [] }))
  })

  it('rejects hidden/accessor/symbol fields before invocation or serialization can erase them', () => {
    for (const value of [
      Object.defineProperty(request('first'), 'choice', { value: 'extra' }),
      Object.defineProperty({ ...base, operation: 'settings.browser.links.forget' }, 'scheme', { enumerable: true, get: () => { throw new Error('Do not invoke.') } }),
      { ...request('first'), [Symbol('extra')]: true }
    ]) expect(() => parseAgentMuxControlRequest(value)).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
  })
})
