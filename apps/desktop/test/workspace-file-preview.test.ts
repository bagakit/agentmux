import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost, type ExecutionHost } from '@agentmux/core'
import { WorkspaceFiles } from '../src/main/workspace-files'
import type { WorkspaceRecord } from '../src/shared/contracts'
import { WORKSPACE_FILE_MAX_BYTES, WORKSPACE_FILE_MAX_READ_BYTES } from '../src/shared/workspace-file-bytes'
import { workspaceFilePreviewFormat } from '../src/shared/workspace-file-preview'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+3fVbWQAAAABJRU5ErkJggg==', 'base64')
const roots: string[] = []
const revision = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'agentmux-preview-source-'))
  roots.push(base)
  const root = join(base, 'workspace')
  await mkdir(root)
  const workspace: WorkspaceRecord = { id: 'preview-source', name: 'Preview', kind: 'folder', hostId: 'local', path: root }
  const files = new WorkspaceFiles(() => new LocalExecutionHost())
  return { base, root, workspace, files }
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('workspace preview through the existing byte owner', () => {
  it('returns exact PNG bytes and one complete verified scan, including files larger than a public chunk', async () => {
    const f = await fixture()
    const bytes = Buffer.concat([PNG, Buffer.alloc(WORKSPACE_FILE_MAX_READ_BYTES + 3, 128)])
    await writeFile(join(f.root, '图 像.PNG'), bytes)
    const snapshot = vi.spyOn(f.files, 'snapshotBytes'), chunk = vi.spyOn(f.files, 'readBytes')
    const result = await f.files.readPreview(f.workspace, '图 像.PNG')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('Preview did not return complete bytes')
    expect(Buffer.from(result.bytes).equals(bytes)).toBe(true)
    expect({ ...result, bytes: undefined }).toEqual({ status: 'ready', kind: 'image', mimeType: 'image/png', bytes: undefined,
      revision: revision(bytes), byteLength: bytes.length, readCost: { payloadBytes: bytes.length } })
    expect(snapshot).toHaveBeenCalledExactlyOnceWith(f.workspace, '图 像.PNG', {})
    expect(chunk).not.toHaveBeenCalled()
    expect(await readFile(join(f.root, '图 像.PNG'))).toEqual(bytes)
  })

  it('keeps SVG/ICO and media MIME candidates in the shared router without claiming decoding', async () => {
    const f = await fixture()
    const cases = [
      ['art.svg', 'image', 'image/svg+xml', true], ['art.ico', 'image', 'image/x-icon', false],
      ['clip.mp4', 'video', 'video/mp4', false], ['clip.webm', 'video', 'video/webm', false],
      ['sound.wav', 'audio', 'audio/wav', false], ['sound.mp3', 'audio', 'audio/mpeg', false]
    ] as const
    expect(cases).toHaveLength(6)
    for (const [path, kind, mimeType, sourceEditable] of cases) {
      expect(workspaceFilePreviewFormat(path)).toEqual({ kind, mimeType, sourceEditable })
      await writeFile(join(f.root, path), PNG)
      const result = await f.files.readPreview(f.workspace, path)
      expect(result).toMatchObject({ status: 'ready', kind, mimeType, byteLength: PNG.length })
      expect(result).toHaveProperty('bytes', PNG)
    }
    expect(workspaceFilePreviewFormat('.png')).toBeNull()
    expect(workspaceFilePreviewFormat('fake.unknown')).toBeNull()
  })

  it('checks a real PDF header and refuses a changed revision while keeping the original file', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'report.pdf'), 'plain text renamed as a PDF')
    expect(await f.files.readPreview(f.workspace, 'report.pdf')).toMatchObject({ status: 'unsupported', message: expect.stringContaining('PDF header') })
    const bytes = Buffer.from('%PDF-1.7\nfixture bytes; native rendering is separately qualified')
    await writeFile(join(f.root, 'report.pdf'), bytes)
    expect(await f.files.readPreview(f.workspace, 'report.pdf')).toMatchObject({ status: 'ready', kind: 'pdf', mimeType: 'application/pdf', bytes })
    expect(await f.files.readPreview(f.workspace, 'report.pdf', { expectedRevision: revision(PNG) })).toMatchObject({ status: 'changed' })
    expect(await readFile(join(f.root, 'report.pdf'))).toEqual(bytes)
  })

  it('returns explicit budget, directory, deleted and confinement facts without corrupting files', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'large.png'), '')
    await truncate(join(f.root, 'large.png'), WORKSPACE_FILE_MAX_BYTES + 1)
    const budget = await f.files.readPreview(f.workspace, 'large.png')
    expect(budget.status).toBe('too-large')
    if (budget.status !== 'too-large') throw new Error('Preview budget was not enforced')
    expect(budget.maxBytes).toBe(WORKSPACE_FILE_MAX_BYTES)
    await mkdir(join(f.root, 'directory.png'))
    expect(await f.files.readPreview(f.workspace, 'directory.png')).toEqual({ status: 'directory' })
    expect(await f.files.readPreview(f.workspace, 'missing.png')).toMatchObject({ status: 'deleted' })
    expect(await f.files.readPreview(f.workspace, 'unknown.data')).toMatchObject({ status: 'unsupported' })
    await writeFile(join(f.base, 'outside.png'), PNG)
    await symlink(join(f.base, 'outside.png'), join(f.root, 'link.png'))
    expect(await f.files.readPreview(f.workspace, 'link.png')).toMatchObject({ status: 'unavailable', message: expect.stringContaining('escapes') })
    expect(await readFile(join(f.base, 'outside.png'))).toEqual(PNG)
  })

  it('states remote preview is unavailable without invoking a text transport or a local substitute', async () => {
    const f = await fixture(), run = vi.fn()
    const host = { id: 'remote', kind: 'ssh', run } as unknown as ExecutionHost
    const files = new WorkspaceFiles(() => host)
    expect(await files.readPreview({ ...f.workspace, hostId: 'remote' }, '图.png')).toMatchObject({
      status: 'unavailable', code: 'REMOTE_WORKSPACE_PREVIEW_UNAVAILABLE' })
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps unknown binary out of writable documents while preserving valid Unicode, BOM and ESC logs', async () => {
    const f = await fixture()
    const cases = [Buffer.from([65, 0, 66]), Buffer.from([255, 192, 175]), Buffer.from('%PDF-1.7\nall ASCII header')]
    expect(cases).toHaveLength(3)
    for (const [index, bytes] of cases.entries()) {
      const path = `unknown-${index}.data`
      await writeFile(join(f.root, path), bytes)
      expect(await f.files.read(f.workspace, path)).toEqual({ status: 'binary', path, revision: revision(bytes), byteLength: bytes.length })
    }
    const content = '\uFEFF汉字\n\u001b[31mcolored log\u001b[0m\nactual replacement character: \uFFFD'
    await writeFile(join(f.root, 'log.txt'), content)
    expect(await f.files.read(f.workspace, 'log.txt')).toEqual({ status: 'read', document: { path: 'log.txt', content, revision: revision(Buffer.from(content)) } })
  })

  it('protects an existing binary file from text saves, including a matching known revision', async () => {
    const f = await fixture(), path = 'unknown.data'
    const bytes = Buffer.from([255, 128, 0])
    await writeFile(join(f.root, path), bytes)
    expect(await f.files.write(f.workspace, { path, content: 'must keep this draft separate', expectedRevision: revision(bytes) })).toMatchObject({
      status: 'error', code: 'WORKSPACE_BINARY_FILE_NOT_EDITABLE' })
    expect(await readFile(join(f.root, path))).toEqual(bytes)
  })
})
