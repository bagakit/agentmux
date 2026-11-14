import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { startAgentMuxHost } from '../src/host.js'
import { OrdinaryWorkspaceFiles } from '../src/ordinary-files.js'
import { readHostSettingsHosts } from '../src/settings-hosts-read.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
// Own the optional evidence destination before fixture isolation clears AGENTMUX_*.
const evidencePath = process.env.AGENTMUX_TEST_SOURCE_SELECTION_EVIDENCE
const facts: Array<Record<string, unknown>> = []
afterAll(async () => { if (evidencePath) await writeFile(evidencePath, JSON.stringify({ platform: process.platform, facts }, null, 2) + '\n') })
beforeAll(async () => { await promisify(execFile)(process.execPath, [resolve('apps/host/scripts/build-workspace-move-helper.mjs')]) })
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close() }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs() }
})

async function source() {
  const original = await rpcOwnerFixture(['source-agent'], core); cleanup.push(original.close)
  const native = original.inner.kernel; await original.client.dispose()
  const configurationPath = join(original.root, 'config.json'), socketPath = join(original.root, 'host.sock'), directory = join(original.root, 'project')
  await mkdir(directory)
  await writeFile(configurationPath, JSON.stringify({ hosts: [{ id: 'local', kind: 'local', label: 'Source' }],
    workspaces: [{ id: 'same-workspace', hostId: 'local', path: directory, name: 'Source project' }] }))
  const start = async () => {
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
      const inner = this as unknown as typeof original.inner
      await inner.registry.load('local'); inner.connected = true
      for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = native[name]
      inner.kernel.listPage = async () => ({ runs: [], nextCursor: null })
    })
    try { return await startAgentMuxHost({ store: original.store, configurationPath, socketPath, desktopSocketPath: join(original.root, 'no-desktop'), mobileBuildDirectory: join(original.root, 'no-mobile') }) }
    finally { connect.mockRestore() }
  }
  let host = await start()
  cleanup.push(() => host.dispose())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanup.push(() => rpc.dispose())
  const { owner } = await rpc.call('runtime.owner.identity', {})
  const observed = await rpc.call('space.folder.inspect', { runtimeId: owner.runtimeId, path: directory })
  expect(observed.resource).not.toBeNull()
  // Same WID on different real Sources; their Zone/Space identities come from the original owner.
  const folder = await rpc.call('space.folder.register', { runtimeId: owner.runtimeId, directory: observed.resource!, workspaceId: 'same-workspace' })
  return { original, host, rpc, owner, folder, directory, socketPath,
    restart: async () => { await host.dispose(); host = await start(); return host } }
}

