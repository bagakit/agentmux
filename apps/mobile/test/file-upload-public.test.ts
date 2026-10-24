// @vitest-environment node
import { fixturePath } from '../../../test/fixture-values.mjs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir, stat, rename, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { FileUploadOwner } from '../../host/src/file-upload-owner'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { parseFileUploadIdentity, parseFileUploadParams, parseFileUploadResult, fileUploadRevision, FILE_UPLOAD_MAX_BYTES,
  type FileUploadIdentity, type FileUploadParams } from '../../../packages/core/src/public-rpc-files'
import { AgentMuxRpcService, type AgentMuxRpcCorePort } from '../../../packages/core/src/public-rpc-service'
import { rpcEncode } from '../../../packages/core/src/public-rpc-frame'
import { EncryptedChannel } from '../../../packages/relay/src/encrypted-channel'
import { generateKeyPair, exportPublicKey } from '../../../packages/relay/src/e2ee'
import { parseConnectionOfferUrl } from '../../../packages/relay/src/connection-offer'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client'
import { HostedRelayRpcPort } from '../../../packages/core/src/relay-hosted'
import { mobileRelease } from '../../host/test/helpers/mobile-web-fixture'
import { AgentMuxError } from '../../../packages/core/src/errors'

const repository = resolve(import.meta.dirname, '../../..')
let root: string, owner: FileUploadOwner, cli: string, hostEntry: string, relayHostEntry: string
const session = { agentSessionId: 'session-original', hostId: 'local', run: { runId: 'run-original' } }
const port = { agentSession: (id: string) => { if (id !== session.agentSessionId) throw new Error('Absent exact cache entry'); return session },
  agentSessions: () => [session], readAgentSession: async (id: string) => id === session.agentSessionId ? session : null,
  readAgentSessions: async () => [session], sessionHistorySources: async () => [] } as unknown as AgentMuxRpcCorePort
