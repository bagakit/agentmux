import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AGENTMUX_CLI_COMMANDS } from '../src/agentmux-cli-commands.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxError } from '../src/errors.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

let root: string
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'sd-')) })
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })
const run = (args: readonly string[], input = '') => runCompiledObjectCli(args, objectCliEnvironment(root), input)
const commands = AGENTMUX_CLI_COMMANDS.filter(command => command.method.startsWith('schedule.'))

describe('compiled schedule discovery and invocation', () => {
  it('prints one usable syntax with parser-accurate inputs in every discovery surface', async () => {
    expect(commands).toHaveLength(6)
    const [catalog, surface] = await Promise.all([run(['--help']), run(['schedule', '--help'])])
    expect(catalog.code, catalog.stderr).toBe(0)
    expect(catalog.stdout.split('\n').map(line => line.trim())).toContain('amux schedule')
    expect(surface.code, surface.stderr).toBe(0)
    for (const command of commands) {
      let acceptsEmpty = false
      try { await command.parse([]); acceptsEmpty = true } catch (error) {
        expect(error).toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
      }
      const syntax = 'amux ' + command.method.replaceAll('.', ' ') +
        (acceptsEmpty ? ' [--data <FILE|->]' : ' --data <FILE|->')
      const lines = surface.stdout.split('\n').map(line => line.trim())
      expect(lines.filter(line => line.startsWith('amux ' + command.method.replaceAll('.', ' ') + ' '))).toEqual([syntax])
      const leaf = await run([...command.method.split('.'), '--help'])
      expect(leaf.code, leaf.stderr).toBe(0)
      expect(leaf.stdout.split('\n').find(line => line.startsWith('Usage: '))).toBe('Usage: ' + syntax)
      expect(leaf.stdout).toContain(command.details)
    }
    const guide = await run(['schedule', '--skill'])
    expect(guide.code, guide.stderr).toBe(0)
    expect(guide.stdout).toContain('The scheduler owns schedule identity')
    expect(guide.stdout).toContain('amux schedule --help')
    // Help is available offline and does not create state or start a service.
    expect(await readdir(root)).toEqual([])
  })

  it('rejects missing required data before contacting an owner', async () => {
    const required = commands.filter(command => command.method !== 'schedule.list')
    expect(required).toHaveLength(5)
    for (const command of required) {
      const result = await run(command.method.split('.'))
      expect(result.code).toBe(1)
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: { code: 'INVALID_CLI_ARGUMENT' } })
    }
    expect(await readdir(root)).toEqual([])
  })

  it('rejects invalid relative timing through the actual CLI before contacting an owner', async () => {
    const target = { hostId: 'local', agentSessionId: 'original', providerId: 'generic', workspacePath: new URL('private/original', new URL('/', import.meta.url)).pathname }
    for (const timing of [{ afterMs: 0 }, { afterMs: -1 }, { afterMs: 1.5 }, { afterMs: Number.MAX_SAFE_INTEGER + 1 }, { afterMs: 90000, calendar: {} }, { afterMs: 90000, checkIn: {} }]) {
      const result = await run(['schedule', 'create', '--data', '-'], JSON.stringify({ target, prompt: 'original work', operationId: 'invalid-original', ...timing }))
      expect(result.code).toBe(1)
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: { code: 'INVALID_CONTROL_REQUEST' } })
    }
    expect(await readdir(root)).toEqual([])
  })

  it('uses the original dispatcher for listed syntax and preserves unavailable owner detail', async () => {
    const detail = 'Saved arrangements remain available; this private reader is unavailable.'
    const owner = new AgentMuxControlServer({ socketPath: join(root, 'schedule.sock'), schedules: {
      call: async () => { throw new AgentMuxError('Arrangement observation is unavailable.', 'CONTROL_UNAVAILABLE', detail) }
    } })
    const calls = vi.spyOn(AgentMuxRpcService.prototype, 'call')
    try {
      await owner.start()
      const endpoint = ['--endpoint', `unix:${owner.path}`]
      const list = await run([...endpoint, 'schedule', 'list'])
      expect(list.code).toBe(1)
      expect(JSON.parse(list.stderr)).toMatchObject({ ok: false, operation: 'schedule.list',
        error: { code: 'CONTROL_UNAVAILABLE', detail } })
      expect(calls).toHaveBeenNthCalledWith(1, 'schedule.list', {},
        expect.objectContaining({ transport: 'unix', principal: expect.objectContaining({ kind: 'user' }) }))
      const params = { scheduleId: 'literal --help arrangement' }
      const inspect = await run([...endpoint, 'schedule', 'inspect', '--data', '-'], JSON.stringify(params))
      expect(inspect.code).toBe(1)
      expect(JSON.parse(inspect.stderr)).toMatchObject({ ok: false, operation: 'schedule.inspect',
        error: { code: 'CONTROL_UNAVAILABLE', detail } })
      expect(calls).toHaveBeenNthCalledWith(2, 'schedule.inspect', params,
        expect.objectContaining({ transport: 'unix', principal: expect.objectContaining({ kind: 'user' }) }))
      const timer = { target: { hostId: 'local', agentSessionId: 'original', providerId: 'generic', workspacePath: new URL('private/original', new URL('/', import.meta.url)).pathname }, afterMs: 90000, prompt: 'same original work', operationId: 'same-timer' }
      const create = await run([...endpoint, 'schedule', 'create', '--data', '-'], JSON.stringify(timer))
      expect(create.code).toBe(1)
      expect(JSON.parse(create.stderr)).toMatchObject({ ok: false, operation: 'schedule.create', error: { code: 'CONTROL_UNAVAILABLE', detail } })
      expect(calls).toHaveBeenNthCalledWith(3, 'schedule.create', timer, expect.objectContaining({ transport: 'unix', principal: expect.objectContaining({ kind: 'user' }) }))
      expect(calls).toHaveBeenCalledTimes(3)
    } finally { calls.mockRestore(); await owner.stop() }
  })
})