async function fixture() {
  const a = await source(), b = await source(), root = a.original.root
  const sshLog = join(root, 'ssh.jsonl'), wireLog = join(root, 'wire.jsonl'), configSocket = join(root, 'configuration.sock')
  const saved = (id: string, target: typeof a) => ({ id, kind: 'ssh', label: id, hostname: id, user: 'literal-user', port: 18822,
    identityFile: join(root, 'unread-key'), remoteCommand: 'literal remote amux', remoteSocketPath: target.socketPath, runtimeId: target.owner.runtimeId })
  const hosts: Record<string, unknown>[] = [saved('source-a', a), saved('source-b', b)], configurationPath = join(root, 'selector-configuration.json')
  let reads = 0
  const setHosts = async (next: typeof hosts) => {
    const local = { id: 'local', kind: 'local', label: 'Original local configuration' }
    await writeFile(configurationPath, JSON.stringify({ hosts: next.some(host => host.id === 'local') ? next : [local, ...next] }))
  }
  await setHosts(hosts)
  const configuration = new core.AgentMuxControlServer({ socketPath: configSocket,
    coreClients: () => [{ hostId: 'local', client: a.host.client }],
    execute: async request => {
      if (request.operation !== 'settings.hosts.list') throw new Error('Unexpected configuration write')
      reads++; return { operation: request.operation, hosts: await readHostSettingsHosts(configurationPath) }
    } })
  await configuration.start(); cleanup.push(() => configuration.stop())
  // Only the network connection leaf is substituted. Real SDK argv/framing/caller/fence,
  // two original Host/Core services, real Source registration and Native file effects remain.
  await writeFile(join(root, 'ssh'), `#!${process.execPath}
const {connect}=require('node:net'),{appendFileSync,writeFileSync,existsSync}=require('node:fs');
const args=process.argv.slice(2);appendFileSync(process.env.TEST_SSH_LOG,JSON.stringify(args)+'\\n');
const routes=JSON.parse(process.env.TEST_SOURCE_ROUTES),host=args[args.length-2].split('@').at(-1);
const sockets=new Set();let pending='';
function forward(line){const socket=connect(routes[host]);sockets.add(socket);socket.on('connect',()=>socket.write(line+'\\n'));socket.on('data',chunk=>process.stdout.write(chunk));socket.on('close',()=>sockets.delete(socket));socket.on('error',e=>{process.stderr.write(e.message);process.exitCode=1;process.stdin.destroy();});}
process.stdin.on('data',chunk=>{pending+=chunk;let n;while((n=pending.indexOf('\\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);if(!line)continue;const r=JSON.parse(line),p=r.params||{};appendFileSync(process.env.TEST_WIRE_LOG,JSON.stringify({host,method:r.method,runtimeFence:p.runtimeFence,hasCaller:!!p.caller,callerSessionId:p.caller?.agentSessionId})+'\\n');if(r.method===process.env.TEST_PAUSE_METHOD){writeFileSync(process.env.TEST_PAUSE_MARKER,'admitted');const timer=setInterval(()=>{if(existsSync(process.env.TEST_PAUSE_RELEASE)){clearInterval(timer);forward(line);}},10);}else forward(line);}});
process.stdin.on('end',()=>{for(const socket of sockets)socket.destroy();});
`, { mode: 0o700 })
  const env = objectCliEnvironment(root, { PATH: root + ':' + process.env.PATH, AGENTMUX_RPC_ENDPOINT: 'unix:' + configSocket,
    TEST_SOURCE_ROUTES: JSON.stringify({ 'source-a': a.socketPath, 'source-b': b.socketPath }), TEST_SSH_LOG: sshLog, TEST_WIRE_LOG: wireLog })
  const calls: unknown[] = [], fact = { sources: [a, b].map(target => ({ owner: target.owner, folder: target.folder, directory: target.directory })), calls, ssh: [] as unknown[], wire: [] as unknown[] }
  facts.push(fact)
  cleanup.push(async () => {
    for (const [key, path] of [['ssh', sshLog], ['wire', wireLog]] as const) {
      try { fact[key] = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  })
  const cli = async (args: string[], input = '', credentials: NodeJS.ProcessEnv = {}) => {
    const result = await runCompiledObjectCli(args, { ...env, ...credentials }, input)
    const body = (text: string): Record<string, unknown> | undefined => {
      try { return JSON.parse(text.split('\n')[0]!) } catch { return undefined }
    }
    const output = body(result.stdout) ?? body(result.stderr)
    calls.push({ args, code: result.code, operation: output?.operation, operationId: output?.operationId,
      source: output?.source, error: output?.error, result: args.includes('mkdir') || args.includes('mutation') ? output?.result : undefined,
      stdoutSha256: createHash('sha256').update(result.stdout).digest('hex'), stderrSha256: createHash('sha256').update(result.stderr).digest('hex') })
    return result
  }
  const records = async () => (await readFile(wireLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { a, b, cli, env, records, sshLog, get reads() { return reads }, setHosts, hosts }
}

async function mkdirInput(f: Awaited<ReturnType<typeof fixture>>, operationId: string) {
  const target = f.b, path = 'only-b', expectedResource = { hostId: 'local', workspaceId: target.folder.workspaceId, workspacePath: target.directory }
  const result = await target.rpc.call('file.stat', { zoneId: target.folder.zoneId, path, expectedResource })
  expect(result.result.status).toBe('observed')
  if (result.result.status !== 'observed') throw new Error('Actual Source stat is unavailable')
  return { zoneId: target.folder.zoneId, path, operationId, expectedResource: result.resource!, expectedAbsent: true,
    expected: { root: result.result.observation.root, parent: result.result.observation.parent } }
}

it('compiled selector uses complete saved SSH fields and the exact real Source/Native with one frozen target', async () => {
  const f = await fixture(), input = await mkdirInput(f, 'saved-source-mkdir'), writes = vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'mkdirPath')
  const result = await f.cli(['--source-host', 'source-b', 'file', 'mkdir', '--input', '-'], JSON.stringify(input))
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result).toMatchObject({ operationId: input.operationId, resource: { hostId: 'local', workspaceId: 'same-workspace', zoneId: f.b.folder.zoneId }, result: { filesystem: 'created' } })
  expect(JSON.parse(result.stdout).source).toEqual({ configuredHostId: 'source-b', runtimeId: f.b.owner.runtimeId, ownerInstanceId: f.b.owner.ownerInstanceId })
  expect(writes).toHaveBeenCalledTimes(1)
  expect(await f.a.rpc.call('file.stat', { zoneId: f.a.folder.zoneId, path: input.path, expectedResource: { hostId: 'local', workspaceId: f.a.folder.workspaceId, workspacePath: f.a.directory } })).toMatchObject({ result: { observation: { entry: { kind: 'absent' } } } })
  const argv = JSON.parse((await readFile(f.sshLog, 'utf8')).trim())
  expect(argv).toEqual(expect.arrayContaining(['-p', '18822', '-i', f.hosts[1]!.identityFile, 'literal-user@source-b']))
  expect(argv.at(-1)).toContain("'literal remote amux'"); expect(argv.at(-1)).toContain(f.b.socketPath)
  const wire = await f.records()
  expect(wire.find(row => row.method === 'file.mkdir')).toMatchObject({ host: 'source-b', runtimeFence: { runtimeId: f.b.owner.runtimeId, ownerInstanceId: f.b.owner.ownerInstanceId } })
  expect(f.reads).toBe(1)
  for (const target of [f.a, f.b]) { expect(target.original.inner.kernel.stop).not.toHaveBeenCalled(); expect(target.original.inner.kernel.input).not.toHaveBeenCalled() }
})

it('the same central port covers a non-file call, finite generic output and the special Space snapshot reader', async () => {
  const f = await fixture(), fence = { runtimeId: f.b.owner.runtimeId, ownerInstanceId: f.b.owner.ownerInstanceId }
  for (const args of [
    ['agent', 'inspect', '--session', 'source-agent'],
    ['agent', 'output', '--session', 'source-agent'],
    ['space', 'snapshot', '--runtime', f.b.owner.runtimeId, '--space', f.b.folder.reference.spaceId]
  ]) {
    const result = await f.cli(['--source-host=source-b', ...args])
    expect(result.code, result.stderr).toBe(0); expect(result.stdout.length).toBeGreaterThan(0)
    const lines = result.stdout.trim().split('\n').map(line => JSON.parse(line))
    expect(lines[0].source).toEqual({ configuredHostId: 'source-b', ...fence })
    if (args[1] === 'output') {
      expect(lines[0].event.type).toBe('source')
      expect(lines.slice(1).length).toBeGreaterThan(0)
      for (const original of lines.slice(1)) { expect(original.jsonrpc).toBe('2.0'); expect(original).not.toHaveProperty('source') }
    }
  }
  const wire = await f.records()
  for (const method of ['agent.inspect', 'agent.output', 'space.snapshot']) expect(wire.find(row => row.method === method)).toMatchObject({ host: 'source-b', runtimeFence: fence })
  expect(f.reads).toBe(3)
})

it('managed identity remains the original caller through describe and business calls, without gaining runtime administration', async () => {
  const f = await fixture(), credentials = { AGENTMUX_AGENT_SESSION_ID: 'source-agent', AGENTMUX_AGENT_CAPABILITY: f.a.original.capability }
  const allowed = await f.cli(['--source-host', 'source-a', 'agent', 'inspect', '--session', 'source-agent'], '', credentials)
  expect(allowed.code, allowed.stderr).toBe(0)
  const denied = await f.cli(['--source-host', 'source-a', 'runtime', 'owner', 'identity'], '', credentials)
  expect(denied.code).toBe(1); expect(JSON.parse(denied.stderr).error.code).toBe('AGENT_CAPABILITY_INVALID')
  const other = await f.cli(['--source-host', 'source-b', 'agent', 'inspect', '--session', 'source-agent'], '', credentials)
  expect(other.code).toBe(1)
  for (const row of (await f.records()).filter(row => ['agent.open.describe', 'agent.inspect', 'runtime.owner.identity'].includes(row.method))) expect(row).toMatchObject({ hasCaller: true, callerSessionId: 'source-agent' })
})

it('offline help and static/invalid selection do not connect or disclose saved credential fields', async () => {
  const f = await fixture()
  for (const args of [['--help'], ['--skill'], ['--version'], ['file', '--skill']]) {
    const result = await f.cli(['--source-host', 'source-b', ...args]); expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).not.toContain(String(f.hosts[1]!.identityFile))
  }
  for (const args of [['system', 'endpoint'], ['system', 'endpoint', '--stdio'], ['mote', 'playbook', 'pmo'], ['--endpoint', 'unix:/nonexistent', 'agent', 'ls']]) {
    const result = await f.cli(['--source-host', 'source-b', ...args]); expect(result.code).toBe(1)
  }
  expect(f.reads).toBe(0); await expect(readFile(f.sshLog)).rejects.toMatchObject({ code: 'ENOENT' })
  const remote = await runCompiledObjectCli(['--source-host', 'source-b', 'agent', 'ls'], { ...f.env, AGENTMUX_RPC_ENDPOINT: 'https://example.invalid/' })
  expect(remote.code).toBe(1); expect(f.reads).toBe(0)
  await f.setHosts([{ id: 'local', kind: 'local', label: 'Local' }, { ...f.hosts[1], runtimeId: undefined }])
  for (const id of ['local', 'source-b', 'missing']) expect((await f.cli(['--source-host', id, 'agent', 'ls'])).code).toBe(1)
  await expect(readFile(f.sshLog)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('wrong bound Runtime is rejected before Native and an alias edit after a positive effect cannot erase its ACK', async () => {
  const f = await fixture(), input = await mkdirInput(f, 'late-alias-ack'), writes = vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'mkdirPath')
  await f.setHosts([{ ...f.hosts[1], runtimeId: f.a.owner.runtimeId }])
  const wrong = await f.cli(['--source-host', 'source-b', 'file', 'mkdir', '--input', '-'], JSON.stringify(input))
  expect(wrong.code).toBe(1); expect(JSON.parse(wrong.stderr).error.code).toBe('RUNTIME_OWNER_MISMATCH'); expect(writes).not.toHaveBeenCalled()
  await f.setHosts(f.hosts)
  const service = (f.b.host.server as unknown as { service: core.AgentMuxRpcService }).service, call = service.call.bind(service)
  vi.spyOn(service, 'call').mockImplementation(async (method, params, context) => {
    const result = await call(method, params, context)
    if (method === 'file.mkdir') await f.setHosts([{ ...f.hosts[1], hostname: 'source-a', runtimeId: f.a.owner.runtimeId }])
    return result
  })
  const positive = await f.cli(['--source-host', 'source-b', 'file', 'mkdir', '--input', '-'], JSON.stringify(input))
  expect(positive.code, positive.stderr).toBe(0); expect(JSON.parse(positive.stdout).result.result.filesystem).toBe('created')
  expect(JSON.parse(positive.stdout).source).toEqual({ configuredHostId: 'source-b', runtimeId: f.b.owner.runtimeId, ownerInstanceId: f.b.owner.ownerInstanceId })
  expect(writes).toHaveBeenCalledTimes(1); expect(f.reads).toBe(2)
})

it('a real replacement owner of the same Runtime rejects the captured instance before a Native effect', async () => {
  const f = await fixture(), input = await mkdirInput(f, 'same-runtime-new-instance'), writes = vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'mkdirPath')
  const marker = join(f.b.original.root, 'request-waiting'), release = join(f.b.original.root, 'release-request')
  const pending = f.cli(['--source-host', 'source-b', 'file', 'mkdir', '--input', '-'], JSON.stringify(input),
    { TEST_PAUSE_METHOD: 'file.mkdir', TEST_PAUSE_MARKER: marker, TEST_PAUSE_RELEASE: release })
  cleanup.push(async () => { await writeFile(release, 'cleanup'); await pending.catch(() => {}) })
  await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('admitted'), { timeout: 10_000 })
  await f.b.restart()
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.b.socketPath } }); cleanup.push(() => rpc.dispose())
  const current = (await rpc.call('runtime.owner.identity', {})).owner
  expect(current.runtimeId).toBe(f.b.owner.runtimeId); expect(current.ownerInstanceId).not.toBe(f.b.owner.ownerInstanceId)
  await expect(rpc.call('runtime.owner.identity', {}, { runtimeFence: { runtimeId: f.b.owner.runtimeId, ownerInstanceId: f.b.owner.ownerInstanceId } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  await writeFile(release, 'continue')
  const result = await pending
  expect(result.code).toBe(1); expect(JSON.parse(result.stderr).error.code).toBe('RUNTIME_OWNER_CHANGED')
  expect(writes).not.toHaveBeenCalled()
  expect((await f.records()).filter(row => row.method === 'file.mkdir')).toHaveLength(1)
  const inspect = { zoneId: input.zoneId, path: input.path, expectedResource: input.expectedResource, operationId: input.operationId }
  const later = await f.cli(['--source-host', 'source-b', 'file', 'mutation', 'inspect', '--input', '-'], JSON.stringify(inspect))
  // This read succeeded. Its typed observation still says the original effect
  // is unknown; it neither confirms an action nor reuses the old instance.
  expect(later.code, later.stderr).toBe(0)
  expect(JSON.parse(later.stdout)).toMatchObject({ source: { runtimeId: current.runtimeId, ownerInstanceId: current.ownerInstanceId }, result: { operationId: input.operationId, result: { filesystem: 'unknown' } } })
  expect(writes).not.toHaveBeenCalled()
})

it('credential and receiver preflights stay on the captured Source and do not fallback to a configuration owner', async () => {
  const f = await fixture(), fence = { runtimeId: f.b.owner.runtimeId, ownerInstanceId: f.b.owner.ownerInstanceId }
  for (const args of [
    ['connection', 'credential', 'inspect', '--operation-id', 'never-created'],
    ['connection', 'receiver', 'inspect', '--operation-id', 'never-created', '--runtime', f.b.owner.runtimeId]
  ]) {
    // These private Sources have no connector service. Its actual unavailable
    // result remains unavailable; selector coverage is the real preflight route.
    const result = await f.cli(['--source-host', 'source-b', ...args]); expect(result.code).toBe(1)
  }
  const wire = await f.records()
  for (const method of ['runtime.owner.identity', 'connection.credential.inspect', 'connection.owner.inspect']) {
    expect(wire.filter(row => row.method === method).length).toBeGreaterThan(0)
    for (const row of wire.filter(row => row.method === method)) expect(row).toMatchObject({ host: 'source-b', runtimeFence: fence })
  }
  expect(f.reads).toBe(2)
})

it('a lost effect reply retains its exact operation and is not replayed by selection or inspection', async () => {
  const f = await fixture(), input = await mkdirInput(f, 'unknown-source-effect'), writes = vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'mkdirPath')
  const service = (f.b.host.server as unknown as { service: core.AgentMuxRpcService }).service, call = service.call.bind(service)
  vi.spyOn(service, 'call').mockImplementation(async (method, params, context) => {
    const result = await call(method, params, context)
    if (method === 'file.mkdir') throw new core.AgentMuxError('Private lost reply after the original positive effect', 'PRIVATE_REPLY_LOST')
    return result
  })
  const unknown = await f.cli(['--source-host', 'source-b', 'file', 'mkdir', '--input', '-'], JSON.stringify(input))
  expect(unknown.code).toBe(1); expect(JSON.parse(unknown.stderr)).toMatchObject({ operationId: input.operationId, error: { code: 'PRIVATE_REPLY_LOST' } })
  expect(JSON.parse(unknown.stderr).source).toEqual({ configuredHostId: 'source-b', runtimeId: f.b.owner.runtimeId, ownerInstanceId: f.b.owner.ownerInstanceId })
  expect(writes).toHaveBeenCalledTimes(1)
  await f.b.restart()
  const inspect = { zoneId: input.zoneId, path: input.path, expectedResource: input.expectedResource, operationId: input.operationId }
  const observed = await f.cli(['--source-host', 'source-b', 'file', 'mutation', 'inspect', '--input', '-'], JSON.stringify(inspect))
  expect(observed.code, observed.stderr).toBe(0); expect(JSON.parse(observed.stdout).result.result.filesystem).toBe('created')
  expect(JSON.parse(observed.stdout).source.runtimeId).toBe(f.b.owner.runtimeId)
  expect(JSON.parse(observed.stdout).source.ownerInstanceId).not.toBe(f.b.owner.ownerInstanceId)
  expect(writes).toHaveBeenCalledTimes(1)
})
