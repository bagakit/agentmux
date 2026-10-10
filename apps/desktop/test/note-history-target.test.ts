// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { fileUploadRevision, type FileReadResult } from '@agentmux/core/files'
import { newNoteDocument, serializeNoteDocument } from '../src/shared/note-document'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import type { ScratchTopicSnapshot } from '../src/shared/contracts'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import type { SpatialWorkbench } from '../src/renderer/src/lib/space-agent-control'
import { noteHistoryReadParams, confirmNoteHistoryTarget } from '../src/renderer/src/lib/note-history-target'
import { composerConfig } from './helpers/composer-dom-fixture'

function fixture(workspaceId = 'workspace', path = 'folder/original.note.md', directory = fixturePath('note-history/folder')) {
  const workspace = { id: workspaceId, hostId: 'local', path: fixturePath('note-history'), name: 'Original', kind: 'folder' as const }
  const spaceId = directoryIdentity('local', directory), zoneId = homeZoneId(spaceId)
  const tab = { ...createWorkbenchTab('original-tab', { kind: 'file', regionId: 'original-region', workspaceId, path }), space: { spaceId, zoneId } }
  const state: SpatialWorkbench = { config: { ...composerConfig, workspaces: [workspace] }, sessions: [], tabs: { [tab.id]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('original-group', [tab.id]) },
    spaceZoneBindings: { [zoneId]: { spaceId, workspaceId, directoryPath: directory } }, spatialRequests: {} }
  const content = serializeNoteDocument(newNoteDocument('Original body', 'original-note', 'original-block'))
  const resource = { hostId: 'local', workspaceId, workspacePath: workspace.path, zoneId, zonePath: directory, path }
  const result: FileReadResult = { resource, result: { status: 'read', document: { path, content, revision: fileUploadRevision(new TextEncoder().encode(content)) } } }
  return { state, tab, workspace, spaceId, zoneId, result, resource }
}

it('reads a nested Zone-relative path once and pins the complete resource only from its actual public receipt', () => {
  const f = fixture(), params = noteHistoryReadParams(f.state, [], f.tab.id, 'original-region')
  expect(params).toEqual({ zoneId: f.zoneId, spaceId: f.spaceId, path: 'original.note.md', expectedResource: { hostId: 'local', workspaceId: 'workspace', workspacePath: f.workspace.path } })
  expect(confirmNoteHistoryTarget(params, 'original-note', f.result, 'folder/original.note.md')).toEqual({ target: { ...params, noteId: 'original-note', expectedResource: f.resource }, document: f.result.result.status === 'read' ? f.result.result.document : undefined })
})

it('keeps Source-view history available for a valid original header with unsupported rich content', () => {
  const f = fixture(), params = noteHistoryReadParams(f.state, [], f.tab.id, 'original-region')
  const content = '---\nschema: agentmux.note.md.v1\nnote-id: "original-note"\n---\n\n:::unsupported-source\nOriginal bytes\n:::\n'
  const result: FileReadResult = { resource: f.resource, result: { status: 'read', document: { path: f.resource.path, content, revision: fileUploadRevision(new TextEncoder().encode(content)) } } }
  expect(confirmNoteHistoryTarget(params, 'original-note', result, f.resource.path).document.content).toBe(content)
})

it('never guesses another Zone or grants an outside file a nested Zone prefix', () => {
  const f = fixture()
  f.tab.regions['original-region'] = { kind: 'file', regionId: 'original-region', workspaceId: 'workspace', path: 'outside.note.md' }
  expect(() => noteHistoryReadParams(f.state, [], f.tab.id, 'original-region')).toThrow('does not belong')
  const { space: _space, ...unconfirmed } = f.tab
  f.state.tabs[f.tab.id] = unconfirmed
  expect(() => noteHistoryReadParams(f.state, [], f.tab.id, 'original-region')).toThrow()
})

it('rejects another Note identity, another observed path and unknown reads instead of empty history', () => {
  const f = fixture(), params = noteHistoryReadParams(f.state, [], f.tab.id, 'original-region')
  expect(() => confirmNoteHistoryTarget(params, 'another-note', f.result, f.resource.path)).toThrow('another or unconfirmed original Note')
  const content = serializeNoteDocument(newNoteDocument('Original body', 'original-note', 'original-block'))
  const moved: FileReadResult = { resource: { ...f.resource, zonePath: fixturePath('note-history/other'), path: 'other/original.note.md' }, result: { status: 'read', document: { path: 'other/original.note.md', content, revision: fileUploadRevision(new TextEncoder().encode(content)) } } }
  expect(() => confirmNoteHistoryTarget(params, 'original-note', moved, f.resource.path)).toThrow('no longer maps')
  expect(() => confirmNoteHistoryTarget(params, 'original-note', { resource: null, result: { status: 'unknown', code: 'FILE_READ_UNCONFIRMED', message: 'The original reader is unavailable' } }, f.resource.path)).toThrow('original reader is unavailable')
})

it('retains a Scratch logical namespace while pinning its confirmed outside physical directory', () => {
  const id = 'view:exact-topic', logical = scratchTopicDirectoryName(id), physical = fixturePath('physical-note-history')
  const f = fixture('__scratch__', logical + '/original.note.md', physical)
  const identity = fixturePath('note-history/' + logical), spaceId = directoryIdentity('local', identity), zoneId = homeZoneId(spaceId)
  f.tab.space = { spaceId, zoneId }; f.state.spaceZoneBindings = { [zoneId]: { spaceId, workspaceId: '__scratch__', directoryPath: physical } }
  const topics: ScratchTopicSnapshot[] = [{ id, title: 'Original', summary: '', directoryPath: logical, topicPath: logical + '/topic.md', collaborators: [], kind: 'mote', identityDirectoryPath: identity, physicalDirectoryPath: physical, confirmedDirectoryPaths: [physical] }]
  const params = noteHistoryReadParams(f.state, topics, f.tab.id, 'original-region')
  expect(params.path).toBe('original.note.md')
  const result = { ...f.result, resource: { ...f.resource, zoneId, logicalDirectory: logical } }
  expect(confirmNoteHistoryTarget(params, 'original-note', result, f.resource.path).target.expectedResource).toEqual(result.resource)
})
