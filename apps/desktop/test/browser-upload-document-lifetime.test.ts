import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalExecutionHost } from '@agentmux/core'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import { BrowserUploads, BrowserUploadUnconfirmedError, type BrowserUploadContext } from '../src/main/browser-uploads.js'
import type { WorkspaceRecord } from '../src/shared/contracts.js'

const writeFault = vi.hoisted(() => ({ metadata: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (writeFault.metadata && String(args[0]).includes('selection.json.')) throw new Error('Metadata write refused')
    return await actual.open(...args)
  } }
})
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { writeFault.metadata = false; for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-upload-document-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'workspace'); await mkdir(root)
  const staging = join(directory, 'staging')
  const workspace: WorkspaceRecord = { id: 'own-workspace', name: 'Owned fixture', hostId: 'local', kind: 'folder', path: root }
  const files = new WorkspaceFiles(() => new LocalExecutionHost())
  const create = () => new BrowserUploads(staging, files, () => workspace)
  const owner = create()
  let selected: string[] = []
  const send = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'DOM.setFileInputFiles') { selected = params!.files as string[]; return {} }
    if (method === 'Runtime.callFunctionOn') return String(params!.functionDeclaration).includes('Array.from(this.files')
      ? { result: { value: await Promise.all(selected.map(async path => ({ name: path.split('/').at(-1), byteLength: (await readFile(path)).length }))) } }
      : { result: { value: { multiple: true } } }
    throw new Error('Unexpected upload command')
  })
  const context: BrowserUploadContext = { workspaceId: workspace.id, browserId: 'shared-page', operationId: 'original-operation', navigationId: 'original-document',
    documentSurvivesClient: true, currentNavigationId: () => 'original-document', target: { objectId: 'owned-file-input', sendCommand: send } }
  await writeFile(join(root, 'selected.txt'), 'original snapshot')
  return { directory, root, staging, files, owner, create, context, send, selected: () => selected }
}

it('writes the original snapshot and bounded document metadata durably before the first DOM assignment', async () => {
  const f = await fixture(); const original = f.send.getMockImplementation()!
  f.send.mockImplementation(async (method, params) => {
    if (method === 'DOM.setFileInputFiles') {
      const paths = params!.files as string[]
      const text = await readFile(join(dirname(dirname(paths[0]!)), 'selection.json'), 'utf8').catch(() => null)
      expect(text).not.toBeNull()
      const metadata = JSON.parse(text!)
      expect(metadata).toMatchObject({ version: 1, browserId: 'shared-page', navigationId: 'original-document', workspaceId: 'own-workspace', documentSurvivesClient: true, bytes: 17 })
      expect(metadata.files).toEqual([{ path: 'selected.txt', name: 'selected.txt', byteLength: 17, revision: expect.any(String) }])
      expect(await readFile(paths[0]!, 'utf8')).toBe('original snapshot')
    }
    return await original(method, params)
  })
  await f.owner.upload(f.context, ['selected.txt'])
  expect(f.send.mock.calls.filter(call => call[0] === 'DOM.setFileInputFiles')).toHaveLength(1)
})

it('sends no irreversible assignment when the original durable selection fact cannot be written', async () => {
  const f = await fixture(); writeFault.metadata = true
  await expect(f.owner.upload(f.context, ['selected.txt'])).rejects.toThrow('Metadata write refused')
  expect(f.send.mock.calls.filter(call => call[0] === 'DOM.setFileInputFiles')).toEqual([])
  expect(await readdir(f.staging)).toEqual([])
})

it('keeps an independent document readable through original owner disposal and fresh metadata recovery without any page reads or replay', async () => {
  const f = await fixture(); await f.owner.upload(f.context, ['selected.txt'])
  const selected = f.selected()[0]!
  await f.owner.dispose()
  await expect(readFile(selected, 'utf8')).resolves.toBe('original snapshot')
  await writeFile(join(f.root, 'selected.txt'), 'later Workspace edit')
  f.send.mockClear()
  const restarted = f.create(); const retained = await restarted.retained()
  expect(retained.selections).toEqual([{ id: dirname(dirname(selected)).split('/').at(-1), browserId: 'shared-page', navigationId: 'original-document', workspaceId: 'own-workspace', files: ['selected.txt'], byteLength: 17, status: 'unknown' }])
  expect(retained).toMatchObject({ selectionCount: 1, byteLength: 17, selectionLimit: 128, byteLimit: 128 * 1024 * 1024 })
  expect(f.send).not.toHaveBeenCalled()
  await expect(readFile(selected, 'utf8')).resolves.toBe('original snapshot')
  await restarted.dispose()
  await expect(readFile(selected, 'utf8')).resolves.toBe('original snapshot')
})

it('releases an ended native document while independent selections and unrelated namespace files remain', async () => {
  const f = await fixture()
  await f.owner.upload({ ...f.context, browserId: 'native-page', documentSurvivesClient: false }, ['selected.txt'])
  const native = f.selected()[0]!
  await f.owner.upload(f.context, ['selected.txt']); const independent = f.selected()[0]!
  await writeFile(join(f.staging, 'unrelated.txt'), 'kept')
  await f.owner.dispose()
  await expect(readFile(native)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(independent, 'utf8')).resolves.toBe('original snapshot')
  await expect(readFile(join(f.staging, 'unrelated.txt'), 'utf8')).resolves.toBe('kept')
})

