import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { FileReadOwner } from '../src/main/file-read-owner'
import { WorkspaceFiles } from '../src/main/workspace-files'
import type { FileCreateParams } from '../../../packages/core/src/public-rpc-files'
import type { WorkspaceRecord } from '../src/shared/contracts'
const { build } = createRequire(resolve('packages/core/package.json'))('esbuild')
const roots: string[] = [], servers: AgentMuxControlServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(fault?: 'receipt' | 'occupy') {
  const root = await mkdtemp(join(tmpdir(), 'amx-public-create-')); roots.push(root)
  const workspace: WorkspaceRecord = { id: 'original', hostId: 'local', path: root, name: 'Original', kind: 'folder' }
  const zone = { zoneId: 'original-zone', kind: 'temporary', workspaceId: workspace.id, hostId: 'local', directoryPath: root }
  const files = new WorkspaceFiles(id => ({ id, kind: 'local', label: 'Local', run: vi.fn(), exposeLoopbackPort: async port => port, dispose: async () => {} }), { localWriteFault: fault })
  const owner = new FileReadOwner({ catalog: async () => ({ zones: [zone], bindings: [] } as any), workspace: id => id === workspace.id ? workspace : undefined, files })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), files: owner, coreClients: () => [] }); servers.push(server); await server.start()
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  async function target(path: string, content: string): Promise<FileCreateParams> {
    const read = await client.call('file.read', { zoneId: zone.zoneId, path, expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: root } })
    expect(read.result.status).toBe('deleted'); expect(read.resource).not.toBeNull()
    return { zoneId: zone.zoneId, path, expectedResource: read.resource!, content, expectedRevision: null }
  }
  return { root, workspace, zone, owner, client, target }
}
it('shipping RPC and CLI create ordinary text and Note bytes through original Files, then refuse overwrite', async () => {
  const f = await fixture(), cli = resolve('.local/recall/file-create/cli.mjs')
  await symlink('../../../packages/core/node_modules', join(dirname(cli), 'node_modules'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error })
  await build({ entryPoints: ['packages/core/src/agentmux.ts'], outfile: cli, platform: 'node', format: 'esm', packages: 'external', bundle: true, logLevel: 'silent' })
  const exec = promisify(execFile), env = { ...process.env, AGENTMUX_RPC_ENDPOINT: 'unix:' + join(f.root, 'control.sock'), AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined, AGENTMUX_ENV: undefined }
  async function command(args: string[]) { try { const out = await exec(process.execPath, [cli, ...args], { env, timeout: 5000 }); return { code: 0, body: JSON.parse(out.stdout) } } catch (error: any) { return { code: error.code, body: JSON.parse(error.stdout) } } }
  for (const [path, content] of [['ordinary result.txt', 'Original 中文\n😀'], ['captured.note.json', JSON.stringify({ schema: 'agentmux.note.v1', noteId: 'stable-note', content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'stable-block' }, content: [{ type: 'text', text: 'Saved source result' }] }] } })]]) {
    const params = await f.target(path!, content!), input = join(f.root, 'create-input.json'); await writeFile(input, JSON.stringify(params))
    const created = await command(['file', 'create', '--input', input]); expect(created.code).toBe(0); expect(created.body.result).toMatchObject({ resource: params.expectedResource, result: { status: 'written' } })
    const observed = await f.client.call('file.read', { zoneId: params.zoneId, path: params.path, expectedResource: { hostId: f.workspace.hostId, workspaceId: f.workspace.id, workspacePath: f.workspace.path } }); expect(observed.result).toMatchObject({ status: 'read', document: { content, revision: created.body.result.result.revision } })
    expect(await readFile(join(f.root, path!), 'utf8')).toBe(content)
    await writeFile(input, JSON.stringify({ ...params, content: 'must not replace original' })); const collision = await command(['file', 'create', '--input', input]); expect(collision.code).toBe(1); expect(collision.body.result.result.status).toBe('conflict'); expect(await readFile(join(f.root, path!), 'utf8')).toBe(content)
  }
  await f.client.dispose()
})
it('refuses changed mappings and malformed absence while leaving the same existing-file write semantics', async () => {
  const f = await fixture(), params = await f.target('original.txt', 'Original')
  await expect(f.client.call('file.create', { ...params, expectedRevision: 'sha256:' + 'a'.repeat(64) } as any)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(f.client.call('file.write', params as any)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  const nested = join(f.root, 'nested'); await mkdir(nested); f.zone.directoryPath = nested
  await expect(f.client.call('file.create', params)).rejects.toMatchObject({ code: 'FILE_RESOURCE_MISMATCH' })
  expect(await readFile(join(nested, params.path), 'utf8').catch(error => error.code)).toBe('ENOENT')
  await f.client.dispose()
})
it('retains unknown creation and published original bytes for same-target readback without replay', async () => {
  const f = await fixture('receipt'), params = await f.target('same.note.json', 'Original identity bytes')
  const receipt = await f.client.call('file.create', params); expect(receipt).toMatchObject({ resource: params.expectedResource, result: { status: 'unknown' } })
  const observed = await f.client.call('file.read', { zoneId: params.zoneId, path: params.path, expectedResource: { hostId: f.workspace.hostId, workspaceId: f.workspace.id, workspacePath: f.workspace.path } }); expect(observed.result).toMatchObject({ status: 'read', document: { content: params.content } })
  expect(await readFile(join(f.root, params.path), 'utf8')).toBe(params.content); await f.client.dispose()
})
it('uses the original exclusive publisher against a concurrent occupied name', async () => {
  const f = await fixture('occupy'), params = await f.target('competing.txt', 'Our bytes')
  expect((await f.client.call('file.create', params)).result.status).toBe('conflict')
  expect(await readFile(join(f.root, params.path), 'utf8')).toBe('competing bytes'); await f.client.dispose()
})
