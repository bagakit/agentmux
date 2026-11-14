import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxStorageRecovery, snapshotRecoveryFile, type RecoveryGeneration } from '../src/storage-recovery.js'
import { AgentMuxRpcService, type AgentMuxRpcCallContext } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { isAgentMuxRpcMethod } from '../src/public-rpc.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { parseStorageRecoveryParams, parseStorageRecoveryResult, STORAGE_RECOVERY_METHODS, type StorageRecoveryMethod } from '../src/storage-recovery-rpc.js'
import { AGENTMUX_CLI_COMMANDS, parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { agentMuxModuleSkill, agentMuxCliModuleCatalog } from '../src/agentmux-cli-module-skills.js'
import { runStorageSourceCli } from './helpers/storage-recovery-source-cli.js'

let namespace: string
beforeAll(async () => { namespace = await mkdtemp('/tmp/amux-storage-namespace-') })
beforeEach(() => {
  for (const name of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(name) && !name.startsWith('AGENTMUX_TEST_')) vi.stubEnv(name, undefined)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(namespace, 'state')); vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', namespace)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(namespace, 'messages.ndjson'))
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })
afterAll(async () => { await rm(namespace, { recursive: true, force: true }) })
const localUser: AgentMuxRpcCallContext = { transport: 'unix', principal: { kind: 'user', id: 'original-local-user' } }
const sample: RecoveryGeneration = { generationId: 'original-generation', namespace: 'original-namespace', createdAt: 1,
  memberCount: 1, gaps: [{ sourceId: 'an-owner', memberId: 'original\nfile', code: 'RECOVERY_SOURCE_CHANGED' }], manifestHash: 'a'.repeat(64) }
const methods = Object.keys(STORAGE_RECOVERY_METHODS) as StorageRecoveryMethod[]
const originalMember = { id: 'original-member', file: '/private/original-export/member', target: '/private/original-source', kind: 'file' as const, capturedAt: 1, sha256: 'a'.repeat(64), operationId: 'original-operation' }
const input = (method: StorageRecoveryMethod) => method === 'storage.backup.inspect' ? { generationId: sample.generationId }
  : method === 'storage.source.prepare' ? { captureId: 'original-capture', members: [originalMember] }
  : method === 'storage.source.restore' ? { member: originalMember }
  : method === 'storage.source.capture' || method === 'storage.source.release' ? { captureId: 'original-capture' }
  : method === 'storage.restore.preflight' ? { operationId: 'original-operation', generationId: sample.generationId, manifestHash: sample.manifestHash }
  : method === 'storage.restore.apply' || method === 'storage.restore.inspect' ? { operationId: 'original-operation' }
  : method === 'storage.backup.import' ? { sourcePath: '/private/original.sqlite', sha256: 'a'.repeat(64) } : {}
function exportPort() { return { inspect: vi.fn(async () => ({ revision: 'original-revision' })), capture: vi.fn(async (captureId: string) => ({ captureId, revision: 'original-revision',
  members: [{ id: 'original-member', file: '/private/original-export/member', target: '/private/original-source', kind: 'file' as const, capturedAt: 1 }], gaps: [] })), release: vi.fn(async () => ({ released: true })), prepare: vi.fn(async (captureId: string, members: typeof originalMember[]) => ({ captureId, result: { state: 'prepared' as const, members } })), restore: vi.fn(async () => 'restored' as const) } }
const operation = { operationId: 'original-operation', generationId: sample.generationId, manifestHash: sample.manifestHash, state: 'prepared' as const, items: [] }
function port() { return { restorePreflight: vi.fn(async () => operation), restoreApply: vi.fn(async () => operation), restoreInspect: vi.fn(async () => operation), importSessionBackup: vi.fn(async () => sample), capture: vi.fn(async () => sample), list: vi.fn(async () => [sample]), inspect: vi.fn(async () => sample),
  status: vi.fn(() => ({ state: 'idle' as const, lastGeneration: sample, pending: false, issue: null })) } }

it.each(methods)('registers %s once with typed params, source CLI discovery and owned guidance', async method => {
  expect(isAgentMuxRpcMethod(method)).toBe(true)
  expect(AGENTMUX_CLI_COMMANDS.filter(value => value.method === method)).toHaveLength(1)
  const data = join(namespace, 'maintenance.json'); await writeFile(data, JSON.stringify(input(method)), { mode: 0o600 })
  const invocation = await parseAgentMuxCliInvocation([...method.split('.'), ...(method === 'storage.source.prepare' || method === 'storage.source.restore' ? ['--input', data] : []), ...(method === 'storage.restore.preflight' || method === 'storage.backup.import' ? ['--data', data] : method === 'storage.restore.apply' || method === 'storage.restore.inspect' ? ['--operation', 'original-operation'] : []), ...(method === 'storage.backup.inspect' ? ['--generation', sample.generationId] : method === 'storage.source.capture' || method === 'storage.source.release' ? ['--capture', 'original-capture'] : [])])
  expect(invocation.params).toEqual(input(method))
  expect(agentMuxCommandHelp(method)).toContain('amux storage --skill')
  expect(agentMuxCliModuleCatalog().find(value => value.root === 'storage')?.summary).not.toContain('unavailable')
  expect(agentMuxModuleSkill('storage')).toContain('not an\natomic checkpoint across owners')
})

