import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentMuxControlServer, parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from '../src/control-host.js'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '../src/control.js'
import { focusFacts } from './fixtures/desktop-focus-facts.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'

const cli = process.env.AGENTMUX_TEST_DESKTOP_FOCUS_CLI ?? fileURLToPath(new URL('../bin/agentmux', import.meta.url))
const base = { schemaVersion: 5, requestId: 'desktop-navigation' }
const spaceId = JSON.stringify(['local', '/repository literal $PATH/with spaces/' + 'long-directory/'.repeat(70)])
const zoneId = JSON.stringify([spaceId, 'zone', 'existing-directory'])
describe('public Desktop focus and client inspection', () => {
  let root: string, server: AgentMuxControlServer, seen: AgentMuxControlRequest[]
  beforeEach(async () => {
    root = await mkdtemp('/tmp/amx-desktop-focus-cli-'); seen = []
    server = new AgentMuxControlServer({ async execute(request): Promise<AgentMuxControlResult> {
      seen.push(request)
      if (request.operation === 'focus') return focusFacts(request)
      if (request.operation === 'inspect.client') return { operation: request.operation,
        observation: { schema: 'private-client', source: 'mock', unknown: true } }
      throw new Error(`Unexpected mutation/Runtime operation: ${request.operation}`)
    } }, join(root, 'control.sock'))
    await server.start()
  })
  afterEach(async () => { await server.stop(); await rm(root, { recursive: true }) })
  async function run(args: readonly string[]) {
    return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
        AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json') } })
      let stdout = '', stderr = ''
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      child.once('error', reject); child.once('close', code => resolve({ code: code ?? -1, stdout, stderr }))
    })
  }
  async function json(args: readonly string[], code = 0) {
    const result = await run(args)
    expect(result.code, result.stderr).toBe(code)
    const output = code === 0 ? result.stdout : result.stderr
    expect(code === 0 ? result.stderr : result.stdout).toBe('')
    expect(output.trim().split('\n')).toHaveLength(1)
    return JSON.parse(output)
  }
  it('uses literal hierarchical IDs, defaults input preserve and keeps partial/candidates in the final receipt', async () => {
    const raw = await json(['focus', '--space', spaceId, '--zone', zoneId, '--tab', 'tab', '--region', '--help'])
    const request = seen[0]
    expect(seen).toHaveLength(1)
    expect(request).toEqual({ ...base, requestId: expect.any(String), operation: 'focus',
      target: { kind: 'space', spaceId, zoneId, tabId: 'tab', regionId: '--help' }, inputPolicy: 'preserve' })
    if (request?.operation !== 'focus') throw new Error('Expected focus')
    const { operation: _, ...expected } = focusFacts(request)
    expect(parseAgentMuxControlReceipt(raw)).toEqual({ ...base, requestId: request.requestId, ok: true, operation: 'focus', result: expected })
  })
  it.each([['--space', spaceId], ['--zone', zoneId], ['--tab', 'tab'], ['--region', 'region']])('accepts an exact %s identity without caller/focus inference', async (flag, id) => {
    await json(['focus', flag, id, '--input', 'preserve'])
    expect(seen).toEqual([{ ...base, requestId: expect.any(String), operation: 'focus', target: { kind: 'space', [`${flag.slice(2)}Id`]: id }, inputPolicy: 'preserve' }])
  })
  it('transports exact Goal and each existing Surface without an Agent launch/send', async () => {
    await json(['focus', '--goal', '--help'])
    for (const surface of ['space', 'focus', 'goals', 'survey']) await json(['focus', '--surface', surface])
    expect(seen.map(request => request.operation)).toEqual(['focus', 'focus', 'focus', 'focus', 'focus'])
    expect(seen[0]).toMatchObject({ target: { kind: 'goal', goalId: '--help' }, inputPolicy: 'preserve' })
    expect(seen.slice(1).map(request => request.operation === 'focus' && request.target)).toEqual(
      ['space', 'focus', 'goals', 'survey'].map(surface => ({ kind: 'surface', surface })))
  })
  it('allows explicit input target only for exact existing Tab/Region selectors', async () => {
    await json(['focus', '--tab', 'tab', '--input', 'target'])
    await json(['focus', '--region', 'region', '--input', 'target'])
    expect(seen.map(request => request.operation === 'focus' && request.inputPolicy)).toEqual(['target', 'target'])
  })
  it('exposes the existing read-only inspect.client operation without connecting to a Run', async () => {
    const receipt = await json(['inspect', '--client'])
    expect(receipt).toMatchObject({ ok: true, operation: 'inspect.client', result: { observation: { schema: 'private-client', source: 'mock', unknown: true } } })
    expect(seen).toEqual([{ ...base, requestId: expect.any(String), operation: 'inspect.client' }])
  })
  it('rejects repeated/unknown flags, parentless or mixed goals/surfaces, and guessed input owners before the owner runs', async () => {
    const invalid = [[], ['--space', ''], ['--goal', ''], ['--tab', 'self'], ['--region', 'R', '--tab', 'T', '--goal', 'G'],
      ['--surface', 'goals', '--zone', 'Z'], ['--surface', 'unknown'], ['--region', 'R', '--region', 'R'], ['--region', 'R', '--bogus'],
      ['--region', 'R', 'extra'], ['--input', 'preserve'], ['--goal', 'G', '--input', 'target'], ['--surface', 'space', '--input', 'target'],
      ['--zone', 'Z', '--input', 'target'], ['--region', 'R', '--input', 'unknown']]
    expect(invalid).toHaveLength(15)
    for (const args of invalid) expect(await json(['focus', ...args], 1)).toMatchObject({ ok: false, error: { code: 'INVALID_CLI_ARGUMENT' } })
    for (const args of [['--client', '--tab', 'T'], ['--client', '--client'], ['--client=true'], ['--client', 'extra']]) {
      expect(await json(['inspect', ...args], 1)).toMatchObject({ ok: false, error: { code: 'INVALID_CLI_ARGUMENT' } })
    }
    expect(seen).toEqual([])
  }, 30_000)
  it('strictly validates wire requests and fact receipts, including secrets and false confirmations', () => {
    const request = { ...base, operation: 'focus', target: { kind: 'space', regionId: 'region' }, inputPolicy: 'preserve' }
    expect(parseAgentMuxControlRequest(request)).toEqual(request)
    expect(() => parseAgentMuxControlRequest({ ...request, inputPolicy: undefined })).toThrow()
    const result = focusFacts(request as never); const { operation: _, ...body } = result
    const receipt = { ...base, operation: 'focus', ok: true, result: body }
    expect(parseAgentMuxControlReceipt(receipt)).toMatchObject({ result: { partial: true, issues: body.issues } })
    expect(body.issues[0]?.candidates).toHaveLength(1)
    // Protocol-only synthetic confirmed facts: the parser must preserve false as faithfully
    // as partial=true. Actual DOM confirmation belongs to the Desktop/Native consumers.
    const complete = { ...receipt, result: { ...body, partial: false, issues: [],
      presentation: { ...body.presentation, provenance: 'observed', state: 'main-visible' },
      input: { ...body.input, outcome: 'preserved' } } }
    expect(parseAgentMuxControlReceipt(complete)).toMatchObject({ result: { partial: false, issues: [] } })
    const invalid = [
      { ...receipt, result: { ...body, partial: false } },
      { ...receipt, result: { ...body, input: { ...body.input, before: { ...body.input.before, value: 'secret draft' } } } },
      { ...receipt, result: { ...body, presentation: { ...body.presentation, state: 'main-visible' } } },
      { ...receipt, result: { ...body, navigation: { ...body.navigation, selection: { ...body.navigation.selection, space: { ...body.navigation.selection.space, regionId: 'other' } } } } },
      { ...receipt, result: { ...body, issues: [{ ...body.issues[0], candidates: [{ zoneId, cwd: '/invented' }] }] } }
    ]
    expect(invalid).toHaveLength(5)
    for (const value of invalid) expect(() => parseAgentMuxControlReceipt(value)).toThrow()
    expect(() => parseAgentMuxControlRequest({ ...request, target: { kind: 'region', regionId: 'region' } })).toThrow()
    expect(() => parseAgentMuxControlRequest({ ...request, target: { ...request.target, secret: 'draft' } })).toThrow()
    expect(() => parseAgentMuxControlRequest({ ...request, target: { kind: 'goal', goalId: 'G', spaceId } })).toThrow()
  })
  it.each(['rejected', 'unconfirmed'])('rejects transferred input for %s navigation even when the old selection matches the input', state => {
    const { operation, ...body } = focusFacts({ ...base, schemaVersion: 5, operation: 'focus',
      target: { kind: 'space', regionId: 'old-region' }, inputPolicy: 'target' })
    const receipt = { ...base, operation, ok: true, result: { ...body, partial: true,
      navigation: { ...body.navigation, state, requested: { kind: 'space', regionId: 'different-requested-region' } },
      input: { ...body.input, outcome: 'transferred', after: { ...body.input.after,
        tabId: body.navigation.selection.space!.tabId, regionId: 'old-region' } } } }
    expect(() => parseAgentMuxControlReceipt(receipt)).toThrow('confirmation is inconsistent')
  })
  it.each(['tabId', 'regionId'] as const)('rejects confirmed presentation of a different %s through the compiled public parser', async key => {
    const { parseAgentMuxControlReceipt: compiledParse } = await import('../dist/control-host.js')
    const { operation, ...body } = focusFacts({ ...base, schemaVersion: 5, operation: 'focus',
      target: { kind: 'space', regionId: 'target-region' }, inputPolicy: 'preserve' })
    const receipt = { ...base, operation, ok: true, result: { ...body, partial: false, issues: [],
      presentation: { ...body.presentation, provenance: 'observed', state: 'main-visible' },
      input: { ...body.input, outcome: 'preserved' } } }
    expect(compiledParse(receipt)).toMatchObject({ result: { partial: false, presentation: receipt.result.presentation } })
    expect(() => compiledParse({ ...receipt, result: { ...receipt.result,
      presentation: { ...receipt.result.presentation, [key]: `different-${key}` } } })).toThrow('presented identities disagree')
    expect(compiledParse({ ...receipt, result: { ...receipt.result, partial: true,
      presentation: { ...receipt.result.presentation, state: 'pending', [key]: `unconfirmed-${key}` } } })).toMatchObject({ result: { partial: true } })
  })
  it('documents navigation, factual inspection, exact input transfer and the default preserve policy', () => {
    expect(agentMuxCommandHelp('focus')).toContain('--goal <demand-id>')
    expect(agentMuxCommandHelp('focus')).toContain('Default --input preserve')
    expect(agentMuxCommandHelp('focus')).toContain('--input target')
    expect(agentMuxCommandHelp('inspect')).toContain('inspect --client')
  })
})
