import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { ConversationLandmarkStore } from '../src/conversation-landmark-store.js'
import { parseConversationLandmarkPage, parseConversationLandmarkWrite, parseConversationLandmarkWritePage, type ConversationLandmarkWrite } from '../src/conversation-landmarks.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'

const dirs: string[] = [], servers: AgentMuxControlServer[] = []
const scope = { hostId: 'original-host', agentSessionId: 'original-session' }, actor = { kind: 'user', id: 'original-user' } as const
const captured = { ...scope, source: { kind: 'captured', recordId: 'same-raw-id' } } as const
const native = { ...scope, source: { kind: 'native', providerId: 'original-provider', nativeSessionId: 'original-native', recordId: 'same-raw-id' } } as const
const create = (id = 'point-original', expectedRevision = 0, operationId = 'create-original', reference = captured): ConversationLandmarkWrite => ({ ...scope, expectedRevision, operationId, change: { kind: 'create', point: { id, name: 'Original reading point', reference } } })
async function fixture() { const directory = await mkdtemp(join(tmpdir(), 'amx-landmarks-')); dirs.push(directory); return { directory, store: new ConversationLandmarkStore(join(directory, 'points.json')) } }
let cli: string, worker: string
const output = resolve('.tmp/conversation-landmarks/core')
async function run(file: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number; result: any; stdout: string; stderr: string }>((ok, fail) => {
    const selected = { ...process.env, ...env }; for (const key of ['AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY', 'AGENTMUX_CLI_CALLER', 'AGENTMUX_RPC_ENDPOINT']) if (!(key in env)) delete selected[key]
    const child = spawn(process.execPath, [file, ...args], { env: selected, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes }); child.on('error', fail)
    child.on('close', code => { let result: any; try { result = JSON.parse(stdout.trim()) } catch {} ok({ code: code ?? -1, result, stdout, stderr }) })
  })
}
beforeAll(async () => {
  await mkdir(output, { recursive: true }); await symlink('../../../packages/core/node_modules', join(output, 'node_modules'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error })
  cli = join(output, 'cli.mjs'); worker = join(output, 'worker.mjs')
  const relay = JSON.parse(await readFile('packages/relay/package.json', 'utf8')) as { exports: Record<string, { import: string }> }
  const alias = Object.fromEntries(Object.entries(relay.exports).map(([key, value]) => [key === '.' ? '@agentmux/relay' : '@agentmux/relay/' + key.slice(2), resolve('packages/relay', value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))]))
  const relayRequire = createRequire(resolve('packages/relay/package.json')); for (const dependency of ['tweetnacl', 'base64-js', 'ws']) alias[dependency] = relayRequire.resolve(dependency)
  const common = { bundle: true, platform: 'node' as const, format: 'esm' as const, packages: 'external' as const, alias, banner: { js: "import {createRequire as landmarkRequire} from 'node:module'; const require=landmarkRequire(import.meta.url);" }, metafile: true, logLevel: 'silent' as const }
  const bundles = [await build({ ...common, entryPoints: ['packages/core/src/agentmux.ts'], outfile: cli }), await build({ ...common, stdin: { contents: `import {ConversationLandmarkStore} from './packages/core/src/conversation-landmark-store.ts'; const s=new ConversationLandmarkStore(process.argv[2]);try{const page=process.argv[3]==='write'?await s.apply(JSON.parse(process.argv[4]),{kind:'user',id:'original-user'}):await s.list(JSON.parse(process.argv[4]));console.log(JSON.stringify({pid:process.pid,page}));}catch(e){console.log(JSON.stringify({pid:process.pid,code:e.code,message:e.message}));process.exitCode=2}`, resolveDir: process.cwd() }, outfile: worker })]
  const sources: Record<string, string> = {}; for (const bundle of bundles) for (const file of Object.keys(bundle.metafile!.inputs)) if (file !== '<stdin>') sources[file] = createHash('sha256').update(await readFile(file)).digest('hex')
  await writeFile(join(output, 'compiled-inputs.json'), JSON.stringify(sources, null, 2) + '\n')
})
afterAll(async () => { for (const server of servers) await server.stop(); for (const directory of dirs) await rm(directory, { recursive: true, force: true }) })