const clients = () => [{ hostId: 'local', client: port }]
function upload(operationId: string, text = 'original file bytes', mimeType = 'text/plain', name = 'notes.md'): FileUploadParams {
  const bytes = Buffer.from(text)
  return { hostId: 'local', agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, operationId,
    name, mimeType, byteLength: bytes.length, revision: fileUploadRevision(bytes), dataBase64: bytes.toString('base64') }
}
function identity(input: FileUploadParams): FileUploadIdentity { const { dataBase64: _bytes, ...original } = input; return original }
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'amx-file-upload-'))
  owner = new FileUploadOwner(join(root, 'attachments'))
  // Compile only the original CLI and its public dependencies into a private test artifact.
  const require = createRequire(resolve(repository, 'packages/core/package.json'))
  const { build } = require('esbuild')
  const aliases: Record<string, string> = {}
  for (const name of ['core', 'demand', 'layout', 'relay']) {
    const folder = resolve(repository, 'packages', name), manifest = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'))
    for (const [subpath, target] of Object.entries(manifest.exports) as Array<[string, { import: string }]>) {
      if (subpath.includes('*')) continue
      aliases['@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))] = resolve(folder,
        target.import.replace('./dist/', ['core', 'relay'].includes(name) ? './src/' : './').replace(/\.js$/, '.ts'))
    }
  }
  await mkdir(join(root, 'dist'))
  for (const [name, source] of [['node_modules', 'apps/host/node_modules'], ['bin', 'packages/core/bin'], ['vendor', 'packages/core/vendor'], ['guides', 'packages/core/guides']]) {
    await symlink(join(repository, source!), join(root, name!), 'dir')
  }
  cli = join(root, 'dist/cli.mjs'); hostEntry = join(root, 'dist/host.mjs'); relayHostEntry = join(root, 'dist/relay-host.mjs')
  const buildOptions = { absWorkingDir: repository,
    alias: aliases, bundle: true, format: 'esm', platform: 'node', target: 'node24', metafile: true, logLevel: 'error',
    banner: { js: "import {createRequire as privateCreateRequire} from 'node:module';const require=privateCreateRequire(import.meta.url);" },
    plugins: [{ name: 'original-dependencies', setup(plugin: any) {
      plugin.onResolve({ filter: /^[^./]/ }, async (args: any) => {
        if (args.pluginData?.originalResolution || args.path.startsWith('node:') || args.path.startsWith('@agentmux/')) return
        const resolved = await plugin.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { originalResolution: true } })
        return { path: resolved.path, external: true, errors: resolved.errors }
      })
    } }] }
  const result = await build({ ...buildOptions, entryPoints: ['packages/core/src/agentmux.ts'], outfile: cli })
  expect(Object.keys(result.metafile.inputs)).toContain('packages/core/src/agentmux.ts')
  expect(Object.keys(result.metafile.inputs)).toContain('packages/core/src/agentmux-cli-commands.ts')
  const evidence = process.env.AGENTMUX_MOBILE_ATTACHMENTS_EVIDENCE
  if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, 'cli-inputs.json'), JSON.stringify(result.metafile, null, 2)) }
  const hostBuild = await build({ ...buildOptions, entryPoints: ['apps/host/src/index.ts'], outfile: hostEntry })
  expect(Object.keys(hostBuild.metafile.inputs)).toContain('apps/host/src/index.ts')
  expect(Object.keys(hostBuild.metafile.inputs)).toContain('apps/host/src/host.ts')
  expect(Object.keys(hostBuild.metafile.inputs)).toContain('packages/core/src/public-rpc-service.ts')
  // The second process uses the same unmodified Host assembly on a private ephemeral
  // Relay port. It neither supplies an upload owner nor substitutes a Core service.
  await build({ ...buildOptions, outfile: relayHostEntry, stdin: { sourcefile: 'private-relay-host.ts', resolveDir: repository,
    contents: `import { startAgentMuxHost, agentMuxHostStore } from './apps/host/src/host.ts';
      const host = await startAgentMuxHost({ store: agentMuxHostStore(process.env.AGENTMUX_AGENT_SESSION_STORE),
        mobileBuildDirectory: process.env.AGENTMUX_MOBILE_BUILD_DIRECTORY, mobilePort: 0 });
      for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void host.dispose().then(() => process.exit(0), error => { console.error(error); process.exit(1) }));
      process.stdout.write(JSON.stringify(await host.hosted.call('runtime.owner.identity', {})) + '\\n');` } })
  if (evidence) await writeFile(join(evidence, 'host-inputs.json'), JSON.stringify(hostBuild.metafile, null, 2))
}, 30000)
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

