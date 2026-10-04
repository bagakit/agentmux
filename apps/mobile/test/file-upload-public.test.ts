import { fixturePath } from '../../../test/fixture-values.mjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir, stat, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { FileUploadOwner } from '../../desktop/src/main/file-upload-owner'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { parseFileUploadIdentity, parseFileUploadParams, parseFileUploadResult, fileUploadRevision, FILE_UPLOAD_MAX_BYTES,
  type FileUploadIdentity, type FileUploadParams } from '../../../packages/core/src/public-rpc-files'
import { AgentMuxRpcService, type AgentMuxRpcCorePort } from '../../../packages/core/src/public-rpc-service'
import { rpcEncode } from '../../../packages/core/src/public-rpc-frame'
import { EncryptedChannel } from '../../../packages/relay/src/encrypted-channel'

const repository = resolve(import.meta.dirname, '../../..')
let root: string, owner: FileUploadOwner, cli: string
const session = { agentSessionId: 'session-original', hostId: 'local', run: { runId: 'run-original' } }
const port = { agentSessions: () => [session], readAgentSessions: async () => [session], sessionHistorySources: async () => [] } as unknown as AgentMuxRpcCorePort
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
  cli = join(root, 'cli.mjs')
  const result = await build({ absWorkingDir: repository, entryPoints: ['packages/core/src/agentmux.ts'], outfile: cli,
    alias: aliases, bundle: true, format: 'esm', platform: 'node', target: 'node24', metafile: true, logLevel: 'error',
    banner: { js: "import {createRequire as privateCreateRequire} from 'node:module';const require=privateCreateRequire(import.meta.url);" },
    plugins: [{ name: 'original-dependencies', setup(plugin: any) {
      plugin.onResolve({ filter: /^[^./]/ }, async (args: any) => {
        if (args.pluginData?.originalResolution || args.path.startsWith('node:') || args.path.startsWith('@agentmux/')) return
        const resolved = await plugin.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { originalResolution: true } })
        return { path: resolved.path, external: true, errors: resolved.errors }
      })
    } }] })
  expect(Object.keys(result.metafile.inputs)).toContain('packages/core/src/agentmux.ts')
  expect(Object.keys(result.metafile.inputs)).toContain('packages/core/src/agentmux-cli-commands.ts')
  const evidence = process.env.AGENTMUX_MOBILE_ATTACHMENTS_EVIDENCE
  if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, 'cli-inputs.json'), JSON.stringify(result.metafile, null, 2)) }
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
    await writeFile(result.path, 'same length wrong!')
    expect((await owner.inspect(identity(input))).status).toBe('unknown')
    expect((await owner.upload(input)).status).toBe('unknown')
    expect(await readFile(result.path, 'utf8')).toBe('same length wrong!')
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
    await service.dispose()
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
      for (const args of [['--help'], ['file', 'upload', '--help'], ['file', 'upload', 'inspect', '--help'], ['--skill']]) {
        const help = (await run(process.execPath, [cli, ...args], { env })).stdout
        expect(help).toContain(args.includes('inspect') ? 'original upload' : args[0] === '--help' || args[0] === '--skill' ? 'file upload' : '4 MiB')
      }
    } finally { await client.dispose(); await server.stop() }
  }, 20000)
})