describe('named exact original conversation references', () => {
  it('lists no points without touching disk or depending on a healthy target Run', async () => {
    const { store } = await fixture(); expect(await store.list(scope)).toEqual({ ...scope, revision: 0, points: [], recordedOperation: null }); await expect(readFile(store.path)).rejects.toMatchObject({ code: 'ENOENT' })
    const service = new AgentMuxRpcService({ conversationLandmarks: store, coreClients: () => [] })
    expect(await service.call('agent.conversation.landmark.ls', scope)).toMatchObject({ points: [], revision: 0 })
    await expect(service.call('agent.conversation.landmark.apply', create())).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect((await service.call('agent.conversation.landmark.apply', create(), { principal: actor })).points[0]?.reference).toEqual(captured)
  })
  it('retains source-qualified records with identical raw IDs and stores no copied body or Run', async () => {
    const { store } = await fixture(); await store.apply(create(), actor)
    await store.apply({ ...create('native-point', 1, 'native-create'), change: { kind: 'create', point: { id: 'native-point', name: 'Native point', reference: native } } }, actor)
    const page = await store.list(scope); expect(page.points.map(point => point.reference)).toEqual([captured, native])
    expect(Object.keys(page.points[0]!)).toEqual(['id', 'name', 'reference']); expect(await store.list({ ...scope, hostId: 'other-host' })).toMatchObject({ points: [] })
    const persisted = JSON.parse(await readFile(store.path, 'utf8')); expect(persisted.points['point-original']).toEqual(create().change.kind === 'create' ? (create().change as any).point : null)
  })
  it('reconciles the original operation after later edits and rejects reused identities with different intent', async () => {
    const { store } = await fixture(), input = create(); const first = await store.apply(input, actor); expect(first.recordedOperation?.revision).toBe(1)
    expect(await store.apply(input, actor)).toEqual(first)
    await store.apply({ ...scope, operationId: 'rename-original', expectedRevision: 1, change: { kind: 'rename', id: 'point-original', name: 'Renamed' } }, actor)
    const receipt = await store.list({ ...scope, operationId: input.operationId }); expect(receipt.points[0]?.name).toBe('Renamed'); expect(receipt.recordedOperation).toEqual(first.recordedOperation)
    await expect(store.apply({ ...input, expectedRevision: 2 }, actor)).rejects.toMatchObject({ code: 'CONVERSATION_LANDMARK_OPERATION_CONFLICT' })
    await expect(store.apply(input, { ...actor, id: 'another-user' })).rejects.toMatchObject({ code: 'CONVERSATION_LANDMARK_OPERATION_CONFLICT' })
    expect((await store.apply(input, actor)).recordedOperation).toEqual(first.recordedOperation)
  })
  it('protects concurrent revision, exact scope, and explicit deletion without retargeting', async () => {
    const { store } = await fixture(); await store.apply(create(), actor)
    const rename = { ...scope, operationId: 'rename', expectedRevision: 1, change: { kind: 'rename', id: 'point-original', name: 'Named' } } as const
    await expect(store.apply({ ...rename, hostId: 'other-host' }, actor)).rejects.toMatchObject({ code: 'CONVERSATION_LANDMARK_NOT_FOUND' })
    await expect(store.apply({ ...rename, expectedRevision: 0 }, actor)).rejects.toMatchObject({ code: 'CONVERSATION_LANDMARK_CONFLICT' })
    await store.apply(rename, actor)
    const deleted = await store.apply({ ...scope, operationId: 'remove', expectedRevision: 2, change: { kind: 'remove', id: 'point-original' } }, actor)
    expect(deleted.points).toEqual([]); expect((await store.list({ ...scope, operationId: 'create-original' })).recordedOperation?.input).toEqual(create())
  })
  it('preserves corrupt metadata and the prior snapshot instead of silently creating an empty catalog', async () => {
    const { store } = await fixture(); await store.apply(create(), actor); const original = await readFile(store.path, 'utf8')
    await store.apply({ ...scope, operationId: 'rename', expectedRevision: 1, change: { kind: 'rename', id: 'point-original', name: 'Named' } }, actor)
    expect(await readFile(store.path + '.previous', 'utf8')).toBe(original)
    await writeFile(store.path, '{original broken metadata')
    await expect(store.list(scope)).rejects.toMatchObject({ code: 'CONVERSATION_LANDMARK_READ_UNCONFIRMED' }); await expect(store.apply(create('second'), actor)).rejects.toMatchObject({ code: 'CONVERSATION_LANDMARK_READ_UNCONFIRMED' })
    expect(await readFile(store.path, 'utf8')).toBe('{original broken metadata')
    await unlink(store.path); await expect(store.list(scope)).rejects.toMatchObject({ code: 'CONVERSATION_LANDMARK_READ_UNCONFIRMED' }); expect(await readFile(store.path + '.previous', 'utf8')).toBe(original)
  })
  it('validates exact references, fields, and public response ownership rather than display names', async () => {
    const { store } = await fixture(), page = await store.apply(create(), actor)
    expect(() => parseConversationLandmarkWrite({ ...create(), body: 'copied body' })).toThrow()
    expect(() => parseConversationLandmarkWrite({ ...create(), change: { kind: 'create', point: { id: 'wrong', name: 'Wrong', reference: { ...captured, agentSessionId: 'other-session' } } } })).toThrow()
    expect(() => parseConversationLandmarkPage({ ...page, hostId: 'other-host' }, { ...scope, operationId: 'create-original' })).toThrow()
    expect(() => parseConversationLandmarkPage({ ...page, points: [{ ...page.points[0], reference: { ...captured, hostId: 'other-host' } }] }, { ...scope, operationId: 'create-original' })).toThrow()
    expect(() => parseConversationLandmarkWritePage({ ...page, recordedOperation: { ...page.recordedOperation, input: { ...create(), change: { kind: 'remove', id: 'point-original' } } } }, create())).toThrow()
    await store.apply(create('__proto__', 1, 'constructor'), actor); expect((await store.list({ ...scope, operationId: 'toString' })).recordedOperation).toBeNull()
  })
  it('rejects a forged causal revision through the original public result codec and durable ledger', async () => {
    const { store } = await fixture(), input = create(), page = await store.apply(input, actor)
    for (const committedRevision of [0, 2]) {
      const forged = { ...page, revision: 2, recordedOperation: { ...page.recordedOperation, revision: committedRevision } }
      expect(() => parseRpcNativeResult('agent.conversation.landmark.apply', forged, input)).toThrow()
      const raw = JSON.parse(await readFile(store.path, 'utf8')); raw.operations[input.operationId].revision = committedRevision; raw.revision = 2
      const bytes = JSON.stringify(raw); await writeFile(store.path, bytes)
      await expect(store.list({ ...scope, operationId: input.operationId })).rejects.toMatchObject({ code: 'CONVERSATION_LANDMARK_READ_UNCONFIRMED' }); expect(await readFile(store.path, 'utf8')).toBe(bytes)
      await writeFile(store.path, JSON.stringify({ ...raw, revision: 1, operations: { [input.operationId]: page.recordedOperation } }))
    }
  })
  it('reopens durable metadata in fresh processes and permits only the current concurrent writer', async () => {
    const { store } = await fixture(); await store.apply(create(), actor)
    const first = await run(worker, [store.path, 'read', JSON.stringify(scope)]), second = await run(worker, [store.path, 'read', JSON.stringify(scope)])
    expect(first.code, first.stderr).toBe(0); expect(second.code, second.stderr).toBe(0); expect(first.result.pid).not.toBe(second.result.pid); expect(first.result.page).toEqual(second.result.page)
    const writes = await Promise.all(['first', 'second'].map(name => run(worker, [store.path, 'write', JSON.stringify({ ...scope, operationId: name, expectedRevision: 1, change: { kind: 'rename', id: 'point-original', name } })])))
    expect(writes.map(result => result.code).sort()).toEqual([0, 2]); expect(writes.find(result => result.code === 2)!.result.code).toBe('CONVERSATION_LANDMARK_CONFLICT')
    expect((await store.list(scope)).revision).toBe(2)
    await writeFile(join(output, 'process-receipt.json'), JSON.stringify({ first, second, writes }, null, 2) + '\n')
  })
  it('runs actual public client and shipping CLI create/list/rename/remove against the original owner', async () => {
    const { directory, store } = await fixture(), server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), conversationLandmarks: store, coreClients: () => [] }); servers.push(server); await server.start()
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }), env = { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path }
    const input = join(directory, 'intent.json'); await writeFile(input, JSON.stringify(create()))
    try {
      const created = await run(cli, ['agent', 'conversation', 'landmark', 'apply', '--input', input], env); expect(created.code, created.stderr + created.stdout).toBe(0); expect(created.result.result.points[0].reference).toEqual(captured)
      const typed = await client.call('agent.conversation.landmark.ls', { ...scope, operationId: 'create-original' }); expect(typed.recordedOperation?.input).toEqual(create()); expect(typed.points).toEqual(created.result.result.points)
      const listed = await run(cli, ['agent', 'conversation', 'landmark', 'ls', '--host', scope.hostId, '--session', scope.agentSessionId, '--operation-id', 'create-original'], env); expect(listed.code, listed.stderr).toBe(0); expect(listed.result.result).toEqual(typed)
      await writeFile(input, JSON.stringify({ ...scope, operationId: 'rename-cli', expectedRevision: 1, change: { kind: 'rename', id: 'point-original', name: 'CLI renamed' } })); const renamed = await run(cli, ['agent', 'conversation', 'landmark', 'apply', '--input', input], env); expect(renamed.code, renamed.stderr).toBe(0); expect(renamed.result.result.points[0].name).toBe('CLI renamed')
      await writeFile(input, JSON.stringify({ ...scope, operationId: 'remove-cli', expectedRevision: 2, change: { kind: 'remove', id: 'point-original' } })); const removed = await run(cli, ['agent', 'conversation', 'landmark', 'apply', '--input', input], env); expect(removed.code, removed.stderr).toBe(0); expect(removed.result.result.points).toEqual([])
      expect(await store.list(scope)).toMatchObject({ revision: 3, points: [] })
      await writeFile(join(output, 'public-receipt.json'), JSON.stringify({ created, typed, listed, renamed, removed }, null, 2) + '\n')
    } finally { await client.dispose() }
  })
  it('generates usable object/action help and keeps unknown target metadata separate from record availability', async () => {
    const action = await run(cli, ['agent', 'conversation', 'landmark', 'apply', '--help']), domain = await run(cli, ['agent', 'conversation', 'landmark', '--help']), skill = await run(cli, ['agent', '--skill'])
    expect(action.code, action.stderr).toBe(0); expect(action.stdout).toContain('agent conversation landmark apply --input FILE|-'); expect(action.stdout).toContain('expectedRevision'); expect(action.stdout).toContain('never sends input')
    expect(domain.code, domain.stderr).toBe(0); expect(domain.stdout).toContain('landmark ls --host ID --session ID'); expect(skill.code, skill.stderr).toBe(0); expect(skill.stdout).toContain('agent conversation landmark')
    await writeFile(join(output, 'discovery-receipt.json'), JSON.stringify({ action, domain, skill }, null, 2) + '\n')
  })
})
