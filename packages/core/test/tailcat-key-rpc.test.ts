import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseTailcatKeyParams, parseTailcatKeyResult } from '../src/public-rpc-tailcat-key.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { settingsCliCommand } from './helpers/settings-command.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const publicKey = 'nodekey:' + 'ab'.repeat(32)
const prepared = (input: { role: 'server' | 'client'; key: string }) =>
  Promise.resolve({ ...input, created: true, ...(input.role === 'client' ? { publicKey } : {}) })

it('a local user prepares the default key over the real Unix transport; a managed Agent caller never reaches the key owner', async () => {
  const f = await rpcOwnerFixture(); cleanups.push(f.close)
  const hostTailcatKey = vi.fn(prepared)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'host.sock'), coreClients: f.coreClients, hostTailcatKey })
  await server.start(); cleanups.push(() => server.stop())
  const user = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => user.dispose())
  const managed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: f.credentials }); cleanups.push(() => managed.dispose())

  await expect(managed.call('settings.hosts.tailcat-key', { role: 'client' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(hostTailcatKey).not.toHaveBeenCalled()
  expect(await user.call('settings.hosts.tailcat-key', { role: 'server' })).toEqual({ role: 'server', key: 'agentmux-server', created: true })
  const names = ['studio.client', 'x'.repeat(65), '.studio', 'office client', '工作站密钥', ' leading and trailing ']
  for (const key of names) {
    expect(await user.call('settings.hosts.tailcat-key', { role: 'client', key }))
      .toEqual({ role: 'client', key, created: true, publicKey })
  }
  expect(hostTailcatKey.mock.calls.map(([input]) => input)).toEqual([
    { role: 'server', key: 'agentmux-server' }, ...names.map(key => ({ role: 'client', key }))
  ])
})

it('device, unauthenticated and self-reported callers are refused, and a Host without the owner says nothing changed', async () => {
  const hostTailcatKey = vi.fn(prepared)
  const service = new AgentMuxRpcService({ hostTailcatKey }); cleanups.push(() => service.dispose())
  for (const context of [{}, { principal: { kind: 'device' as const, id: 'phone' } },
    { principal: { kind: 'user' as const, id: 'person' }, caller: { agentSessionId: 'forged', capability: 'forged' } }]) {
    await expect(service.call('settings.hosts.tailcat-key', { role: 'server' }, context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  }
  expect(hostTailcatKey).not.toHaveBeenCalled()
  const bare = new AgentMuxRpcService({}); cleanups.push(() => bare.dispose())
  await expect(bare.call('settings.hosts.tailcat-key', { role: 'server' }, { principal: { kind: 'user', id: 'person' } }))
    .rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE', message: expect.stringContaining('No key was created or changed') })
})

it('revoked users and cancelled reads cannot start a key preparation', async () => {
  const hostTailcatKey = vi.fn(prepared)
  const service = new AgentMuxRpcService({ hostTailcatKey }); cleanups.push(() => service.dispose())
  const principal = { kind: 'user' as const, id: 'person' }, revoked = Error('Original user access was revoked')
  await expect(service.call('settings.hosts.tailcat-key', { role: 'client' }, { principal, assertCurrent: async () => { throw revoked } })).rejects.toBe(revoked)
  const controller = new AbortController(), cancelled = Error('Original request cancelled')
  controller.abort(cancelled)
  await expect(service.call('settings.hosts.tailcat-key', { role: 'client' }, { principal, signal: controller.signal })).rejects.toBe(cancelled)
  expect(hostTailcatKey).not.toHaveBeenCalled()
})

it('names stay inside the official key directory and each role returns only its own facts', () => {
  for (const key of ['../escape', join(import.meta.dirname, 'key'), 'nested/key', 'nested\\key', 'new', '', 'nul\0key', 'line\nbreak', 'line\rbreak']) {
    expect(() => parseTailcatKeyParams({ role: 'server', key })).toThrow()
  }
  expect(() => parseTailcatKeyParams({ role: 'relay' })).toThrow()
  expect(() => parseTailcatKeyParams({ role: 'server', force: true })).toThrow()
  expect(parseTailcatKeyParams({ role: 'client', key: 'office-mac_2' })).toEqual({ role: 'client', key: 'office-mac_2' })

  const client = { role: 'client' as const }, server = { role: 'server' as const }
  expect(parseTailcatKeyResult({ role: 'client', key: 'agentmux-client', created: false, publicKey }, client))
    .toEqual({ role: 'client', key: 'agentmux-client', created: false, publicKey })
  for (const [value, input] of [
    [{ role: 'client', key: 'agentmux-client', created: false }, client],
    [{ role: 'client', key: 'agentmux-client', created: false, publicKey: 'nodekey:' + '0'.repeat(64) }, client],
    [{ role: 'client', key: 'other', created: false, publicKey }, client],
    [{ role: 'server', key: 'agentmux-server', created: true, publicKey }, server],
    [{ role: 'server', key: 'agentmux-server', created: 'yes' }, server],
    [{ role: 'server', key: 'agentmux-server', created: true, address: 'tc-secret' }, server]
  ] as const) expect(() => parseTailcatKeyResult(value, input)).toThrow()
})

it('the CLI carries role and optional name only, and help names both defaults', async () => {
  expect(await settingsCliCommand(['hosts', 'tailcat-key', '--role', 'client'])).toEqual({ method: 'settings.hosts.tailcat-key', params: { role: 'client' } })
  expect(await settingsCliCommand(['hosts', 'tailcat-key', '--key', 'office', '--role', 'server']))
    .toEqual({ method: 'settings.hosts.tailcat-key', params: { role: 'server', key: 'office' } })
  for (const args of [[], ['--key', 'office'], ['--role'], ['--role', 'server', '--role', 'client'], ['--role', 'server', '--force', 'yes']]) {
    await expect(settingsCliCommand(['hosts', 'tailcat-key', ...args])).rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
  }
  const help = agentMuxCommandHelp('settings.hosts.tailcat-key')
  expect(help).toContain('Usage: amux settings hosts tailcat-key --role <server|client> [--key <name>]')
  expect(help).toMatch(/agentmux-server[\s\S]*agentmux-client[\s\S]*never overwrites/)
  expect(help).toContain('TAILCAT_CLI_MISSING')
  expect(help).toContain('RPC_METHOD_NOT_FOUND')
})
