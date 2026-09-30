import { readFileSync } from 'node:fs'
import { exactReplace, verifyWorkfaceMutations } from './lib/workface-mutation-proof.mjs'
const view = 'apps/desktop/src/renderer/src/lib/workface-file-view.ts'
const mode = 'apps/desktop/src/renderer/src/lib/file-region-presentation.ts'
const editor = 'apps/desktop/src/renderer/src/components/EditorPane.tsx'
const store = 'apps/desktop/src/renderer/src/store.ts'
const read = path => readFileSync(path, 'utf8')
verifyWorkfaceMutations({ operation: 'file-view', testPath: 'apps/desktop/test/workface-file-view-control.test.tsx',
  sourcePaths: [view, mode, editor, store, 'apps/desktop/src/renderer/src/components/FileSurfaceView.tsx',
    'apps/desktop/src/renderer/src/components/GitDiffCanvas.tsx', 'apps/desktop/test/helpers/workface-monaco-fixture.ts',
    'apps/desktop/src/renderer/src/lib/desktop-presentation.ts', 'apps/desktop/test/helpers/workface-file-fixture.ts',
    'packages/core/bin/agentmux', 'packages/core/dist/agentmux.js', 'packages/core/dist/control-host.js'],
  callers: [{ symbol: 'executeWorkfaceFileView', definition: view }, { symbol: 'storedFileRegionMode', definition: mode },
    { symbol: 'effectiveFileRegionMode', definition: mode }, { symbol: 'setEditorRegionMode', definition: store }],
  variants: [
    { name: 'legal-own-region-mode-withdrawn', changes: { [mode]: exactReplace(read(mode),
      "  if (!Object.hasOwn(modes, regionId)) return null\n  const mode = modes[regionId]\n  return mode === 'edit' || mode === 'diff' || mode === 'preview' ? mode : null",
      '  return modes[regionId] ?? null') } },
    { name: 'actual-editor-mode-consumption-withdrawn', changes: { [editor]: exactReplace(read(editor),
      "const regionMode = useAppStore((state) => effectiveFileRegionMode(state.editorRegionModes, surface.regionId, surface.path, issue?.kind === 'binary'))",
      "const regionMode = 'edit' as import('../lib/file-region-presentation').EditorRegionMode") } },
    { name: 'input-loss-report-withdrawn', changes: { [view]: exactReplace(read(view),
      'if (!desktopInputPreserved(input, captureDesktopInput(ports.get().tabs)))', 'if (false)') } }
  ] })
