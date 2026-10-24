import { fixturePath as _historyFixturePath } from "../../../test/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { fileUploadRevision } from '@agentmux/core/files'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import type { WorkspaceFileWriteInput, WorkspaceRecord } from '../src/shared/contracts'

afterEach(() => vi.restoreAllMocks())
it('keeps the original base, operation and trusted actor through the exact Host resource owner', async () => {
  const workspace: WorkspaceRecord = { id: 'original-workspace', hostId: 'local', path: _historyFixturePath("fixture"), name: 'Original', kind: 'folder' }
  const baseContent = 'Exact base\r\n', content = 'Proposed body\n', operationId = 'original-operation'
  const expectedRevision = fileUploadRevision(new TextEncoder().encode(baseContent)), revision = fileUploadRevision(new TextEncoder().encode(content))
  const write = vi.fn(async (_workspace: WorkspaceRecord, _input: WorkspaceFileWriteInput) => ({ status: 'written' as const, revision, content,
    noteHistory: { eventId: operationId, batchId: operationId, status: 'committed' as const } }))
  const owner = new FileReadOwner({ workspace: () => workspace, catalog: async () => ({ zones: [{ zoneId: 'zone', workspaceId: workspace.id, kind: 'directory', hostId: 'local', directoryPath: workspace.path }], bindings: [] }) as never,
    files: { write, read: vi.fn(), listFiles: vi.fn() } })
  const resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, zoneId: 'zone', zonePath: workspace.path, path: 'page.note.md' }
  const context = { actor: { kind: 'agent' as const, id: 'original-agent' } }, input = { zoneId: 'zone', path: resource.path, expectedResource: resource, content, expectedRevision, baseContent, operationId }
  expect(await owner.write(input, context)).toMatchObject({ resource, result: { status: 'written', noteHistory: { eventId: operationId } } })
  expect(write).toHaveBeenCalledExactlyOnceWith(workspace, { path: resource.path, content, expectedRevision, baseContent, operationId }, context)
  await expect(owner.write({ ...input, expectedResource: { ...resource, zonePath: _historyFixturePath("fixture/rebound"), path: 'rebound/page.note.md' } }, context)).rejects.toMatchObject({ code: 'FILE_RESOURCE_MISMATCH' })
  expect(write).toHaveBeenCalledTimes(1)
})
