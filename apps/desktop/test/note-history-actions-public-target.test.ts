import { fixturePath as _historyFixturePath } from "../../../test/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { fileUploadRevision } from '@agentmux/core/files'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import type { WorkspaceRecord, WorkspaceFileRestoreInput, WorkspaceFileUndoInput } from '../src/shared/contracts'

afterEach(() => vi.restoreAllMocks())
const workspace: WorkspaceRecord = { id: 'original-workspace', hostId: 'local', path: _historyFixturePath("fixture"), name: 'Original', kind: 'folder' }
const resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, zoneId: 'zone', zonePath: workspace.path, path: 'page.note.md' }
const expectedRevision = fileUploadRevision(new TextEncoder().encode('original observed body'))
const context = { actor: { kind: 'agent' as const, id: 'trusted-agent' } }
const common = { zoneId: resource.zoneId, path: resource.path, expectedResource: resource, noteId: 'original-note', expectedRevision, operationId: 'original-action' }
const catalog = async () => ({ zones: [{ zoneId: resource.zoneId, workspaceId: workspace.id, kind: 'directory', hostId: 'local', directoryPath: workspace.path }], bindings: [] }) as never

it('forwards exact restore and undo selections through the original mapping and trusted actor without caller bodies', async () => {
  const reply = { status: 'conflict' as const, observedRevision: expectedRevision }, restore = vi.fn(async (_workspace: WorkspaceRecord, _input: WorkspaceFileRestoreInput) => reply), undo = vi.fn(async (_workspace: WorkspaceRecord, _input: WorkspaceFileUndoInput) => reply)
  const owner = new FileReadOwner({ workspace: () => workspace, catalog, files: { write: vi.fn(), read: vi.fn(), listFiles: vi.fn(), restore, undo } })
  const selectedEvent = { ...common, eventId: 'selected-event' }, selectedBatch = { ...common, batchId: 'selected-batch', batchLastEventId: 'selected-tail' }
  expect(await owner.restore(selectedEvent, context)).toEqual({ resource, result: reply })
  expect(restore).toHaveBeenCalledExactlyOnceWith(workspace, { path: resource.path, noteId: common.noteId, expectedRevision, operationId: common.operationId, eventId: selectedEvent.eventId }, context)
  expect(await owner.undo(selectedBatch, context)).toEqual({ resource, result: reply })
  expect(undo).toHaveBeenCalledExactlyOnceWith(workspace, { path: resource.path, noteId: common.noteId, expectedRevision, operationId: common.operationId, batchId: selectedBatch.batchId, batchLastEventId: selectedBatch.batchLastEventId }, context)
  const rebound = { ...resource, zonePath: _historyFixturePath("fixture/rebound"), path: 'rebound/page.note.md' }
  await expect(owner.restore({ ...selectedEvent, expectedResource: rebound }, context)).rejects.toMatchObject({ code: 'FILE_RESOURCE_MISMATCH' })
  await expect(owner.undo({ ...selectedBatch, expectedResource: rebound }, context)).rejects.toMatchObject({ code: 'FILE_RESOURCE_MISMATCH' })
  expect(restore).toHaveBeenCalledTimes(1); expect(undo).toHaveBeenCalledTimes(1)
})

it('rejects only missing history ports, keeps ordinary file work and reports original observation failures as unknown', async () => {
  const write = vi.fn(async () => ({ status: 'conflict' as const, observedRevision: expectedRevision })), read = vi.fn(async () => ({ status: 'directory' as const }))
  const owner = new FileReadOwner({ workspace: () => workspace, catalog, files: { write, read, listFiles: vi.fn() } })
  expect(await owner.restore({ ...common, eventId: 'selected-event' }, context)).toMatchObject({ result: { status: 'error', code: 'CONTROL_UNAVAILABLE' } })
  expect(await owner.undo({ ...common, batchId: 'selected-batch', batchLastEventId: 'selected-tail' }, context)).toMatchObject({ result: { status: 'error', code: 'CONTROL_UNAVAILABLE' } })
  expect(await owner.write({ zoneId: common.zoneId, path: common.path, expectedResource: resource, expectedRevision, content: 'ordinary' }, context)).toMatchObject({ result: { status: 'conflict' } })
  expect(await owner.read({ zoneId: common.zoneId, path: common.path, expectedResource: { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath } })).toMatchObject({ result: { status: 'directory' } })
  const unavailable = new FileReadOwner({ workspace: () => workspace, catalog: async () => { throw Error('Original catalog unavailable') }, files: { write, read, listFiles: vi.fn() } })
  expect(await unavailable.restore({ ...common, eventId: 'selected-event' }, context)).toMatchObject({ resource: null, result: { status: 'unknown', code: 'FILE_RESTORE_UNCONFIRMED' } })
  expect(await unavailable.undo({ ...common, batchId: 'selected-batch', batchLastEventId: 'selected-tail' }, context)).toMatchObject({ resource: null, result: { status: 'unknown', code: 'FILE_UNDO_UNCONFIRMED' } })
  expect(write).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(1)
})
