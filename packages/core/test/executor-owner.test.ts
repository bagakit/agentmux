import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../src/control-host.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import type { AgentExecutorConfig } from '../src/types.js'

const exec = promisify(execFile)
const roots: string[] = []
const catalog = new AgentProviderRegistry().catalog().filter(provider => ['codex', 'claude'].includes(provider.id))
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(runtimeId = 'target-runtime') {
  const root = await mkdtemp(join(tmpdir(), 'amux-executor-owner-')); roots.push(root)
  const bin = join(root, 'bin'), path = join(root, 'host-executors.json')
  await mkdir(bin)
  return { root, bin, path, owner: new AgentMuxHostExecutorOwner({ path, runtimeId, catalog: () => catalog, environment: () => ({ PATH: bin }) }) }
}
async function executable(path: string, contents = '#!/bin/sh\nprintf "%s\\n" "$PWD" "$OWNER_SECRET"\n') {
  await writeFile(path, contents); await chmod(path, 0o755)
  return path
}
function config(command: string, overrides: Partial<AgentExecutorConfig> = {}): AgentExecutorConfig {
  return { label: 'Target wrapper', providerId: 'codex', command, args: [], env: {}, injectAgentMuxGuide: true, ...overrides }
}

describe('target Host Executor owner', () => {
  it('discovers only target Provider defaults and distinguishes unchecked, available and missing without writing configuration', async () => {
    const f = await fixture()
    const bin = await executable(join(f.bin, 'codex'))
    expect((await f.owner.list()).executors.map(item => [item.executorId, item.availability])).toEqual([['codex', 'unknown'], ['claude', 'unknown']])
    expect(await f.owner.list({ refresh: true })).toMatchObject({ runtimeId: 'target-runtime', executors: [
      { executorId: 'codex', source: 'provider-default', command: 'codex', executable: bin, availability: 'available' },
      { executorId: 'claude', source: 'provider-default', command: 'claude', availability: 'missing' }
    ] })
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains a growing registry over former count and byte caps through restart, public RPC and the actual CLI', async () => {
    const f = await fixture()
    const values = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [
      `wrapper-${index}`, config('codex', { env: { PRIVATE_VALUE: 'x'.repeat(4096) } })
    ]))
    await writeFile(f.path, JSON.stringify({ schema: 'agentmux.host-executors.v1', runtimeId: 'target-runtime', executors: values }))
    expect((await stat(f.path)).size).toBeGreaterThan(1024 * 1024)
    await f.owner.configure({ executorId: 'next-wrapper', config: config('codex') })
    const reopened = new AgentMuxHostExecutorOwner({ path: f.path, runtimeId: 'target-runtime', catalog: () => catalog })
    expect((await reopened.resolve('wrapper-299')).config).toEqual(values['wrapper-299'])
    const server = new AgentMuxControlServer({ execute: async request => {
      if (request.operation !== 'list.agents') throw new Error('Only Executor inventory is requested')
      const inventory = await reopened.list()
      return { operation: 'list.agents', agents: inventory.executors.map(({ executorId, label, providerId, availability }) => ({ executorId, label, providerId, availability })) }
    } }, join(f.root, 'control.sock'))
    await server.start()
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    try {
      const observed = await rpc.call('app.snapshot', { include: ['executors'], limit: 500 })
      expect(observed.unavailable).toEqual([])
      expect(observed.executors).toHaveLength(303)
      expect(observed.executors.at(-1)?.executorId).toBe('next-wrapper')
      const result = await exec(process.execPath, [resolve('packages/core/bin/agentmux'), '--endpoint', `unix:${server.path}`, 'app', 'snapshot', '--include', 'executors', '--limit', '500'], {
        env: { ...process.env, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined, AGENTMUX_RUNTIME_DIRECTORY: f.root, AGENTMUX_ENV: undefined }, timeout: 5000
      })
      expect(JSON.parse(result.stdout).result.executors).toEqual(observed.executors)
      expect(JSON.stringify(observed)).not.toContain('PRIVATE_VALUE')
    } finally { await rpc.dispose(); await server.stop() }
  })

  it('keeps same-ID configurations and execution on their exact Host, using registered PATH instead of the service PATH', async () => {
    const first = await fixture('first-host'), second = await fixture('second-host')
    const firstPath = await executable(join(first.bin, 'custom-command')), secondPath = await executable(join(second.bin, 'custom-command'))
    // A different executable exists on the first service PATH. The second registration must win.
    const secondOnFirst = new AgentMuxHostExecutorOwner({ path: second.path, runtimeId: 'second-host', catalog: () => catalog,
      environment: () => ({ PATH: first.bin }) })
    await first.owner.configure({ executorId: 'same', config: config('custom-command', { env: { PATH: first.bin, OWNER_SECRET: 'first-secret' } }) })
    const registration = await secondOnFirst.configure({ executorId: 'same', config: config('custom-command', {
      args: ['private-argument'], env: { PATH: second.bin, OWNER_SECRET: 'second-secret' }
    }) })
    expect(JSON.stringify(registration)).not.toMatch(/second-secret|private-argument|"env"|"args"/)
    const a = await first.owner.resolve('same'), b = await secondOnFirst.resolve('same')
    expect(a.config.command).toBe(firstPath); expect(b.config.command).toBe(secondPath)
    expect(b.descriptor).toMatchObject({ command: 'custom-command', executable: secondPath, source: 'registered', availability: 'available' })
    expect(a.descriptor.configRevision).not.toBe(b.descriptor.configRevision)
    const process = await exec(b.config.command, b.config.args, { cwd: second.root, env: b.config.env })
    expect(process.stdout).toBe(`${await realpath(second.root)}\nsecond-secret\n`)
    expect(JSON.stringify(await secondOnFirst.list({ refresh: true }))).not.toMatch(/second-secret|private-argument|"env"|"args"/)
  })

  it('persists complete wrapper configuration across owner restart, with private file permissions and stable revisions', async () => {
    const f = await fixture(), command = await executable(join(f.bin, 'wrapper'))
    const value = config(command, { env: { Z: 'last', A: 'secret' }, args: ['--literal'] })
    const saved = await f.owner.configure({ executorId: 'wrapper', config: value })
    expect((await stat(f.path)).mode & 0o777).toBe(0o600)
    const reopened = new AgentMuxHostExecutorOwner({ path: f.path, runtimeId: 'target-runtime', catalog: () => catalog })
    const resolved = await reopened.resolve('wrapper')
    expect(resolved.config).toEqual(value)
    expect(resolved.descriptor.configRevision).toBe(saved.executor.configRevision)
    const reordered = await reopened.configure({ executorId: 'wrapper', config: { ...value, env: { A: 'secret', Z: 'last' } } })
    expect(reordered.executor.configRevision).toBe(saved.executor.configRevision)
  })

  it('requires the current revision for replacement and admits only one concurrent edit without changing Provider identity', async () => {
    const f = await fixture()
    const saved = await f.owner.configure({ executorId: 'wrapper', config: config('codex') })
    await expect(f.owner.configure({ executorId: 'wrapper', config: config('another') })).rejects.toMatchObject({ code: 'EXECUTOR_CONFIGURATION_CONFLICT' })
    const edits = await Promise.allSettled(['one', 'two'].map(command => f.owner.configure({ executorId: 'wrapper',
      expectedRevision: saved.executor.configRevision, config: config(command) })))
    expect(edits.filter(edit => edit.status === 'fulfilled')).toHaveLength(1)
    expect(edits.filter(edit => edit.status === 'rejected')).toHaveLength(1)
    const current = (await f.owner.list()).executors.find(item => item.executorId === 'wrapper')!
    await expect(f.owner.configure({ executorId: 'wrapper', expectedRevision: current.configRevision,
      config: config('claude', { providerId: 'claude' }) })).rejects.toMatchObject({ code: 'EXECUTOR_IDENTITY_IMMUTABLE' })
    await expect(f.owner.configure({ executorId: 'codex', config: config('claude', { providerId: 'claude' }) }))
      .rejects.toMatchObject({ code: 'EXECUTOR_IDENTITY_IMMUTABLE' })
  })

  it('preserves corrupt or foreign original files and never turns unavailable registration data into defaults', async () => {
    const f = await fixture()
    const original = '{invalid-original-data'
    await writeFile(f.path, original)
    await expect(f.owner.list({ refresh: true })).rejects.toMatchObject({ code: 'EXECUTOR_CONFIGURATION_UNAVAILABLE' })
    await expect(f.owner.configure({ executorId: 'new', config: config('codex') })).rejects.toMatchObject({ code: 'EXECUTOR_CONFIGURATION_UNAVAILABLE' })
    expect(await readFile(f.path, 'utf8')).toBe(original)
    await rm(f.path)
    await f.owner.configure({ executorId: 'wrapper', config: config('codex') })
    const foreign = new AgentMuxHostExecutorOwner({ path: f.path, runtimeId: 'different-runtime', catalog: () => catalog })
    await expect(foreign.list()).rejects.toMatchObject({ code: 'EXECUTOR_CONFIGURATION_UNAVAILABLE' })
  })

  it('distinguishes failed checking from missing and retains the original configuration when checking is unconfirmed', async () => {
    const f = await fixture()
    await f.owner.configure({ executorId: 'empty-path', config: config('wrapper', { env: { PATH: '' } }) })
    const failed = await f.owner.resolve('empty-path')
    expect(failed.config.command).toBe('wrapper')
    expect(failed.descriptor).toMatchObject({ availability: 'check-failed', cause: { code: 'EXECUTABLE_WORKSPACE_REQUIRED' } })
    const noPath = new AgentMuxHostExecutorOwner({ path: f.path, runtimeId: 'target-runtime', catalog: () => catalog, environment: () => ({}) })
    expect((await noPath.resolve('codex')).descriptor).toMatchObject({ availability: 'check-failed', cause: { code: 'EXECUTABLE_SEARCH_UNAVAILABLE' } })
    await f.owner.configure({ executorId: 'missing', config: config(join(f.root, 'absent')) })
    expect((await f.owner.resolve('missing')).descriptor).toMatchObject({ availability: 'missing' })
    await f.owner.configure({ executorId: 'directory', config: config(f.bin) })
    expect((await f.owner.resolve('directory')).descriptor).toMatchObject({ availability: 'missing', cause: { code: 'EXECUTABLE_NOT_FILE' } })
    const denied = await executable(join(f.bin, 'denied')); await chmod(denied, 0o644)
    await f.owner.configure({ executorId: 'denied', config: config(denied) })
    expect((await f.owner.resolve('denied')).descriptor).toMatchObject({ availability: 'check-failed', cause: { code: 'EACCES' } })
  })

  it('rejects workspace-relative registration and unsupported Providers without writing or revealing credentials', async () => {
    const f = await fixture()
    for (const value of [config('./wrapper'), config('../wrapper'), config('wrapper', { providerId: 'unsupported-provider' })]) {
      await expect(f.owner.configure({ executorId: 'invalid', config: { ...value, env: { SECRET: 'private-credential' } } })).rejects.toThrow()
    }
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(f.owner.resolve('unregistered-wrapper')).rejects.toMatchObject({ code: 'HOST_EXECUTOR_NOT_FOUND' })
  })

  it('does not guess a workspace for relative PATH entries or let a later executable hide that ambiguity', async () => {
    const f = await fixture()
    await executable(join(f.bin, 'wrapper'))
    await f.owner.configure({ executorId: 'relative-path', config: config('wrapper', { env: { PATH: `.:${f.bin}` } }) })
    const resolved = await f.owner.resolve('relative-path')
    expect(resolved.config.command).toBe('wrapper')
    expect(resolved.descriptor).toMatchObject({ availability: 'check-failed', cause: { code: 'EXECUTABLE_WORKSPACE_REQUIRED' } })
  })

  it.each(['leading', 'middle', 'trailing'] as const)('preserves an empty %s PATH component as a cwd-dependent candidate', async position => {
    const f = await fixture(), command = await executable(join(f.bin, 'wrapper'))
    const absent = join(f.root, 'absent')
    const paths = { leading: `:${f.bin}`, middle: `${absent}::${f.bin}`, trailing: `${absent}:` }
    await f.owner.configure({ executorId: 'empty-component', config: config('wrapper', { env: { PATH: paths[position] } }) })
    const resolved = await f.owner.resolve('empty-component')
    expect(resolved.config.command).toBe('wrapper')
    expect(resolved.descriptor).toMatchObject({ availability: 'check-failed', cause: { code: 'EXECUTABLE_WORKSPACE_REQUIRED' } })
    // PATH order remains meaningful: an already resolved absolute command wins before a later cwd candidate.
    await f.owner.configure({ executorId: 'absolute-first', config: config('wrapper', { env: { PATH: `${f.bin}:` } }) })
    expect((await f.owner.resolve('absolute-first')).config.command).toBe(command)
  })

  it('retains registered configurations when a Provider is unavailable without advertising an unsupported launch as available', async () => {
    const f = await fixture(), command = await executable(join(f.bin, 'wrapper'))
    await f.owner.configure({ executorId: 'wrapper', config: config(command) })
    const withoutProvider = new AgentMuxHostExecutorOwner({ path: f.path, runtimeId: 'target-runtime', catalog: () => [] })
    const resolved = await withoutProvider.resolve('wrapper')
    expect(resolved.config.command).toBe(command)
    expect(resolved.descriptor).toMatchObject({ executorId: 'wrapper', source: 'registered', availability: 'check-failed', cause: { code: 'UNKNOWN_PROVIDER' } })
    expect((await f.owner.list({ refresh: true })).executors.find(item => item.executorId === 'wrapper')?.availability).toBe('available')
  })
})
