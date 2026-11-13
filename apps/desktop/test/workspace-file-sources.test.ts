import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost } from '@agentmux/core'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { WorkspaceFileSources } from '../src/main/workspace-file-sources'
import type { WorkspaceRecord } from '../src/shared/contracts'
import { WORKSPACE_FILE_SOURCE_CHUNK_BYTES } from '../src/shared/workspace-file-source'

const roots: string[] = [], owners: WorkspaceFileSources[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-file-source-')); roots.push(root)
  const directory = join(root, 'workspace'); await mkdir(directory)
  const workspace: WorkspaceRecord = { id: 'private', name: 'Source', hostId: 'local', path: directory, kind: 'folder' }
  let current: WorkspaceRecord | undefined = workspace
  const files = new WorkspaceFiles(() => new LocalExecutionHost())
  const owner = new WorkspaceFileSources(files, () => current); owners.push(owner)
  const path = join(directory, 'large.pdf')
  await writeFile(path, Buffer.from('original content'))
  const source = async (caller = 1) => {
    const result = await owner.open(caller, workspace, 'large.pdf')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error(result.message)
    return result
  }
  return { root, directory, workspace, files, owner, path, source, retarget: (value: WorkspaceRecord | undefined) => { current = value } }
}
afterEach(async () => { for (const owner of owners.splice(0)) await owner.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('original file random-access sources', () => {
  it('reads requested offsets from a large original file without a snapshot or whole-file quota', async () => {
    const f = await fixture(), file = await open(f.path, 'r+')
    await file.truncate(40 * 1024 * 1024); await file.write(Buffer.from('distant page'), 0, 12, 32 * 1024 * 1024); await file.close()
    vi.spyOn(f.files, 'readPreview').mockImplementation(() => { throw new Error('Whole-file snapshot must not be used') })
    const source = await f.source()
    expect(source.size).toBe(40 * 1024 * 1024)
    const result = await f.owner.read(1, source.id, 'distant', 32 * 1024 * 1024, 12)
    expect(result).toEqual({ status: 'read', bytes: new TextEncoder().encode('distant page') })
    expect(f.files.readPreview).not.toHaveBeenCalled()
    expect(await f.owner.read(1, source.id, 'eof', source.size - 3, 100)).toEqual({ status: 'read', bytes: new Uint8Array(3) })
    expect(await f.owner.read(1, source.id, 'past-eof', source.size + 1, 100)).toEqual({ status: 'read', bytes: new Uint8Array() })
  })
  it('bounds one IPC span while leaving the healthy source available for subsequent valid reads', async () => {
    const f = await fixture(), source = await f.source()
    for (const [offset, length] of [[-1, 1], [0, -1], [0, Number.NaN], [0, WORKSPACE_FILE_SOURCE_CHUNK_BYTES + 1]]) {
      expect(await f.owner.read(1, source.id, 'bad', offset!, length!)).toMatchObject({ status: 'unavailable', code: 'INVALID_FILE_SOURCE_READ' })
    }
    expect(await f.owner.read(1, source.id, 'valid', 0, 8)).toEqual({ status: 'read', bytes: new TextEncoder().encode('original') })
  })
  it('binds reads, cancellation and release to the exact original caller', async () => {
    const f = await fixture(), source = await f.source()
    expect(await f.owner.read(2, source.id, 'foreign', 0, 1)).toMatchObject({ status: 'unavailable', code: 'WORKSPACE_FILE_SOURCE_NOT_OWNED' })
    await expect(f.owner.release(2, source.id)).rejects.toThrow('another Renderer')
    f.owner.cancel(2, source.id, 'valid')
    expect((await f.owner.read(1, source.id, 'valid', 0, 1)).status).toBe('read')
    await f.owner.release(1, source.id)
    expect(await f.owner.read(1, source.id, 'released', 0, 1)).toMatchObject({ status: 'released' })
  })
  it.each(['replace', 'rewrite', 'delete', 'escape'] as const)('refuses original bytes after %s with a precise physical fact', async change => {
    const f = await fixture(), source = await f.source()
    if (change === 'replace') { await writeFile(join(f.directory, 'replacement'), 'new file'); await rename(join(f.directory, 'replacement'), f.path) }
    if (change === 'rewrite') await writeFile(f.path, 'rewritten in place')
    if (change === 'delete') await rm(f.path)
    if (change === 'escape') { await writeFile(join(f.root, 'outside'), 'secret'); await rm(f.path); await symlink(join(f.root, 'outside'), f.path) }
    expect(await f.owner.read(1, source.id, 'after-change', 0, 8)).toMatchObject({ status: change === 'delete' ? 'deleted' : change === 'escape' ? 'outside-workspace' : 'changed' })
  })
  it('rejects Workspace retargeting while retaining the original source for explicit release', async () => {
    const f = await fixture(), source = await f.source()
    f.retarget({ ...f.workspace, hostId: 'another-host' })
    expect(await f.owner.read(1, source.id, 'retargeted', 0, 1)).toMatchObject({ status: 'changed', code: 'WORKSPACE_RESOURCE_CHANGED' })
    await f.owner.release(1, source.id)
  })
  it('fences a late open when its caller leaves, and closes the original descriptor', async () => {
    const f = await fixture(), actual = await f.files.openMediaHandle(f.workspace, 'large.pdf')
    let finish!: (value: typeof actual) => void
    vi.spyOn(f.files, 'openMediaHandle').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = f.owner.open(1, f.workspace, 'large.pdf')
    await f.owner.releaseCaller(1); finish(actual)
    expect(await pending).toMatchObject({ status: 'released' })
    await expect(actual.handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
  })
  it('cancels the named in-flight read without disabling the healthy source or another request', async () => {
    const f = await fixture(), actual = await f.files.openMediaHandle(f.workspace, 'large.pdf')
    vi.spyOn(f.files, 'openMediaHandle').mockResolvedValue(actual)
    const source = await f.source(), originalRead = actual.handle.read.bind(actual.handle)
    let finish!: () => void, started!: () => void
    const atRead = new Promise<void>(resolve => { started = resolve })
    const once = vi.spyOn(actual.handle, 'read').mockImplementationOnce(async (...args: any[]) => {
      started(); await new Promise<void>(resolve => { finish = resolve }); return await (originalRead as any)(...args)
    })
    const pending = f.owner.read(1, source.id, 'pending', 0, 8)
    await atRead; f.owner.cancel(1, source.id, 'pending'); finish()
    expect(await pending).toMatchObject({ status: 'cancelled' })
    once.mockRestore()
    expect((await f.owner.read(1, source.id, 'next', 0, 8)).status).toBe('read')
  })
  it('lends only its original descriptor to an exact Host operation and aborts it on source release', async () => {
    const f = await fixture(), source = await f.source()
    const foreign = vi.fn(async () => 'foreign')
    expect(await f.owner.withDescriptor(2, source.id, 'foreign', foreign)).toMatchObject({ status: 'unavailable' })
    expect(foreign).not.toHaveBeenCalled()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const operation = f.owner.withDescriptor(1, source.id, 'archive', async (fd, signal) => {
      expect(fd).toBeGreaterThan(0); entered()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return 'stale decoder output'
    })
    await started; await f.owner.release(1, source.id)
    expect(await operation).toMatchObject({ status: 'released' })
  })
  it('keeps a borrowed descriptor open until its aborted Host consumer has actually ended', async () => {
    const f = await fixture(), actual = await f.files.openMediaHandle(f.workspace, 'large.pdf')
    vi.spyOn(f.files, 'openMediaHandle').mockResolvedValue(actual)
    const close = vi.spyOn(actual.handle, 'close'), source = await f.source()
    let entered!: () => void, finish!: () => void, aborted = false
    const started = new Promise<void>(resolve => { entered = resolve })
    const operation = f.owner.withDescriptor(1, source.id, 'decoder', async (_fd, signal) => {
      signal.addEventListener('abort', () => { aborted = true }, { once: true }); entered()
      await new Promise<void>(resolve => { finish = resolve })
    })
    await started
    const releasing = f.owner.release(1, source.id)
    try {
      expect(aborted).toBe(true); expect(close).not.toHaveBeenCalled()
      await expect(actual.handle.stat()).resolves.toBeDefined()
    } finally { finish(); await releasing }
    expect(await operation).toMatchObject({ status: 'released' })
    expect(close).toHaveBeenCalledOnce()
    await expect(actual.handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
  })
})
