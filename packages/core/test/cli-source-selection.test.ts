import { beforeEach, expect, it, vi } from 'vitest'
import { connectAgentMuxCliSource } from '../src/agentmux-cli-source.js'
import { agentMuxCliArguments } from '../src/agentmux-cli-commands.js'

const mock = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('../src/public-rpc-client.js', () => ({ connectAgentMuxRpc: mock.connect }))
const fence = { runtimeId: 'original-runtime', ownerInstanceId: 'original-instance' }
const credentials = { agentSessionId: 'original-agent', capability: 'original-capability' }
const saved = { id: 'saved-source', kind: 'ssh', label: 'Original', hostname: 'literal-host', runtimeId: fence.runtimeId,
  user: 'literal-user', port: 18822, identityFile: '/private/identity', remoteCommand: 'literal command', remoteSocketPath: '/private/original.sock' }
beforeEach(() => { vi.clearAllMocks() })
function fixture(record: Record<string, unknown> = saved) {
  const configuration = { call: vi.fn(async () => ({ hosts: [record] })), dispose: vi.fn(async () => {}) }
  const source = { call: vi.fn(async () => ({ source: fence, contracts: { ordinaryLaunch: null, externalAssociation: null } })),
    subscribe: vi.fn(async () => ({ subscriptionId: 'original-reader', dispose: async () => {} })), dispose: vi.fn(async () => {}) }
  mock.connect.mockResolvedValueOnce(configuration).mockResolvedValueOnce(source)
  return { configuration, source }
}

it.each([
  { ...saved, transport: 'ssh-tailcat', tailcat: { address: 'tcORIGINAL', keyFile: 'original-client-key' } },
  { ...saved, hostname: '', transport: 'tailcat', tailcat: { address: 'tcORIGINAL', keyFile: '/private/client-key' } }
])('projects the complete original backup/direct Tailcat target without reading a key: $transport', async record => {
  const f = fixture(record), port = await connectAgentMuxCliSource({ endpoint: { transport: 'unix', path: '/private/configuration.sock' }, sourceHost: saved.id, credentials })
  const actual = mock.connect.mock.calls[1]![0]
  expect(actual.credentials).toBe(credentials)
  expect(actual.endpoint).toEqual(record.transport === 'tailcat' ? { transport: 'tailcat', ...record.tailcat } : {
    transport: 'ssh', host: saved.hostname, user: saved.user, port: saved.port, identityFile: saved.identityFile,
    command: saved.remoteCommand, socketPath: saved.remoteSocketPath, tailcat: record.tailcat })
  expect(f.source.call).toHaveBeenCalledWith('agent.open.describe', { expectedRuntimeId: fence.runtimeId })
  expect(f.configuration.dispose).toHaveBeenCalledTimes(1)
  await port.dispose(); expect(f.source.dispose).toHaveBeenCalledTimes(1)
})

it('captures a fence on ordinary and specialized readers and refuses a conflicting method-specific owner before dispatch', async () => {
  const f = fixture(), port = await connectAgentMuxCliSource({ endpoint: { transport: 'unix', path: '/private/configuration.sock' }, sourceHost: saved.id, credentials })
  const signal = new AbortController().signal
  await port.call('runtime.owner.identity', {}, { signal, runtimeFence: { ...fence } })
  expect(f.source.call).toHaveBeenLastCalledWith('runtime.owner.identity', {}, { signal, runtimeFence: fence })
  const handlers = { onInitial: vi.fn(), onEvent: vi.fn(), signal }
  await port.subscribe('space.snapshot', { reference: { runtimeId: fence.runtimeId, spaceId: 'original-space' } }, handlers)
  expect(f.source.subscribe).toHaveBeenLastCalledWith('space.snapshot', expect.anything(), { ...handlers, runtimeFence: fence })
  const count = f.source.call.mock.calls.length
  expect(() => port.call('runtime.owner.identity', {}, { runtimeFence: { ...fence, ownerInstanceId: 'later-instance' } })).toThrow(/another Source/)
  expect(f.source.call.mock.calls).toHaveLength(count)
  expect(() => port.subscribe('space.snapshot', { reference: { runtimeId: fence.runtimeId, spaceId: 'original-space' } },
    { ...handlers, runtimeFence: { ...fence, runtimeId: 'another-runtime' } })).toThrow(/another Source/)
  expect(f.source.subscribe).toHaveBeenCalledTimes(1)
  await port.dispose()
})

it('the default/explicit endpoint retains its original connection without any saved-Host or identity lookup', async () => {
  const source = { call: vi.fn(), subscribe: vi.fn(), dispose: vi.fn() }; mock.connect.mockResolvedValueOnce(source)
  const endpoint = { transport: 'unix' as const, path: '/private/original.sock' }
  expect(await connectAgentMuxCliSource({ endpoint, credentials })).toBe(source)
  expect(mock.connect).toHaveBeenCalledExactlyOnceWith({ endpoint, credentials }); expect(source.call).not.toHaveBeenCalled()
})

it('parses only leading selectors and keeps option-looking IDs as explicit literal values', () => {
  expect(agentMuxCliArguments(['--source-host=--help', 'agent', 'ls'])).toEqual({ sourceHost: '--help', args: ['agent', 'ls'] })
  expect(agentMuxCliArguments(['--source-host', 'literal source', 'file', 'read', '--host', 'local'])).toEqual({ sourceHost: 'literal source', args: ['file', 'read', '--host', 'local'] })
  for (const args of [ ['--source-host'], ['--source-host='], ['--source-host', '--help'],
    ['--source-host=a', '--source-host=b'], ['--endpoint=unix:/private/original.sock', '--source-host=a'],
    ['--source-host=a', '--endpoint=unix:/private/original.sock'] ]) expect(() => agentMuxCliArguments(args)).toThrow()
})
