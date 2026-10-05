import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const field = 'packages/client-ui/src/components/InlineRenameField.tsx'
const source = 'apps/desktop/src/renderer/src/components/EditorPane.tsx'
const diff = 'apps/desktop/src/renderer/src/features/git/diff/GitDiffCanvas.tsx'
const typography = 'apps/desktop/src/renderer/src/hooks/useEditorTypography.ts'
const appearance = 'apps/desktop/src/main/settings/modules/appearance.ts'
const explorer = 'apps/desktop/src/renderer/src/components/FileExplorer.tsx'

await verifyRendererSourceMutations({
  name: 'explorer-editing-polish-mutations-r2',
  tests: [
    'packages/client-ui/test/inline-rename-field.test.tsx',
    'apps/desktop/test/explorer-editing-polish.test.tsx',
    'apps/desktop/test/editor-typography-header.test.tsx',
    'apps/desktop/test/settings-editor-font.test.tsx'
  ],
  sources: [
    field, source, diff, typography, appearance,
    'packages/client-ui/package.json',
    'packages/client-ui/src/lib/ime-keyboard-event.ts',
    'packages/client-ui/src/styles/index.css',
    'packages/client-ui/src/styles/inline-rename-field.css',
    explorer,
    'apps/desktop/src/renderer/src/components/WorkflowComponentGallery.tsx',
    'apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx',
    'apps/desktop/src/renderer/src/components/WindowOverlayHost.tsx',
    'apps/desktop/src/renderer/src/components/HoverDropdownMenu.tsx',
    'apps/desktop/src/renderer/src/components/settings/AppearanceSettingsPane.tsx',
    'apps/desktop/src/renderer/src/components/file-tree/useWorkspaceFileTree.ts',
    'apps/desktop/src/renderer/src/store.ts',
    'apps/desktop/src/renderer/src/lib/api.ts',
    'apps/desktop/src/renderer/src/lib/file-document-bookkeeping.ts',
    'apps/desktop/src/renderer/src/styles/tokens.css',
    'apps/desktop/src/renderer/src/styles/index.css',
    'apps/desktop/src/renderer/src/styles/file-explorer.css',
    'apps/desktop/src/renderer/src/styles/file-preview.css',
    'apps/desktop/src/shared/contracts.ts',
    'apps/desktop/src/main/config-store.ts',
    'apps/desktop/src/main/config-owner.ts',
    'apps/desktop/src/main/runtime-config-transaction.ts',
    'apps/desktop/src/main/settings-control.ts',
    'apps/desktop/src/main/settings/scalar-setting.ts',
    'apps/desktop/test/helpers/client-ui-render.tsx',
    'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/test/helpers/config-owner-fixture.ts',
    'apps/desktop/test/helpers/editor-pane-store.ts',
    'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs',
    'apps/desktop/scripts/verify-explorer-editing-polish-mutations.mjs'
  ],
  mutations: [
    {
      label: 'shared-enter-blur-admission', file: field,
      before: 'current.current.pending || submitting.current || composing.current',
      after: 'current.current.pending || composing.current'
    },
    {
      label: 'ime-final-controlled-draft', file: field,
      before: 'onValueChange(name)',
      after: 'void name'
    },
    {
      label: 'pending-input-readonly', file: field,
      before: 'value={value} readOnly={pending}',
      after: 'value={value} readOnly={false}'
    },
    {
      label: 'create-intent-field-identity', file: explorer,
      before: 'key={createEdit.id}',
      after: 'key="create-field"'
    },
    {
      label: 'source-monaco-app-size', file: source,
      before: 'fontSize: typography.fontSize,',
      after: 'fontSize: 14,'
    },
    {
      label: 'editor-live-font-override', file: typography,
      before: 'const fontSize = override ?? readAppEditorFontSize()',
      after: 'const fontSize = readAppEditorFontSize()'
    },
    {
      label: 'main-inherit-removes-override', file: appearance,
      before: 'delete appearance.editorFontSize',
      after: 'appearance.editorFontSize = config.appearance.editorFontSize'
    },
    {
      label: 'mounted-diff-font-update', file: diff,
      before: 'useEffect(() => { widget.current?.updateOptions({ fontSize: typography.fontSize, lineHeight: typography.lineHeight }) }, [typography.fontSize, typography.lineHeight])',
      after: 'useEffect(() => {}, [typography.fontSize, typography.lineHeight])'
    },
    {
      label: 'saved-light-status', file: source,
      before: '<span className="editor-header__status" role="status" aria-label="File saved">Saved</span>',
      after: '<button className="small-button" disabled aria-label="File saved">Saved</button>'
    }
  ]
})