it.each(methods)('dispatches %s to the exact composed owner and decodes its original result', async method => {
  const owner = port(), exports = exportPort(), current = vi.fn(), service = new AgentMuxRpcService({ storageRecovery: owner, storageRecoveryExports: exports })
  const result = await service.call(method, input(method), { ...localUser, assertCurrent: current })
  expect(current).toHaveBeenCalledOnce()
  expect(parseRpcNativeResult(method, result, input(method))).toEqual(result)
  expect([...Object.values(owner), ...Object.values(exports)].reduce((count, method) => count + method.mock.calls.length, 0)).toBe(1)
  if (method === 'storage.backup.inspect') expect(owner.inspect).toHaveBeenCalledWith(sample.generationId)
})

it.each(methods)('rejects additional authority, paths and body fields for %s before touching the owner', async method => {
  const owner = port(), exports = exportPort(), service = new AgentMuxRpcService({ storageRecovery: owner, storageRecoveryExports: exports })
  for (const field of ['path', 'source', 'target', 'manifest', 'record', 'namespace', 'principal', 'operationId'].filter(field => !Object.hasOwn(input(method), field))) {
    await expect(service.call(method, { ...input(method), [field]: 'untrusted' } as never, localUser)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  }
  for (const fn of [...Object.values(owner), ...Object.values(exports)]) expect(fn).not.toHaveBeenCalled()
})

it.each(['http-user', 'relay-user', 'unix-device', 'no-principal', 'agent-caller', 'delegated-route'] as const)('refuses %s without consulting or forwarding storage', async invalid => {
  const owner = port(), exports = exportPort(), forwardControl = vi.fn(), service = new AgentMuxRpcService({ storageRecovery: owner, storageRecoveryExports: exports, forwardControl })
  const context: AgentMuxRpcCallContext = { ...localUser }
  if (invalid === 'http-user') context.transport = 'http'
  if (invalid === 'relay-user') context.transport = 'relay'
  if (invalid === 'unix-device') context.principal = { kind: 'device', id: 'original-device' }
  if (invalid === 'no-principal') delete context.principal
  if (invalid === 'agent-caller') context.caller = { agentSessionId: 'original-agent', capability: 'synthetic-only' }
  if (invalid === 'delegated-route') context.routeDelegation = {} as never
  for (const method of methods) await expect(service.call(method, input(method), context)).rejects.toBeInstanceOf(Error)
  for (const fn of [...Object.values(owner), ...Object.values(exports)]) expect(fn).not.toHaveBeenCalled()
  expect(forwardControl).not.toHaveBeenCalled()
})

it('keeps an absent original owner unavailable and respects current authority cancellation', async () => {
  const forwardControl = vi.fn(), missing = new AgentMuxRpcService({ forwardControl })
  await expect(missing.call('storage.backup.create', {}, localUser)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  for (const method of ['storage.source.capture', 'storage.source.release'] as const) await expect(missing.call(method, { captureId: 'original-capture' }, localUser)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(forwardControl).not.toHaveBeenCalled()
  const owner = port(), service = new AgentMuxRpcService({ storageRecovery: owner }), controller = new AbortController()
  const revoked = Object.assign(new Error('original user revoked'), { code: 'CONTROL_PERMISSION_DENIED' })
  await expect(service.call('storage.backup.create', {}, { ...localUser, assertCurrent: () => { throw revoked } })).rejects.toBe(revoked)
  controller.abort(revoked)
  await expect(service.call('storage.backup.create', {}, { ...localUser, signal: controller.signal })).rejects.toBe(revoked)
  expect(owner.capture).not.toHaveBeenCalled()
})

it('rejects a traversal generation, malformed owner data and a receipt for another original generation', () => {
  for (const generationId of ['../other', '/private/snapshot', '', 'bad\nvalue']) expect(() => parseStorageRecoveryParams('storage.backup.inspect', { generationId })).toThrow()
  const malformed = { generation: { ...sample, memberCount: -1 } }
  expect(() => parseStorageRecoveryResult('storage.backup.create', malformed, {})).toThrow()
  expect(() => parseStorageRecoveryResult('storage.backup.create', { generation: { ...sample, target: '/unapproved' } }, {})).toThrow()
  expect(() => parseStorageRecoveryResult('storage.backup.inspect', { generation: sample }, { generationId: 'another-generation' })).toThrow()
  const exported = { captureId: 'original-capture', revision: 'original-revision', members: [{ id: 'one', file: '/private/export', target: '/private/source', kind: 'file', capturedAt: 1 }], gaps: [] }
  expect(() => parseStorageRecoveryResult('storage.source.capture', exported, { captureId: 'another-capture' })).toThrow()
  expect(() => parseStorageRecoveryResult('storage.source.capture', { ...exported, members: [{ ...exported.members[0], file: '../unapproved' }] }, { captureId: 'original-capture' })).toThrow()
})

it('preserves an optional original file revision without manufacturing it or accepting digest/ACK authority', () => {
  const member = { id: 'original', file: '/private/export', target: '/private/source', kind: 'file', capturedAt: 1 }
  const plain = { captureId: 'original-capture', revision: 'original-source', members: [member], gaps: [] }, key = { captureId: 'original-capture' }
  expect(parseStorageRecoveryResult('storage.source.capture', plain, key)).toEqual(plain)
  const original = { ...plain, members: [{ ...member, revision: 'device:inode:size:mtime:ctime' }] }
  expect(parseRpcNativeResult('storage.source.capture', original, key)).toEqual(original)
  for (const field of ['sha256', 'acknowledged', 'inputByteRange']) expect(() => parseStorageRecoveryResult('storage.source.capture',
    { ...plain, members: [{ ...member, [field]: 'untrusted-self-claim' }] }, key)).toThrow()
})

it('captures real admitted files through Unix RPC and the source CLI with explicit gaps and no private bytes', async () => {
  const root = await mkdtemp('/tmp/amux-storage-rpc-'), source = join(root, 'original-private.txt'), socket = join(root, 'control.sock')
  for (const name of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(name) && !name.startsWith('AGENTMUX_TEST_')) vi.stubEnv(name, undefined)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state')); vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root)
  const body = 'synthetic original body; never a public backup payload'
  await writeFile(source, body, { mode: 0o600 })
  const owner = new AgentMuxStorageRecovery(join(root, 'backups'), 'original-namespace', [{ id: 'original-owner',
    async capture(output) { const file = join(output, 'snapshot'); await snapshotRecoveryFile(source, file)
      return { revision: 'original-revision', members: [{ id: 'original-private', file, target: source, kind: 'file', capturedAt: Date.now() }],
        gaps: [{ sourceId: 'original-owner', memberId: 'explicit-unavailable-member', code: 'RECOVERY_SOURCE_UNAVAILABLE' }] } }
  }])
  const server = new AgentMuxControlServer({ socketPath: socket, storageRecovery: owner })
  let client: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  try {
    await server.start(); client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
    const created = await runStorageSourceCli(root, socket, ['storage', 'backup', 'create'])
    expect(created.code, created.stderr + created.stdout).toBe(0)
    const generation = JSON.parse(created.stdout).result.generation as RecoveryGeneration
    expect(generation).toMatchObject({ memberCount: 1, gaps: [{ sourceId: 'original-owner', code: 'RECOVERY_SOURCE_UNAVAILABLE' }] })
    expect((await client.call('storage.backup.list', {})).generations).toEqual([{ ...await owner.inspect(generation.generationId), verification: 'manifest-only' }])
    const inspect = await runStorageSourceCli(root, socket, ['storage', 'backup', 'inspect', '--generation', generation.generationId])
    expect(inspect.code, inspect.stderr + inspect.stdout).toBe(0)
    expect(JSON.parse(inspect.stdout).result.generation).toEqual(await owner.inspect(generation.generationId))
    expect((await client.call('storage.recovery.status', {})).status).toMatchObject({ state: 'unavailable', lastGeneration: generation, issue: 'RECOVERY_COVERAGE_INCOMPLETE' })
    for (const output of [created.stdout, inspect.stdout]) { expect(output).not.toContain(body); expect(output).not.toContain(source); expect(output).not.toContain('privateKey') }
    expect(await readFile(source, 'utf8')).toBe(body)
  } finally { await client?.dispose(); await server.stop(); await owner.dispose(); await rm(root, { recursive: true, force: true }) }
}, 40_000)

it('exports and releases only the exact private local source capture over the real source CLI', async () => {
  const root = await mkdtemp('/tmp/amux-storage-export-'), socket = join(root, 'control.sock'), source = join(root, 'original-source'), file = join(root, 'private-export')
  const body = 'synthetic source body retained across export release'
  await writeFile(source, body, { mode: 0o600 })
  const inspect = vi.fn(async () => { const stat = await lstat(source); return { revision: JSON.stringify([stat.ino, stat.size, stat.mtimeMs]) } })
  const capture = vi.fn(async (captureId: string) => {
    await writeFile(file, await readFile(source), { mode: 0o600 })
    return { captureId, revision: 'original-source-revision', members: [{ id: 'original-member', file, target: source, kind: 'file' as const, capturedAt: 1, revision: 'original-file-stamp' }], gaps: [] }
  })
  const release = vi.fn(async (captureId: string) => { expect(captureId).toBe('original-capture'); await rm(file); return { released: true } })
  const server = new AgentMuxControlServer({ socketPath: socket, storageRecoveryExports: { inspect, capture, release,
    prepare: exportPort().prepare, restore: exportPort().restore } })
  try {
    await server.start()
    const observed = await runStorageSourceCli(root, socket, ['storage', 'source', 'inspect'])
    expect(observed.code, observed.stderr + observed.stdout).toBe(0)
    expect(JSON.parse(observed.stdout).result).toHaveProperty('revision')
    expect(inspect).toHaveBeenCalledOnce(); expect(capture).not.toHaveBeenCalled()
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    const exported = await runStorageSourceCli(root, socket, ['storage', 'source', 'capture', '--capture', 'original-capture'])
    expect(exported.code, exported.stderr + exported.stdout).toBe(0)
    expect(JSON.parse(exported.stdout).result).toMatchObject({ captureId: 'original-capture', members: [{ file, target: source, revision: 'original-file-stamp' }] })
    expect(exported.stdout).not.toContain(body)
    expect(await readFile(file, 'utf8')).toBe(body)
    const released = await runStorageSourceCli(root, socket, ['storage', 'source', 'release', '--capture', 'original-capture'])
    expect(released.code, released.stderr + released.stdout).toBe(0)
    expect(JSON.parse(released.stdout).result).toEqual({ released: true })
    expect(await readFile(source, 'utf8')).toBe(body)
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(capture).toHaveBeenCalledWith('original-capture'); expect(release).toHaveBeenCalledOnce()
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }) }
}, 40_000)

it('prepares and restores exact original source members through real Unix CLI with same-operation receipts', async () => {
  const root = await mkdtemp('/tmp/amux-source-restore-cli-'), socket = join(root, 'control.sock'), owner = exportPort()
  const server = new AgentMuxControlServer({ socketPath: socket, storageRecoveryExports: owner })
  try {
    await server.start()
    const preparing = join(root, 'prepare.json'), restoring = join(root, 'restore.json')
    await writeFile(preparing, JSON.stringify(input('storage.source.prepare')), { mode: 0o600 })
    await writeFile(restoring, JSON.stringify(input('storage.source.restore')), { mode: 0o600 })
    const prepared = await runStorageSourceCli(root, socket, ['storage', 'source', 'prepare', '--input', preparing])
    expect(prepared.code, prepared.stderr).toBe(0)
    expect(JSON.parse(prepared.stdout).result).toEqual({ captureId: 'original-capture', result: { state: 'prepared', members: [originalMember] } })
    expect(owner.prepare).toHaveBeenCalledExactlyOnceWith('original-capture', [originalMember])
    const restored = await runStorageSourceCli(root, socket, ['storage', 'source', 'restore', '--input', restoring])
    expect(restored.code, restored.stderr).toBe(0)
    expect(JSON.parse(restored.stdout).result).toEqual({ outcome: 'restored' })
    expect(owner.restore).toHaveBeenCalledExactlyOnceWith(originalMember)
    expect(owner.capture).not.toHaveBeenCalled()
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }) }
}, 40_000)

it('rejects a preparation that changes the frozen target, operation or member selection and preserves exact unavailable selectors', () => {
  const params = { captureId: 'original-capture', members: [originalMember] }
  for (const changed of [{ target: '/another/original' }, { operationId: 'another-operation' }, { id: 'another-member' }])
    expect(() => parseRpcNativeResult('storage.source.prepare', { captureId: params.captureId, result: { state: 'prepared', members: [{ ...originalMember, ...changed }] } }, params)).toThrow()
  for (const members of [[], [originalMember, originalMember]])
    expect(() => parseRpcNativeResult('storage.source.prepare', { captureId: params.captureId, result: { state: 'prepared', members } }, params)).toThrow()
  expect(parseRpcNativeResult('storage.source.prepare', { captureId: params.captureId, result: { state: 'unavailable', selectors: [{ memberId: originalMember.id, agentSessionId: 'original-session', reason: 'DESKTOP_DOCUMENT_ALREADY_OPEN' }] } }, params)).toMatchObject({ result: { state: 'unavailable', selectors: [{ memberId: originalMember.id, agentSessionId: 'original-session' }] } })
  expect(() => parseRpcNativeResult('storage.source.restore', true, { member: originalMember })).toThrow()
})
