import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, glob, copyFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { fileUploadRevision, FILE_IMPORT_MAX_BYTES, parseFileImportParams, type FileImportParams } from '../../../packages/core/src/public-rpc-files'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { WorkspaceFiles } from '../src/main/workspace-files'
import type { WorkspaceRecord } from '../src/shared/contracts'
const { build } = createRequire(resolve('packages/core/package.json'))('esbuild')
const roots: string[] = [], servers: AgentMuxControlServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(fault?: 'receipt' | 'occupy') {
  const root = await mkdtemp(join(tmpdir(), 'amx-public-import-')); roots.push(root)
  const workspace: WorkspaceRecord = { id: 'original', hostId: 'local', path: root, name: 'Original', kind: 'folder' }
  const zone = { zoneId: 'original-zone', kind: 'temporary', workspaceId: workspace.id, hostId: 'local', directoryPath: root }
  let hostKind = 'local'
  const files = new WorkspaceFiles(id => ({ id, kind: hostKind, label: 'Original', run: vi.fn(), exposeLoopbackPort: async port => port, dispose: async () => {} } as any), { localWriteFault: fault })
  const owner = new FileReadOwner({ catalog: async () => ({ zones: [zone], bindings: [] } as any), workspace: id => id === workspace.id ? workspace : undefined, files })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), files: owner, coreClients: () => [] }); servers.push(server); await server.start()
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  async function target(path: string, bytes: Uint8Array): Promise<FileImportParams> {
    const read = await client.call('file.read', { zoneId: zone.zoneId, path, expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: root } })
    expect(read.result.status).toBe('deleted'); expect(read.resource).not.toBeNull()
    return { zoneId: zone.zoneId, path, expectedResource: read.resource!, expectedRevision: null,
      operationId: 'original-import', revision: fileUploadRevision(bytes), byteLength: bytes.byteLength, dataBase64: Buffer.from(bytes).toString('base64') }
  }
  return { root, workspace, zone, owner, client, files, target, remote: () => { hostKind = 'ssh' } }
}
it('shipping CLI imports exact binary bytes, reads their revision, and exits unsuccessfully on an occupied target', async () => {
  const f = await fixture(), cli = resolve('.bagakit/note-rich-blocks/import-cli/dist/agentmux.js')
  await mkdir(dirname(cli), { recursive: true })
  await symlink('../../../packages/core/node_modules', join(dirname(dirname(cli)), 'node_modules'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error })
  // Preserve shipping ESM module boundaries: bundling this native CLI changes its async import cycles.
  const entries: string[] = []
  for await (const path of glob('packages/core/src/**/*.ts')) if (!path.endsWith('.d.ts')) entries.push(path)
  await build({ entryPoints: entries, outdir: dirname(cli), outbase: 'packages/core/src', platform: 'node', format: 'esm', bundle: false, logLevel: 'silent' })
  await copyFile('packages/core/package.json', join(dirname(dirname(cli)), 'package.json'))
  for await (const path of glob('packages/core/src/**/*.json')) { const destination = join(dirname(cli), path.slice('packages/core/src/'.length)); await mkdir(dirname(destination), { recursive: true }); await copyFile(path, destination) }
  const exec = promisify(execFile), env = { ...process.env, AGENTMUX_RPC_ENDPOINT: 'unix:' + join(f.root, 'control.sock'), AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined, AGENTMUX_ENV: undefined }
  async function command(args: string[]) { try { const out = await exec(process.execPath, [cli, ...args], { env, timeout: 10000 }); return { code: 0, body: JSON.parse(out.stdout) } } catch (error: any) { return { code: error.code, body: error.stdout ? JSON.parse(error.stdout) : { error: error.stderr || error.message } } } }
  const bytes = Uint8Array.from([137, 80, 78, 71, 0, 13, 10, 255]), params = await f.target('selected image.png', bytes), input = join(f.root, 'import-input.json')
  await writeFile(input, JSON.stringify(params))
  const imported = await command(['file', 'import', '--input', input]); expect(imported.code, JSON.stringify(imported.body)).toBe(0)
  expect(imported.body.result).toMatchObject({ operationId: params.operationId, resource: params.expectedResource, result: { status: 'written', revision: params.revision, byteLength: bytes.length } })
  const readInput = join(f.root, 'read-input.json'); await writeFile(readInput, JSON.stringify({ zoneId: params.zoneId, path: params.path, expectedResource: { hostId: f.workspace.hostId, workspaceId: f.workspace.id, workspacePath: f.root } }))
  const read = await command(['file', 'read', '--zone', params.zoneId, '--path', params.path, '--host', f.workspace.hostId, '--workspace', f.workspace.id, '--workspace-path', f.root]); expect(read.code, JSON.stringify(read.body)).toBe(0)
  expect(read.body.result.result).toMatchObject({ status: 'binary', revision: params.revision, byteLength: bytes.length })
  expect(await readFile(join(f.root, params.path))).toEqual(Buffer.from(bytes))
  const collision = await command(['file', 'import', '--input', input]); expect(collision.code).toBe(1); expect(collision.body.result.result.status).toBe('conflict')
  expect(await readFile(join(f.root, params.path))).toEqual(Buffer.from(bytes)); await f.client.dispose()
})
it('rejects changed target mappings, false byte hashes and Note bodies before publishing', async () => {
  const f = await fixture(), params = await f.target('original.png', Uint8Array.from([0, 1, 2]))
  expect((await f.client.call('file.import', { ...params, revision: 'sha256:' + 'a'.repeat(64) })).result).toMatchObject({ status: 'error', code: 'FILE_IMPORT_CONTENT_MISMATCH' })
  expect(await readFile(join(f.root, params.path)).catch(error => error.code)).toBe('ENOENT')
  await expect(f.client.call('file.import', { ...params, expectedRevision: 'sha256:' + 'a'.repeat(64) } as any)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  const note = await f.target('original.note.md', Uint8Array.from([0, 1, 2]))
  await expect(f.client.call('file.import', note)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  const nested = join(f.root, 'nested'); await mkdir(nested); f.zone.directoryPath = nested
  await expect(f.client.call('file.import', params)).rejects.toMatchObject({ code: 'FILE_RESOURCE_MISMATCH' })
  expect(await readFile(join(nested, params.path)).catch(error => error.code)).toBe('ENOENT'); await f.client.dispose()
})
it('unknown publication retains original operation and permits same-target observation without replay', async () => {
  const f = await fixture('receipt'), params = await f.target('receipt.bin', Uint8Array.from([0, 3, 4]))
  const spy = vi.spyOn(f.files, 'writeBytes'), receipt = await f.client.call('file.import', params)
  expect(receipt).toMatchObject({ operationId: params.operationId, resource: params.expectedResource, result: { status: 'unknown' } })
  const observed = await f.client.call('file.read', { zoneId: params.zoneId, path: params.path, expectedResource: { hostId: f.workspace.hostId, workspaceId: f.workspace.id, workspacePath: f.root } })
  expect(observed.result).toMatchObject({ status: 'binary', revision: params.revision }); expect(spy).toHaveBeenCalledTimes(1)
  expect(await readFile(join(f.root, params.path))).toEqual(Buffer.from(params.dataBase64, 'base64')); await f.client.dispose()
})
it('shares the existing exclusive byte writer and states remote qualification without another local destination', async () => {
  const f = await fixture('occupy'), params = await f.target('competing.bin', Uint8Array.from([0, 5, 6]))
  expect((await f.client.call('file.import', params)).result.status).toBe('conflict')
  expect(await readFile(join(f.root, params.path), 'utf8')).toBe('competing bytes')
  const remote = await f.target('remote.bin', Uint8Array.from([0, 5, 6])); f.remote()
  expect((await f.client.call('file.import', remote)).result).toMatchObject({ status: 'error', code: 'REMOTE_WORKSPACE_FILE_WRITE_UNSUPPORTED' })
  expect(await readFile(join(f.root, remote.path)).catch(error => error.code)).toBe('ENOENT'); await f.client.dispose()
})
it('accepts the original Files maximum bytes within both base64 wire layers and rejects one byte beyond it', async () => {
  const f = await fixture(), params = await f.target('bounded.bin', new Uint8Array(FILE_IMPORT_MAX_BYTES))
  expect(parseFileImportParams(params).byteLength).toBe(FILE_IMPORT_MAX_BYTES)
  expect((await f.client.call('file.import', params)).result).toMatchObject({ status: 'written', revision: params.revision, byteLength: FILE_IMPORT_MAX_BYTES })
  const plaintext = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'file.import', params }))
  expect(4 * Math.ceil((plaintext + 40) / 3)).toBeLessThan(8 * 1024 * 1024)
  expect(() => parseFileImportParams({ ...params, byteLength: FILE_IMPORT_MAX_BYTES + 1 })).toThrow(); await f.client.dispose()
})
it('original preview owner refuses a re-bound Workspace before any byte read', async () => {
  const f = await fixture(), spy = vi.spyOn(f.files, 'snapshotBytes')
  const result = await f.files.readPreview(f.workspace, 'image.png', { expectedResource: { hostId: 'original-other-host', workspacePath: f.root } })
  expect(result).toMatchObject({ status: 'unavailable', code: 'FILE_RESOURCE_MISMATCH' }); expect(spy).not.toHaveBeenCalled(); await f.client.dispose()
})