it('retains a potentially assigned FileList after a lost acknowledgement and restores its exact original owner without retry', async () => {
  const f = await fixture(); const original = f.send.getMockImplementation()!
  f.send.mockImplementation(async (method, params) => { const result = await original(method, params); if (method === 'DOM.setFileInputFiles') throw new Error('Lost assignment acknowledgement'); return result })
  await expect(f.owner.upload(f.context, ['selected.txt'])).rejects.toBeInstanceOf(BrowserUploadUnconfirmedError)
  expect(f.send.mock.calls.filter(call => call[0] === 'DOM.setFileInputFiles')).toHaveLength(1)
  await f.owner.dispose()
  expect((await f.create().retained()).selections).toEqual([expect.objectContaining({ browserId: 'shared-page', navigationId: 'original-document', status: 'unknown' })])
  await expect(readFile(f.selected()[0]!, 'utf8')).resolves.toBe('original snapshot')
})

it('releases only the confirmed original browser and document epoch, leaving a later document selection intact', async () => {
  const f = await fixture(); await f.owner.upload(f.context, ['selected.txt']); const original = f.selected()[0]!
  await f.owner.upload({ ...f.context, operationId: 'next-operation', navigationId: 'later-document', currentNavigationId: () => 'later-document' }, ['selected.txt'])
  const later = f.selected()[0]!
  await f.owner.releaseDocument('another-page', 'original-document')
  await f.owner.releaseDocument('shared-page', 'unrelated-document')
  await expect(readFile(original, 'utf8')).resolves.toBe('original snapshot')
  await f.owner.releaseDocument('shared-page', 'original-document')
  await expect(readFile(original)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(later, 'utf8')).resolves.toBe('original snapshot')
  expect((await f.owner.retained()).selections).toEqual([expect.objectContaining({ navigationId: 'later-document' })])
})

it('keeps an unowned or corrupt retained directory visible without inventing its document and refuses new staging', async () => {
  const f = await fixture(); await f.owner.upload(f.context, ['selected.txt']); const selected = f.selected()[0]!
  await writeFile(join(dirname(dirname(selected)), 'selection.json'), '{broken')
  const restarted = f.create(); const retained = await restarted.retained()
  expect(retained.selections).toEqual([expect.objectContaining({ browserId: null, navigationId: null, workspaceId: null, byteLength: 17, files: [], status: 'unknown' })])
  expect(retained.warning).toContain('no verified document metadata')
  await expect(readFile(selected, 'utf8')).resolves.toBe('original snapshot')
  await expect(restarted.upload(f.context, ['selected.txt'])).rejects.toThrow('no verified document metadata')
  expect(f.send.mock.calls.filter(call => call[0] === 'DOM.setFileInputFiles')).toHaveLength(1)
})

it('keeps files on person cancellation and removes only the exact confirmed selection', async () => {
  const f = await fixture(); await f.owner.upload(f.context, ['selected.txt']); const first = f.selected()[0]!
  await f.owner.upload({ ...f.context, browserId: 'another-page' }, ['selected.txt']); const other = f.selected()[0]!
  const selection = (await f.owner.retained()).selections.find(row => row.browserId === 'shared-page')!
  const cancel = vi.fn(async () => false)
  expect(await f.owner.confirmDiscardSelection(selection.id, cancel)).toBe(false)
  expect(cancel).toHaveBeenCalledWith(selection)
  await expect(readFile(first, 'utf8')).resolves.toBe('original snapshot')
  expect(await f.owner.confirmDiscardSelection(selection.id, async () => true)).toBe(true)
  await expect(readFile(first)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(other, 'utf8')).resolves.toBe('original snapshot')
  expect((await f.owner.retained()).selections).toEqual([expect.objectContaining({ browserId: 'another-page' })])
})

it('does not let a late old confirmation delete the new selection after the original document ends', async () => {
  const f = await fixture(); await f.owner.upload(f.context, ['selected.txt'])
  const first = (await f.owner.retained()).selections[0]!
  let accept!: (accepted: boolean) => void
  const choice = new Promise<boolean>(resolve => { accept = resolve })
  const confirmation = f.owner.confirmDiscardSelection(first.id, () => choice)
  await f.owner.releaseDocument('shared-page', 'original-document')
  await f.owner.upload({ ...f.context, navigationId: 'new-document', currentNavigationId: () => 'new-document' }, ['selected.txt'])
  const next = f.selected()[0]!
  accept(true)
  expect(await confirmation).toBe(false)
  await expect(readFile(next, 'utf8')).resolves.toBe('original snapshot')
  expect((await f.owner.retained()).selections).toEqual([expect.objectContaining({ navigationId: 'new-document' })])
})

it('recovers the original 128-selection bound and frees only the one person-confirmed slot', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'empty.txt'), '')
  await f.owner.upload(f.context, ['empty.txt'])
  const original = dirname(dirname(f.selected()[0]!))
  await f.owner.dispose()
  // This test owns recovery, rather than repeating the already-tested snapshot/DOM
  // pipeline 128 times. Clone one real production metadata+snapshot record into
  // distinct private selection directories; the original reader must count all.
  for (let index = 1; index < 128; index++) {
    const destination = await mkdtemp(join(f.staging, 'upload-'))
    await cp(original, destination, { recursive: true })
  }
  const restarted = f.create(); const retained = await restarted.retained()
  expect(retained.selections).toHaveLength(128)
  expect(retained.selectionCount).toBe(128)
  expect(retained.byteLength).toBe(0)
  const assignments = f.send.mock.calls.filter(call => call[0] === 'DOM.setFileInputFiles').length
  await expect(restarted.upload(f.context, ['empty.txt'])).rejects.toThrow('staging is full')
  expect(f.send.mock.calls.filter(call => call[0] === 'DOM.setFileInputFiles')).toHaveLength(assignments)
  expect(await restarted.confirmDiscardSelection(retained.selections[0]!.id, async () => true)).toBe(true)
  await restarted.upload(f.context, ['empty.txt'])
  expect((await restarted.retained()).selections).toHaveLength(128)
}, 20_000)
