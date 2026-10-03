import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { parseFileListParams, parseFileListResult, parseFileReadParams, parseFileReadResult, type FileReadParams } from '../../../packages/core/src/public-rpc-files'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { WorkspaceRecord } from '../src/shared/contracts'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { FileReadOwner } from '../src/main/file-read-owner'

const cleanups: Array<() => Promise<unknown>> = []
const { build } = createRequire(resolve(import.meta.dirname, '../../../packages/core/package.json'))('esbuild') as {
  build(options: { entryPoints: string[]; outfile: string; bundle: boolean; platform: string; format: string; packages: string; logLevel: string }): Promise<unknown>
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
async function fixture() {
  const root = await realpath(await mkdtemp(_hygiene_fixturePath("tmp/amx-material-files-"))); cleanups.push(() => rm(root, { recursive: true, force: true }))
  await symlink(resolve(import.meta.dirname, '../../../packages/core/node_modules'), join(root, 'node_modules'))
  const workspace: WorkspaceRecord = { id: 'original-files', hostId: 'local', path: root, name: 'Files', kind: 'folder' }
  await mkdir(join(root, 'mote')); await writeFile(join(root, 'mote/saved.md'), 'The saved original material.\n')
  await writeFile(join(root, 'mote/binary.dat'), Buffer.from([0, 255, 0, 1]))
  const catalog: AgentMuxSpaceCatalog = { spaces: [], zones: [{ zoneId: 'original-zone', workspaceId: workspace.id, hostId: 'local', kind: 'home', directoryPath: join(root, 'mote'), branch: null }],
    tabs: [], regions: [], locations: [], bindings: [{ zoneId: 'original-zone', spaceId: 'mote-space' }, { zoneId: 'original-zone', spaceId: 'another-legal-space' }] }
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never); cleanups.push(() => files.dispose())
  const read = vi.spyOn(files, 'read'), observe = vi.fn(async () => catalog as AgentMuxSpaceCatalog | null)
  const owner = new FileReadOwner({ files, catalog: observe, workspace: id => id === workspace.id ? workspace : undefined })
  const params: FileReadParams = { zoneId: 'original-zone', spaceId: 'mote-space', path: 'saved.md', expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: root } }
  // Unix paths are bounded independently of the long repository worktree path.
  const socketRoot = await mkdtemp(_hygiene_fixturePath("tmp/amx-file-read-")); cleanups.push(() => rm(socketRoot, { recursive: true, force: true }))
  const server = new AgentMuxControlServer({ socketPath: join(socketRoot, 'c.sock'), coreClients: () => [], files: owner }); await server.start(); cleanups.push(() => server.stop())
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => client.dispose())
  return { root, workspace, catalog, files, read, owner, params, observe, server, client }
}
async function cli(root: string, args: string[]) {
  const path = join(root, 'cli.mjs')
  await build({ entryPoints: [resolve(import.meta.dirname, '../../../packages/core/src/agentmux.ts')], outfile: path, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, [path, ...args], { env: { ...env, AGENTMUX_STATE_DIRECTORY: join(root, 'private-state') }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    child.once('error', reject); child.once('close', code => done({ code, stdout, stderr }))
  })
}

describe('public file.read to the actual original Files owner', () => {
  it('reads real saved content/full revision through Unix client and real source CLI, preserving original resource', async () => {
    const f = await fixture(), result = await f.client.call('file.read', f.params)
    const original = await readFile(join(f.root, 'mote/saved.md'))
    expect(result).toEqual({ resource: { ...f.params.expectedResource, zoneId: 'original-zone', zonePath: join(f.root, 'mote'), path: 'mote/saved.md' },
      result: { status: 'read', document: { path: 'mote/saved.md', content: original.toString(), revision: 'sha256:' + createHash('sha256').update(original).digest('hex') } } })
    const args = ['--endpoint', 'unix:' + f.server.path, 'file', 'read', '--zone', 'original-zone', '--space', 'another-legal-space', '--path', 'saved.md', '--host', 'local', '--workspace', f.workspace.id, '--workspace-path', f.root]
    const output = await cli(f.root, args); expect(output.code, output.stderr).toBe(0); expect(JSON.parse(output.stdout)).toMatchObject({ ok: true, operation: 'file.read', result })
    expect(f.read).toHaveBeenCalledTimes(2)
    const wrong = await cli(f.root, args.map(value => value === 'local' ? 'foreign-host' : value))
    expect(wrong.code).not.toBe(0); expect(wrong.stdout + wrong.stderr).toContain('FILE_RESOURCE_MISMATCH'); expect(f.read).toHaveBeenCalledTimes(2)
  })
  it('refuses wrong resource/path before Files, permits legitimate multiple bindings, and preserves all original statuses and unknown observation', async () => {
    const f = await fixture()
    await expect(f.client.call('file.read', { ...f.params, expectedResource: { ...f.params.expectedResource, workspacePath: f.root + '-foreign' } })).rejects.toMatchObject({ code: 'FILE_RESOURCE_MISMATCH' })
    await expect(f.client.call('file.read', { ...f.params, path: '../saved.md' })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(f.read).not.toHaveBeenCalled()
    const binary = await f.client.call('file.read', { ...f.params, path: 'binary.dat', spaceId: 'another-legal-space' })
    expect(binary.result).toMatchObject({ status: 'binary', path: 'mote/binary.dat', byteLength: 4, revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) })
    expect((await f.client.call('file.read', { ...f.params, path: 'missing.md' })).result).toEqual({ status: 'deleted' })
    expect((await f.client.call('file.read', { ...f.params, path: '.' })).result).toEqual({ status: 'directory' })
    f.read.mockResolvedValueOnce({ status: 'error', code: 'ORIGINAL_FILE_ERROR', message: 'Original Files failure' })
    expect((await f.client.call('file.read', f.params)).result).toEqual({ status: 'error', code: 'ORIGINAL_FILE_ERROR', message: 'Original Files failure' })
    const calls = f.read.mock.calls.length; f.observe.mockResolvedValue(null)
    expect(await f.client.call('file.read', f.params)).toMatchObject({ resource: null, result: { status: 'unknown' } }); expect(f.read).toHaveBeenCalledTimes(calls)
  })
  it('rejects foreign resource, path and shortened revisions in result decoding; unknown cannot pretend confirmed file data', async () => {
    const f = await fixture(), result = await f.owner.read(f.params)
    expect(parseFileReadResult(result, f.params)).toEqual(result)
    expect(() => parseFileReadResult({ ...result, resource: { ...result.resource!, hostId: 'foreign' } }, f.params)).toThrow('Another File resource')
    expect(() => parseFileReadResult({ ...result, resource: { ...result.resource!, path: 'another.md' } }, f.params)).toThrow('Another File path')
    expect(result.result.status).toBe('read'); if (result.result.status !== 'read') throw new Error('Original file fixture must read')
    const document = result.result.document
    expect(() => parseFileReadResult({ ...result, result: { status: 'read', document: { ...document, path: 'another.md' } } }, f.params)).toThrow('Another File document')
    expect(() => parseFileReadResult({ ...result, result: { status: 'read', document: { ...document, revision: 'display-version' } } }, f.params)).toThrow('complete original File revision')
    expect(() => parseFileReadResult({ ...result, resource: null }, f.params)).toThrow('confirmed original resource')
    expect(() => parseFileReadParams({ ...f.params, memory: true })).toThrow()
  })
})

describe('project filename discovery through original Files and public CLI', () => {
  it('returns a healthy discovery exceeding the short read timeout through the actual compiled CLI', async () => {
    const f = await fixture(), original = f.files.listFiles.bind(f.files)
    vi.spyOn(f.files, 'listFiles').mockImplementation(async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 2300))
      return original(...args)
    })
    await expect(f.client.call('file.list', { ...f.params, path: '.' })).resolves.toMatchObject({ result: { status: 'listed' } })
    const output = await cli(f.root, ['--endpoint', 'unix:' + f.server.path, 'file', 'ls', '--zone', 'original-zone', '--host', 'local', '--workspace', f.workspace.id, '--workspace-path', f.root])
    expect(output.code, output.stderr).toBe(0)
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: true, operation: 'file.list', result: { result: { status: 'listed', files: expect.arrayContaining(['saved.md']) } } })
  }, 15000)
  it('finds unexpanded names inside the exact Zone through Unix RPC and actual file ls without reading bodies', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'mote/nested'))
    await writeFile(join(f.root, 'mote/nested/中文 notes.md'), '# Original saved bytes\n')
    const params = { ...f.params, path: '.' }, result = await f.client.call('file.list', params)
    expect(result.resource).toEqual({ ...params.expectedResource, zoneId: 'original-zone', zonePath: join(f.root, 'mote'), path: 'mote' })
    expect(result.result).toEqual({ status: 'listed', files: expect.arrayContaining(['saved.md', 'binary.dat', 'nested/中文 notes.md']), complete: true, omitted: 'none', partialReason: null })
    expect(f.read).not.toHaveBeenCalled()
    const args = ['--endpoint', 'unix:' + f.server.path, 'file', 'ls', '--zone', 'original-zone', '--space', 'mote-space', '--host', 'local', '--workspace', f.workspace.id, '--workspace-path', f.root]
    const output = await cli(f.root, args)
    expect(output.code, output.stderr).toBe(0)
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: true, operation: 'file.list', result })
    const subdirectory = await f.client.call('file.list', { ...params, path: 'nested' })
    expect(subdirectory.result).toMatchObject({ files: ['中文 notes.md'] })
    expect((await f.client.call('file.read', { ...params, path: 'nested/中文 notes.md' })).result).toMatchObject({ status: 'read', document: { content: '# Original saved bytes\n' } })
    f.read.mockClear()
    const limited = await f.client.call('file.list', { ...params, limit: 1 })
    expect(limited.result).toMatchObject({ status: 'listed', files: [expect.any(String)], complete: false, partialReason: 'limit' })
    const skill = await cli(f.root, ['--skill'])
    expect(skill.code).toBe(0); expect(skill.stdout).toContain('file ls')
    const help = await cli(f.root, ['--help', 'file', 'ls'])
    expect(help.code).toBe(0); expect(help.stdout).toContain('file.list'); expect(help.stdout).toContain('prepend the requested directory')
    expect(f.read).not.toHaveBeenCalled()
  }, 20000)
  it('honors Git ignore and tracked files, does not follow directory links, and reports unreadable names honestly', async () => {
    const f = await fixture()
    execFileSync('git', ['init', '-q'], { cwd: join(f.root, 'mote') })
    await writeFile(join(f.root, 'mote/.gitignore'), 'ignored/\n*.dat\n')
    await mkdir(join(f.root, 'mote/ignored')); await writeFile(join(f.root, 'mote/ignored/no.txt'), 'ignored')
    execFileSync('git', ['add', '-f', 'binary.dat'], { cwd: join(f.root, 'mote') })
    await symlink(f.root, join(f.root, 'mote/outside-directory'))
    const result = await f.files.listFiles(f.workspace, 'mote')
    expect(result).toEqual({ status: 'listed', files: expect.arrayContaining(['.gitignore', 'saved.md', 'binary.dat']), complete: true, omitted: 'git-ignored', partialReason: null })
    expect(result.files.some(name => name.includes('ignored/') || name.includes('outside-directory/') || name.startsWith('.git/'))).toBe(false)
    await writeFile(join(f.root, 'mote/unsupported\nname.txt'), 'original')
    const partial = await f.files.listFiles(f.workspace, 'mote')
    expect(partial).toMatchObject({ complete: false, partialReason: 'unreadable' })
    expect(partial.files).toContain('saved.md'); expect(partial.files.every(name => !name.includes('\n'))).toBe(true)
    expect(f.read).not.toHaveBeenCalled()
  })
  it('rejects a wrong resource and traversal before discovery and fences a late changed Workspace without destroying original Files', async () => {
    const f = await fixture(), list = vi.spyOn(f.files, 'listFiles'), params = { ...f.params, path: '.' }
    await expect(f.client.call('file.list', { ...params, expectedResource: { ...params.expectedResource, hostId: 'foreign' } })).rejects.toMatchObject({ code: 'FILE_RESOURCE_MISMATCH' })
    await expect(f.client.call('file.list', { ...params, path: '../foreign' })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(list).not.toHaveBeenCalled()
    list.mockImplementationOnce(async () => { f.workspace.path += '-changed'; return { status: 'listed', files: [], complete: true, omitted: 'none', partialReason: null } })
    const result = await f.client.call('file.list', params)
    expect(result).toMatchObject({ resource: { workspacePath: f.root }, result: { status: 'unknown', code: 'FILE_LIST_UNCONFIRMED' } })
    f.workspace.path = f.root
    expect((await f.client.call('file.read', f.params)).result.status).toBe('read')
  })
  it('validates original mapping, distinct directory-relative names, limits and complete versus partial receipts', async () => {
    const f = await fixture(), params = { ...f.params, path: '.' }, result = await f.owner.list(params)
    expect(parseFileListResult(result, params)).toEqual(result)
    expect(() => parseFileListParams({ ...params, limit: 0 })).toThrow()
    expect(() => parseFileListParams({ ...params, limit: 20001 })).toThrow()
    for (const files of [['../foreign'], [_hygiene_fixturePath("absolute")], ['a', 'a'], ['a\\b']]) {
      expect(() => parseFileListResult({ ...result, result: { status: 'listed', files, complete: true, omitted: 'none', partialReason: null } }, params)).toThrow()
    }
    expect(() => parseFileListResult({ ...result, resource: { ...result.resource!, zonePath: f.root + '-other' } }, params)).toThrow()
    expect(() => parseFileListResult({ ...result, result: { status: 'listed', files: [], complete: true, omitted: 'none', partialReason: 'budget' } }, params)).toThrow()
    f.observe.mockResolvedValue(null)
    expect(await f.client.call('file.list', params)).toMatchObject({ resource: null, result: { status: 'unknown' } })
  })
  it('reuses remote directory facts with a bounded traversal and skips ignored and directory-link subtrees', async () => {
    const host = { id: 'remote', kind: 'ssh' }, files = new WorkspaceFiles(() => host as never)
    cleanups.push(() => files.dispose())
    const read = vi.spyOn(files, 'readDirectory').mockImplementation(async (_workspace, path) => path === 'zone' ? [
      { name: 'nested', path: 'zone/nested', isDirectory: true, isSymlink: false },
      { name: 'link', path: 'zone/link', isDirectory: true, isSymlink: true },
      { name: 'ignored', path: 'zone/ignored', isDirectory: true, isSymlink: false, ignored: true }
    ] : [{ name: 'file.ts', path: path + '/file.ts', isDirectory: false, isSymlink: false }])
    const workspace = { id: 'remote-files', hostId: 'remote', path: _hygiene_fixturePath("remote/root"), name: 'Remote', kind: 'folder' } as WorkspaceRecord
    expect(await files.listFiles(workspace, 'zone')).toEqual({ status: 'listed', files: ['nested/file.ts'], complete: true, omitted: 'git-ignored', partialReason: null })
    expect(read.mock.calls.map(call => call[1])).toEqual(['zone', 'zone/nested'])
    read.mockClear().mockImplementation(async (_workspace, path) => Array.from({ length: 4 }, (_, index) => ({ name: 'dir' + index, path: path + '/dir' + index, isDirectory: true, isSymlink: false })))
    expect(await files.listFiles(workspace, 'zone')).toMatchObject({ complete: false, partialReason: 'budget' })
    expect(read.mock.calls.length).toBeGreaterThan(1); expect(read.mock.calls.length).toBeLessThanOrEqual(128)
  })
})
