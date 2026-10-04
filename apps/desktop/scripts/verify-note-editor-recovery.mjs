import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const editor = 'apps/desktop/src/renderer/src/components/NoteBlockEditor.tsx'
const view = 'apps/desktop/src/renderer/src/components/NoteFileView.tsx'
await verifyRendererSourceMutations({
  name: ("note-editor-recovery-" + (globalThis.crypto.randomUUID()) + ""),
  tests: ['apps/desktop/test/note-file-surface.test.tsx'],
  sources: [editor, view, 'apps/desktop/src/renderer/src/components/NoteFileSurfaceView.tsx', 'apps/desktop/src/renderer/src/components/FileSurfaceView.tsx', 'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/scripts/verify-note-editor-recovery.mjs'],
  mutations: [
    { label: 'unmounted-view-still-publishes-handle', file: editor, before: ".on('unmount', detach)", after: '' },
    { label: 'remounted-view-never-resumes-selection', file: editor, before: "editor.on('mount', attach)", after: 'editor' }
  ]
})
