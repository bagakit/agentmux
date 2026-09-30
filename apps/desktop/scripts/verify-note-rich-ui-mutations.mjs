import assert from 'node:assert/strict'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const renderer = 'apps/desktop/src/renderer/src/'
const editor = `${renderer}components/NoteBlockEditor.tsx`, surface = `${renderer}components/NoteFileSurfaceView.tsx`
const fileSurface = `${renderer}components/FileSurfaceView.tsx`, knowledge = `${renderer}lib/note-knowledge.ts`
const schema = 'apps/desktop/src/shared/note-content-schema.ts'
const document = 'apps/desktop/src/shared/note-document.ts'
const view = `${renderer}components/NoteFileView.tsx`
const tests = ['apps/desktop/test/survey-note-block-knowledge.test.tsx', 'apps/desktop/test/note-file-surface.test.tsx']
const mutations = [
  { label: 'split-loses-semantic-identities', file: editor, before: "attributeName: 'blockId', types: [...NOTE_BLOCK_TYPES]", after: "attributeName: 'blockId', types: []" },
  { label: 'paste-reuses-reference-occurrence', file: editor, before: "attributeName: 'referenceId', types: [NoteBlockReferenceNode.name]", after: "attributeName: 'referenceId', types: []" },
  { label: 'embed-becomes-editable-copy', file: editor, before: 'content: doc, editable: false,', after: 'content: doc, editable: true,' },
  { label: 'duplicate-note-identity-first-wins', file: knowledge, before: 'if (sources.length > 1)', after: 'if (sources.length > 100)' },
  { label: 'unread-target-called-missing', file: knowledge, before: "knowledge.scope === 'complete' && knowledge.invalid.length === 0", after: 'knowledge.invalid.length === 0' },
  { label: 'backlinks-ignore-exact-target', file: knowledge, before: 'reference.target.noteId === target.noteId && reference.target.blockId === target.blockId', after: 'true' },
  { label: 'rich-view-detached-from-file-caller', file: fileSurface, before: 'const note = surface.path.endsWith(NOTE_FILE_EXTENSION)', after: 'const note = false' },
  { label: 'edit-updates-wrong-mixed-region', file: surface, before: 'update(tabId, raw, surface.regionId)', after: 'update(tabId, raw)' },
  { label: 'return-mints-canonical-file-tab', file: surface, before: 'path: resource.path }, reference, ...(projection', after: 'path: resource.path }, ...(projection' },
  { label: 'cross-zone-return-keeps-wrong-zone', file: surface, before: 'zoneId: targetTab.space.zoneId', after: 'zoneId: heldSelection!.zoneId' },
  { label: 'multiple-positions-silently-first-wins', file: surface, before: 'if (exact.length > 1)', after: 'if (false)' },
  { label: 'stale-chooser-opens-deleted-block', file: surface, before: '!currentSource?.blocks.has(blockId)', after: 'false' },
  { label: 'atomic-block-fakes-text-caret', file: editor, before: 'if (textblock) selection.setTextSelection(position)', after: 'if (true) selection.setTextSelection(position)' },
  { label: 'read-time-trailing-node-writes-body', file: schema, before: 'StarterKit.configure({ trailingNode: false })', after: 'StarterKit.configure({ trailingNode: true })' },
  { label: 'closed-picker-scans-loaded-blocks', file: editor, before: 'if (!picker) return []', after: 'if (false) return []' },
  { label: 'unknown-mark-data-silently-dropped', file: document, before: "if (Object.keys(mark).some(key => !['type', 'attrs'].includes(key)))", after: 'if (false)' },
  { label: 'directory-refresh-uses-wrong-region', file: surface, before: 'refreshNoteDirectorySources(tabId, surface.regionId)', after: "refreshNoteDirectorySources(tabId, '')" },
  { label: 'directory-confirmed-claims-global-knowledge', file: surface, before: "noteKnowledge(loadedNoteFiles(notes), 'partial')", after: "noteKnowledge(loadedNoteFiles(notes), 'complete')" },
  { label: 'directory-failure-notice-disappears', file: surface, before: 'directoryFacts?.issues.length ?', after: 'false ?' },
  { label: 'unrelated-session-enumerates-all-documents', file: knowledge, before: 'if (noteFiles) return noteFiles', after: 'if (false) return noteFiles' },
  { label: 'foreign-revision-rederives-this-directory', file: surface, before: 'state.workspaceFileRevisions[surface.workspaceId] ?? 0', after: 'Object.values(state.workspaceFileRevisions).reduce((sum, revision) => sum + revision, 0)' },
  { label: 'new-block-selection-before-canonical-write-only', file: editor, before: 'if (editor.view.hasFocus()) {', after: 'if (false) {' },
  { label: 'semantic-restore-rewinds-live-typing', file: view, before: 'if (selected === restoredBlock.blockId)', after: 'if (false)' },
  { label: 'nonfirst-semantic-selection-not-restored', file: view, before: 'if (!restoredBlock || !handle)', after: 'if (true)' },
  { label: 'semantic-restore-takes-dom-focus', file: view, before: "if (read.status !== 'valid' || read.note.noteId !== restoredBlock.noteId || !handle.focusBlock(restoredBlock.blockId, false))", after: "if (read.status !== 'valid' || read.note.noteId !== restoredBlock.noteId || !handle.focusBlock(restoredBlock.blockId, true))" },
  { label: 'unknown-semantic-target-notice-disappears', file: view, before: 'restoreIssue || issue ? <div', after: 'issue ? <div' },
  { label: 'unread-source-open-is-dead-ui', file: surface, before: 'onClick={() => void openUnread(path)}', after: 'onClick={() => {}}' },
  { label: 'unknown-selection-blocks-explicit-region-focus', file: view, before: 'const editor = handle.editor', after: "if (restoredBlock && !handle.focusBlock(restoredBlock.blockId, false)) return\n    const editor = handle.editor" },
  { label: 'pasted-null-reference-crashes-rich-input', file: editor, before: 'if (!reference.target) return', after: 'if (false) return' }
]
const requested = process.argv.find(value => value.startsWith('--only='))?.slice(7).split(',')
const selected = requested ? mutations.filter(mutation => requested.includes(mutation.label)) : mutations
assert.ok(selected.length > 0, 'The requested mutation selection must not be empty.')
if (requested) assert.deepEqual([...new Set(requested)].sort(), selected.map(mutation => mutation.label).sort(), 'Every requested mutation must exist in the actual descriptor.')
await verifyRendererSourceMutations({ name: `note-rich-ui-mutations-${Date.now()}`, tests, mutations: selected,
  sources: [editor, surface, fileSurface, knowledge, schema, document, `${renderer}components/NoteFileView.tsx`, `${renderer}components/EditorPane.tsx`,
    'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/scripts/verify-note-rich-ui-mutations.mjs',
    'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs'] })