describe('original Host file upload owner and public transport', () => {
  it('persists exact bounded bytes with private modes, reads them back and survives owner restart', async () => {
    const input = upload('durable'), result = await owner.upload(input)
    expect(result.status).toBe('uploaded')
    if (result.status !== 'uploaded') throw new Error('Actual file receipt required')
    expect(await readFile(result.path, 'utf8')).toBe('original file bytes')
    expect((await stat(result.path)).mode & 0o777).toBe(0o600)
    expect(await new FileUploadOwner(join(root, 'attachments')).inspect(identity(input))).toEqual(result)
    expect(await owner.upload(input)).toEqual(result)
  })
  it('does not overwrite the same operation for different bytes, name, Session, Host or Run', async () => {
    const original = upload('immutable'), result = await owner.upload(original)
    expect(result.status).toBe('uploaded')
    for (const changed of [upload('immutable', 'foreign'), { ...original, name: 'foreign.md' },
      { ...original, agentSessionId: 'other' }, { ...original, hostId: 'other' }, { ...original, expectedRun: { runId: 'other' } }]) {
      expect((await owner.upload(changed)).status).toBe('unknown')
    }
    expect(await owner.inspect(identity(original))).toEqual(result)
  })
  it('serializes a duplicate action and returns the same single file', async () => {
    const input = upload('double-click')
    const results = await Promise.all([owner.upload(input), owner.upload(input)])
    expect(results[0].status).toBe('uploaded'); expect(results[1]).toEqual(results[0])
  })
  it('rejects content mismatch before writing and keeps unknown changed or missing original bytes', async () => {
    const mismatch = upload('digest'), bad = await owner.upload({ ...mismatch, revision: 'sha256:' + '0'.repeat(64) })
    expect(bad.status).toBe('error'); expect((await owner.inspect(identity(mismatch))).status).toBe('missing')
    const input = upload('changed'), result = await owner.upload(input)
    if (result.status !== 'uploaded') throw new Error('Actual file receipt required')
    const changed = 'x'.repeat(input.byteLength)
    await writeFile(result.path, changed)
    expect((await owner.inspect(identity(input))).status).toBe('unknown')
    expect((await owner.upload(input)).status).toBe('unknown')
    expect(await readFile(result.path, 'utf8')).toBe(changed)
    await rm(result.path)
    expect((await owner.inspect(identity(input))).status).toBe('unknown')
  })
  it('does not follow a substituted original file link', async () => {
    const input = upload('linked'), result = await owner.upload(input)
    if (result.status !== 'uploaded') throw new Error('Actual file receipt required')
    const foreign = join(root, 'foreign.txt'); await writeFile(foreign, 'foreign')
    await rm(result.path); await symlink(foreign, result.path)
    expect((await owner.inspect(identity(input))).status).toBe('unknown')
    expect(await readFile(foreign, 'utf8')).toBe('foreign')
  })
  it('does not read through a substituted Host upload directory', async () => {
    const folder = join(root, 'original-upload-folder'), retained = join(root, 'retained-upload-folder')
    const original = new FileUploadOwner(folder), input = upload('root-link'), result = await original.upload(input)
    expect(result.status).toBe('uploaded')
    await rename(folder, retained); await symlink(retained, folder)
    expect((await original.inspect(identity(input))).status).toBe('unknown')
    expect((await original.upload(input))).toMatchObject({ status: 'unknown' })
  })
  it('checks the authoritative original Session and exact Host/Run before Host persistence', async () => {
    const service = new AgentMuxRpcService({ fileUploads: owner, coreClients: clients })
    for (const input of [{ ...upload('wrong-host'), hostId: 'foreign' }, { ...upload('wrong-run'), expectedRun: { runId: 'foreign' } },
      { ...upload('prefix'), agentSessionId: 'session' }]) {
      await expect(service.call('file.upload', input, { principal: { kind: 'user', id: 'test' } })).rejects.toMatchObject({ code: 'FILE_UPLOAD_TARGET_MISMATCH' })
      expect((await owner.inspect(identity(input))).status).toBe('missing')
    }
    const heicInput = upload('original-heic', 'heic image bytes', 'image/heic', 'photo.HEIC')
    const context = { principal: { kind: 'device' as const, id: 'phone-1' }, assertCurrent: () => {} }
    const uploaded = await service.call('file.upload', heicInput, context)
    expect(uploaded).toMatchObject({ status: 'uploaded' })
    if (uploaded.status === 'uploaded') expect(uploaded.path.endsWith('.heic')).toBe(true)
    expect(await service.call('file.upload.inspect', identity(heicInput), context)).toEqual(uploaded)
    await service.dispose()
  })
  it('uses exact durable Session point reads and does not hide an incomplete port behind inventory scans', async () => {
    const readAgentSession = vi.fn(port.readAgentSession), readAgentSessions = vi.fn(port.readAgentSessions)
    const service = new AgentMuxRpcService({ fileUploads: owner, coreClients: () => [{ hostId: 'local', client: { ...port, readAgentSession, readAgentSessions } }] })
    try {
      expect(await service.call('file.upload', upload('exact-read'))).toMatchObject({ status: 'uploaded' })
      expect(readAgentSession.mock.calls).toEqual([['session-original']]); expect(readAgentSessions).not.toHaveBeenCalled()
    } finally { await service.dispose() }
    const incomplete = new AgentMuxRpcService({ fileUploads: owner,
      coreClients: () => [{ hostId: 'local', client: { ...port, readAgentSession: undefined, readAgentSessions } as unknown as AgentMuxRpcCorePort }] })
    try {
      await expect(incomplete.call('file.upload', upload('missing-port-method'))).rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_READ_UNCONFIRMED' })
      expect(readAgentSessions).not.toHaveBeenCalled()
      expect(await owner.inspect(identity(upload('missing-port-method')))).toMatchObject({ status: 'missing' })
    } finally { await incomplete.dispose() }
  })
  it('rechecks the original device after target reads and rejects missing or revoked authority without changing the Agent', async () => {
    const input = upload('revoked-during-target-read'), principal = { kind: 'device' as const, id: 'original-phone' }
    let current = true
    const authorityOrder: string[] = []
    const readAgentSession = vi.fn(async () => { authorityOrder.push('original-session-read'); current = false; return session })
    const service = new AgentMuxRpcService({ fileUploads: owner,
      coreClients: () => [{ hostId: 'local', client: { ...port, readAgentSession } as unknown as AgentMuxRpcCorePort }] })
    const assertCurrent = vi.fn(() => { authorityOrder.push(current ? 'current' : 'revoked'); if (!current) throw new AgentMuxError('Original device was revoked', 'CONTROL_PERMISSION_DENIED') })
    try {
      await expect(service.call('file.upload', input, { principal, assertCurrent })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
      expect(readAgentSession).toHaveBeenCalledOnce(); expect(authorityOrder.slice(-2)).toEqual(['original-session-read', 'revoked'])
      expect(await owner.inspect(identity(input))).toMatchObject({ status: 'missing' })
      await expect(service.call('file.upload.inspect', identity(input), { principal, assertCurrent })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
      await expect(service.call('file.upload', input, { principal })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
      await expect(service.call('file.upload.inspect', identity(input), { principal })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
      expect(port.agentSession('session-original')).toEqual(session)
    } finally { await service.dispose() }
  })
  it('preserves public codec identity and rejects paths, oversize, invalid MIME and foreign receipts', () => {
    const input = upload('codec'), original = identity(input)
    expect(parseFileUploadParams(input)).toEqual(input)
    for (const changed of [{ ...input, path: fixturePath("foreign") }, { ...input, name: '../foreign' }, { ...input, byteLength: FILE_UPLOAD_MAX_BYTES + 1 },
      { ...input, mimeType: 'video/mp4' }, { ...input, mimeType: 'audio/mpeg' }, { ...input, mimeType: 'image/svg+xml' }, { ...input, dataBase64: '!' }]) {
      expect(() => parseFileUploadParams(changed)).toThrow()
    }
    expect(() => parseFileUploadResult({ ...original, status: 'uploaded', path: fixturePath("private-owner/file"), hostId: 'foreign' }, original)).toThrow('Another upload')
    expect(() => parseFileUploadIdentity({ ...original, expectedRun: { runId: 'run-original', foreign: true } })).toThrow()
  })
  it('keeps the actual maximal RPC and double-base64 encrypted frame below the existing 8 MiB budget', () => {
    const bytes = Buffer.alloc(FILE_UPLOAD_MAX_BYTES, 255), input = { ...upload('frame'), hostId: 'h'.repeat(256), agentSessionId: 's'.repeat(256),
      expectedRun: { runId: 'r'.repeat(256) }, operationId: 'o'.repeat(256), name: '龙'.repeat(256),
      byteLength: bytes.length, revision: fileUploadRevision(bytes), dataBase64: bytes.toString('base64') }
    expect(parseFileUploadParams(input)).toEqual(input)
    const rpc = rpcEncode({ jsonrpc: '2.0', id: 'i'.repeat(256), method: 'file.upload', params: input })
    const channel = new EncryptedChannel({ send() {}, close() {}, onmessage: null, onclose: null, onerror: null }, new Uint8Array(32))
    const wire = channel.outboundWireByteLength(rpc)
    expect(wire).toBeLessThan(8 * 1024 * 1024)
    expect(wire).toBeGreaterThan(7 * 1024 * 1024)
    if (process.env.AGENTMUX_MOBILE_ATTACHMENTS_EVIDENCE) writeFileSync(join(process.env.AGENTMUX_MOBILE_ATTACHMENTS_EVIDENCE, 'frame-capacity.json'),
      JSON.stringify({ passed: true, fileBytes: bytes.length, plaintextBytes: Buffer.byteLength(rpc), encryptedBytes: wire, unchangedRelayBudgetBytes: 8 * 1024 * 1024 }) + '\n')
  })
  it('uses actual public client and actual CLI to persist and reconcile the original operation', async () => {
    const server = new AgentMuxControlServer({ fileUploads: owner, coreClients: clients }, join(root, 'rpc.sock'))
    await server.start()
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    const input = upload('client-original')
    try {
      const actual = await client.call('file.upload', input)
      expect(actual.status).toBe('uploaded')
      const inspection = await client.call('file.upload.inspect', identity(input)); expect(inspection).toEqual(actual)
      const env: NodeJS.ProcessEnv = { ...process.env, AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path }
      delete env.AGENTMUX_AGENT_SESSION_ID; delete env.AGENTMUX_AGENT_CAPABILITY
      const cliInput = upload('cli-original', 'CLI original bytes'), file = join(root, 'upload.json'), check = join(root, 'inspect.json')
      await writeFile(file, JSON.stringify(cliInput)); await writeFile(check, JSON.stringify(identity(cliInput)))
      const run = promisify(execFile)
      const written = JSON.parse((await run(process.execPath, [cli, 'file', 'upload', '--input', file], { env })).stdout)
      expect(written.ok).toBe(true); expect(written.result.status).toBe('uploaded')
      expect(await readFile(written.result.path, 'utf8')).toBe('CLI original bytes')
      const inspected = JSON.parse((await run(process.execPath, [cli, 'file', 'upload', 'inspect', '--input', check], { env })).stdout)
      expect(inspected.result).toEqual(written.result)
      for (const args of [['file', '--help'], ['file', 'upload', '--help'], ['file', 'upload', 'inspect', '--help'], ['file', '--skill']]) {
        const help = (await run(process.execPath, [cli, ...args], { env })).stdout
        expect(help).toContain(args.includes('inspect') ? 'original upload' : args[1] === '--skill' ? 'amux file --help' : args[1] === '--help' ? 'file upload' : '4 MiB')
      }
    } finally { await client.dispose(); await server.stop() }
  }, 20000)
  it('the production Host entry uploads without Desktop, retains receipts across restart, and authorizes the original encrypted device', async () => {
    const directory = join(root, 'headless'), home = join(directory, 'home'), runtime = join(directory, 'runtime'), state = join(directory, 'state')
    const assets = join(directory, 'mobile'), socketPath = join(runtime, 'control.sock')
    await Promise.all([mkdir(home, { recursive: true }), mkdir(runtime, { recursive: true, mode: 0o700 }),
      mkdir(join(state, 'ctxmux'), { recursive: true, mode: 0o700 }), mkdir(join(assets, 'assets'), { recursive: true })])
    await mobileRelease(assets, 'private-upload-build')
    const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))),
      HOME: home, ZDOTDIR: home, SHELL: '/bin/zsh', AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
      AGENTMUX_AGENT_SESSION_STORE: join(state, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(state, 'messages.ndjson') }
    const daemon = spawn(join(repository, 'packages/core/vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
      ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'],
      { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    let nativeError = '', hostError = '', host: ChildProcess | undefined
    daemon.stderr!.on('data', value => { nativeError += String(value) })
    let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
    let hosted: Awaited<ReturnType<typeof connectHostedAgentMux>> | undefined
    const devices: HostedRelayRpcPort[] = []
    const stop = async (child?: ChildProcess) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return
      const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended
    }
    const releaseConsumer = async () => { await hosted?.dispose(); hosted = undefined; await rpc?.dispose(); rpc = undefined }
    const start = async (relay = false) => {
      let stdout = ''; hostError = ''
      host = spawn(process.execPath, [relay ? relayHostEntry : hostEntry, '--store', env.AGENTMUX_AGENT_SESSION_STORE!],
        { env: { ...env, AGENTMUX_MOBILE_BUILD_DIRECTORY: relay ? assets : join(directory, 'absent-mobile') }, stdio: ['ignore', 'pipe', 'pipe'] })
      host.stdout!.on('data', value => { stdout += String(value) }); host.stderr!.on('data', value => { hostError += String(value) })
      await vi.waitFor(() => { expect(host!.exitCode, hostError).toBeNull(); expect(stdout, hostError).toContain('\n') }, { timeout: 15_000 })
      const published = JSON.parse(stdout.split('\n')[0]!)
      expect(published.owner.processId).toBe(host.pid)
      await expect(stat(socketPath + '.desktop')).rejects.toMatchObject({ code: 'ENOENT' })
      rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
      hosted = await connectHostedAgentMux({ rpc }); await hosted.connect()
      return published.owner
    }
    try {
      await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(([code]) => { throw new Error(`Private Native exited ${code}: ${nativeError}`) })])
      const firstOwner = await start()
      const original = await hosted!.createAgent({ providerId: 'codex', executorId: 'codex',
        agentSessionId: 'private-headless-upload', createOperationId: 'private-headless-upload-create', workspacePath: directory,
        commandOverride: join(repository, 'packages/core/test/fixtures/fake-codex-cli.mjs'), args: [],
        env: { AGENTMUX_FAKE_READY_MODE: 'before' }, injectAgentMuxGuide: false })
      const originalRun = await hosted!.statusAgent(original.agentSessionId)
      expect(originalRun.run.state).toBe('running'); expect(originalRun.run.pid).toBeGreaterThan(1)
      const input = { ...upload('actual-headless-host', 'actual default Host bytes'), agentSessionId: original.agentSessionId, expectedRun: original.run }
      const inputPath = join(directory, 'upload.json'), inspectPath = join(directory, 'inspect.json')
      await writeFile(inputPath, JSON.stringify(input)); await writeFile(inspectPath, JSON.stringify(identity(input)))
      const run = promisify(execFile), cliEnv = { ...env, AGENTMUX_RPC_ENDPOINT: 'unix:' + socketPath }
      const receipt = JSON.parse((await run(process.execPath, [cli, 'file', 'upload', '--input', inputPath], { env: cliEnv })).stdout)
      expect(receipt).toMatchObject({ ok: true, result: { ...identity(input), status: 'uploaded' } })
      expect(dirname(dirname(receipt.result.path))).toBe(await realpath(join(home, '.agentmux', 'attachments')))
      expect(await readFile(receipt.result.path, 'utf8')).toBe('actual default Host bytes')
      expect(await rpc!.call('file.upload.inspect', identity(input))).toEqual(receipt.result)
      for (const changed of [{ ...input, hostId: 'another-host' }, { ...input, agentSessionId: original.agentSessionId.slice(0, -1) },
        { ...input, expectedRun: { runId: 'another-run' } }]) {
        await expect(rpc!.call('file.upload', changed)).rejects.toMatchObject({ code: 'FILE_UPLOAD_TARGET_MISMATCH' })
      }
      await releaseConsumer(); await stop(host)
      const secondOwner = await start()
      expect(secondOwner.runtimeId).toBe(firstOwner.runtimeId); expect(secondOwner.processId).not.toBe(firstOwner.processId)
      const inspected = JSON.parse((await run(process.execPath, [cli, 'file', 'upload', 'inspect', '--input', inspectPath], { env: cliEnv })).stdout)
      expect(inspected.result).toEqual(receipt.result)
      expect(await rpc!.call('file.upload', input)).toEqual(receipt.result)
      expect((await hosted!.statusAgent(original.agentSessionId)).run).toMatchObject({ runId: original.run.runId, pid: originalRun.run.pid, state: 'running' })
      await releaseConsumer(); await stop(host)
      await start(true)
      await vi.waitFor(async () => expect((await rpc!.call('device.ls', {})).mobileAccess.state).toBe('connected'), { timeout: 10_000 })
      const offer = parseConnectionOfferUrl((await rpc!.call('device.link', {})).url)!
      // The transport key, not any request field, establishes the device principal.
      const key = generateKeyPair(), otherKey = generateKeyPair()
      const phone = new HostedRelayRpcPort({ offer, keyPair: key }), other = new HostedRelayRpcPort({ offer, keyPair: otherKey })
      devices.push(phone, other)
      const hello = await phone.forward('device.hello', { name: 'Original upload phone' })
      const otherHello = await other.forward('device.hello', { name: 'Other healthy phone' })
      expect(hello.device.keyFingerprint).toBe(fileUploadRevision(Buffer.from(exportPublicKey(key.publicKey))))
      expect(otherHello.device.deviceId).not.toBe(hello.device.deviceId)
      await expect(phone.forward('device.ls', {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
      const phoneInput = { ...input, operationId: 'encrypted-original-phone' }
      const phoneReceipt = await phone.forward('file.upload', phoneInput)
      expect(phoneReceipt).toMatchObject({ status: 'uploaded', operationId: phoneInput.operationId })
      expect(await phone.forward('file.upload.inspect', identity(phoneInput))).toEqual(phoneReceipt)
      await expect(phone.forward('file.upload', { ...phoneInput, expectedRun: { runId: 'another-run' } })).rejects.toMatchObject({ code: 'FILE_UPLOAD_TARGET_MISMATCH' })
      const revoked = await rpc!.call('device.revoke', { deviceId: hello.device.deviceId })
      expect(revoked.device).toMatchObject({ deviceId: hello.device.deviceId, revokedAt: expect.any(Number) })
      await expect(phone.forward('file.upload', { ...phoneInput, operationId: 'revoked-phone-upload' })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
      expect(await rpc!.call('file.upload.inspect', identity({ ...phoneInput, operationId: 'revoked-phone-upload' }))).toMatchObject({ status: 'missing' })
      expect(await other.forward('file.upload.inspect', identity(phoneInput))).toEqual(phoneReceipt)
      expect((await hosted!.statusAgent(original.agentSessionId)).run).toMatchObject({ runId: original.run.runId, pid: originalRun.run.pid, state: 'running' })
      if (phoneReceipt.status !== 'uploaded') throw new Error('Actual encrypted upload receipt required')
      await writeFile(phoneReceipt.path, 'changed bytes')
      expect(await other.forward('file.upload.inspect', identity(phoneInput))).toMatchObject({ ...identity(phoneInput), status: 'unknown', code: 'FILE_UPLOAD_UNCONFIRMED' })
      expect(await readFile(phoneReceipt.path, 'utf8')).toBe('changed bytes')
      const evidence = process.env.AGENTMUX_MOBILE_ATTACHMENTS_EVIDENCE
      if (evidence) await writeFile(join(evidence, 'headless-upload.json'), JSON.stringify({ actualHostEntry: 'apps/host/src/index.ts',
        desktopSocketAbsent: true, firstOwner, secondOwner, originalSessionId: original.agentSessionId, originalRun: originalRun.run,
        receipt: receipt.result, restartedReceipt: inspected.result, deviceId: hello.device.deviceId, otherDeviceId: otherHello.device.deviceId,
        publicCliUploadAndInspect: true, revokedWriteAbsent: true, retainedRun: true, changedFileUnknown: true }, null, 2))
      await hosted!.stopAgent(original.agentSessionId, original.run)
    } finally {
      const errors: unknown[] = []
      for (const close of [...devices.map(device => () => device.dispose()), releaseConsumer, () => stop(host), () => stop(daemon)]) {
        try { await close() } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'Private upload Host cleanup failed')
    }
  }, 60000)
})
