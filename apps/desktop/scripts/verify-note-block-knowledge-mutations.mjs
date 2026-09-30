import assert from 'node:assert/strict'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const renderer = 'apps/desktop/src/renderer/src/'
const store = `${renderer}store.ts`, files = 'apps/desktop/src/main/workspace-files.ts'
const naming = `${renderer}lib/note-names.ts`, placement = `${renderer}lib/file-workbench-state.ts`
const selection = `${renderer}lib/note-block-selection.ts`, presentation = `${renderer}lib/workbench-presentation.ts`
const discovery = `${renderer}lib/note-directory-sources.ts`
const creation = `${renderer}lib/note-creation.ts`, document = 'apps/desktop/src/shared/note-document.ts'
const tests = ['apps/desktop/test/note-block-selection-store.test.ts', 'apps/desktop/test/note-create-store.test.ts', 'apps/desktop/test/note-creation.test.ts',
  'apps/desktop/test/workspace-files-create-result.test.ts', 'apps/desktop/test/file-save-store.test.ts',
  'apps/desktop/test/note-document.test.ts', 'apps/desktop/test/note-names.test.ts',
  'apps/desktop/test/note-directory-sources.test.ts', 'apps/desktop/test/note-unknown-mark-view.test.tsx']
const mutations = [
  { label: 'block-selection-group-collapses', file: selection, before: 'reference.displayWorkspaceId, reference.groupId, reference.tabId', after: 'reference.displayWorkspaceId, reference.tabId' },
  { label: 'block-selection-not-persisted', file: store, before: 'noteBlockSelections: state.noteBlockSelections,', after: 'noteBlockSelections: {},' },
  { label: 'multiple-home-groups-pick-winner', file: presentation, before: 'references.has(tabId) ? null :', after: 'false ? null :' },
  { label: 'initial-text-write-not-exclusive', file: files, before: "...(input.expectedRevision === null ? { exclusive: true } : {})", after: "...(input.expectedRevision === null ? {} : {})" },
  { label: 'published-unknown-called-error', file: files, before: "? { ...detail, status: 'unknown' } : detail", after: "? { ...detail, status: 'error' } : detail" },
  { label: 'permission-replayed-as-collision', file: naming, before: "if (result.status !== 'conflict') return { path, result }", after: "if (result.status === 'written' || result.status === 'unknown') return { path, result }" },
  { label: 'dirty-write-unknown-called-success', file: store, before: "if (result.status === 'error' || result.status === 'unknown') {", after: "if (result.status === 'error' || result.status === 'unknown') { if (result.status === 'unknown') return" },
  { label: 'bookmark-unknown-replayed', file: store, before: "if (result.status === 'error' || result.status === 'unknown') throw Object.assign(new Error(result.message), { code: result.code })", after: "if (result.status === 'error') throw Object.assign(new Error(result.message), { code: result.code })" },
  { label: 'creation-regenerates-content-identities', file: store, before: 'newNoteDocument(draft, noteId, blockId)', after: 'newNoteDocument(draft, crypto.randomUUID(), crypto.randomUUID())' },
  { label: 'creation-grants-newer-file-reveal', file: store, before: 'fileOpenIntentVersion !== openingIntent || fileNavigationSelection(get()) !== fileNavigationSelection(captured)', after: 'fileNavigationSelection(get()) !== fileNavigationSelection(captured)' },
  { label: 'resource-change-retargets-same-id', file: creation, before: 'return workspace?.hostId === target.hostId && workspace.path === target.workspacePath', after: 'return Boolean(workspace)' },
  { label: 'true-home-replaced-with-scratch-root', file: creation, before: "directory = zone.directoryPath.replace(/\\/+$/, '') || '/'", after: "directory = root" },
  { label: 'mixed-file-reference-mints-canonical-tab', file: placement, before: 'if (placement?.reference) {', after: 'if (false) {' },
  { label: 'survey-file-reference-activates-space', file: placement, before: 'if (placement.projection) return state', after: 'if (false) return state' },
  { label: 'unread-directory-sources-called-complete', file: discovery, before: 'unread.length || unconfirmed.size || directoryChanged', after: 'unconfirmed.size || directoryChanged' },
  { label: 'closed-note-source-read-without-region', file: store, before: 'if (!Object.values(get().tabs).some(tab => workbenchSurfaces(tab).some(candidate =>', after: 'if (false && !Object.values(get().tabs).some(tab => workbenchSurfaces(tab).some(candidate =>' },
  { label: 'directory-source-resource-check-dropped', file: store, before: 'await loadPersistedFileDocument(resource.id, path, resource)', after: 'await loadPersistedFileDocument(resource.id, path)' },
  { label: 'unsupported-mark-source-silently-dropped', file: document, before: "if (Object.keys(mark).some(key => !['type', 'attrs'].includes(key))) throw new Error('The Note contains unsupported mark data.')", after: 'void Object.keys(mark)' },
  { label: 'duplicate-block-identity-accepted', file: document, before: '!identity(node.attrs.blockId) || blocks.has(node.attrs.blockId)', after: '!identity(node.attrs.blockId)' }
]
const requested = process.argv.find(value => value.startsWith('--only='))?.slice(7).split(',')
const selected = requested ? mutations.filter(mutation => requested.includes(mutation.label)) : mutations
assert.ok(selected.length > 0, 'The requested mutation selection must not be empty.')
if (requested) assert.deepEqual([...new Set(requested)].sort(), selected.map(mutation => mutation.label).sort(), 'Every requested mutation must exist in the actual descriptor.')
await verifyRendererSourceMutations({ name: `note-block-knowledge-mutations-${Date.now()}`, tests,
  sources: [selection, presentation, store, files, naming, placement, creation, discovery, document, 'apps/desktop/src/shared/note-content-schema.ts',
    'apps/desktop/scripts/verify-note-block-knowledge-mutations.mjs', 'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs'],
  mutations: selected })
