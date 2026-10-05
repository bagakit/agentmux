import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import { FileSourceEditor } from '../../../src/renderer/src/components/FileSourceEditor'
import { GitDiffCanvas } from '../../../src/renderer/src/features/git/diff/GitDiffCanvas'
import { ExcalidrawFilePreview } from '../../../src/renderer/src/components/file-preview/ExcalidrawFilePreview'
import { useAppStore } from '../../../src/renderer/src/store'
import { documentKey } from '../../../src/renderer/src/lib/workbench-tabs'
import { mountThemeRuntime, updateThemeSelection, GRAPHITE_THEME, themeValue } from '@agentmux/client-ui/theme'
import { MobilePrimaryNavigation } from '../../../../mobile/src/navigation/MobilePrimaryNavigation'
import { ComposerLayoutToggle } from '@agentmux/client-ui/components/ComposerLayoutToggle'
import { MoteIcon } from '@agentmux/client-ui/components/MoteIcon'
import { WorkflowStatusGlyph } from '@agentmux/client-ui/components/WorkflowObservation'
import '../../../src/renderer/src/styles/index.css'

const key = documentKey('icons-proof', 'source.ts')
const source = `function originalWorkspace() {\n  const preserved = "draft";\n  if (preserved) {\n    return preserved;\n  }\n}\noriginalWorkspace();\n`
useAppStore.setState({ config: { appearance: { appAppearance: 'light', editorFontSize: 14 } }, documents: { [key]: { path: 'source.ts', content: source, revision: 'private-v1' } } } as never)
const custom = structuredClone(GRAPHITE_THEME)
custom.id = 'custom.native-icons'; custom.name = 'Native icon proof'
custom.icons = {
  'editor.match-case': { kind: 'paths', paths: [{ d: 'M3 3 L21 3 L12 21 Z' }] },
  'editor.fold': { kind: 'glyph', glyph: 'circle-help' },
  'editor.symbol-method': { kind: 'glyph', glyph: 'gem' },
  'editor.symbol-function': { kind: 'glyph', glyph: 'gem' },
  'editor.diff-added': { kind: 'glyph', glyph: 'circle-check' },
  'action.search': { kind: 'glyph', glyph: 'gem' },
  'action.close': { kind: 'glyph', glyph: 'gem' },
  'action.open-external': { kind: 'glyph', glyph: 'gem' },
  'object.library': { kind: 'glyph', glyph: 'gem' },
  'action.import': { kind: 'glyph', glyph: 'gem' },
  'navigation.up': { kind: 'glyph', glyph: 'gem' },
  'navigation.down': { kind: 'glyph', glyph: 'gem' },
  'action.menu': { kind: 'glyph', glyph: 'gem' },
  'action.help': { kind: 'glyph', glyph: 'gem' },
  'action.zoom-in': { kind: 'glyph', glyph: 'gem' },
  'action.copy': { kind: 'glyph', glyph: 'gem' },
  'object.goal': { kind: 'glyph', glyph: 'gem' },
  'object.mote': { kind: 'glyph', glyph: 'gem' }
}
const selection = { themeId: custom.id, customThemes: { [custom.id]: themeValue(custom) }, appAppearance: 'light' as const }
const disposeRuntime = mountThemeRuntime(window, { appAppearance: 'light' })
if (import.meta.hot) import.meta.hot.dispose(disposeRuntime)
// Production FileSourceEditor loads the native setup/adapter. Completion data uses Monaco's public provider API.
monaco.languages.registerCompletionItemProvider('typescript', { provideCompletionItems: (_model, position) => ({ suggestions: [
  { label: 'themeableFunction', kind: monaco.languages.CompletionItemKind.Function, insertText: 'themeableFunction()',
    range: { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: 1, endColumn: position.column } }
] }) })
const scene = JSON.stringify({ type: 'excalidraw', version: 2, elements: [
  { type: 'rectangle', id: 'user-content', x: 0, y: 0, width: 220, height: 140, strokeColor: '#233442', backgroundColor: '#f1dfc6', fillStyle: 'solid', strokeWidth: 2 },
  { type: 'text', id: 'user-label', x: 10, y: 50, width: 200, height: 30, text: 'User scene content', fontSize: 20, fontFamily: 2, strokeColor: '#233442' }
], appState: { viewBackgroundColor: '#fffaf0' }, files: {} })
function Fixture() {
  const state = useRef(null)
  const [theme, setTheme] = useState(false)
  const [primary, setPrimary] = useState<'space' | 'goals' | 'topics' | 'mote' | 'focus'>('space')
  const [phase, setPhase] = useState<'collapsed' | 'current' | 'expanded'>('collapsed')
  useEffect(() => { updateThemeSelection(theme ? selection : { appAppearance: 'light' }) }, [theme])
  return <main style={{ padding: 16, height: '100vh', display: 'grid', gridTemplateRows: '48px 320px 300px', gap: 12 }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 16 }}><button onClick={() => setTheme(v => !v)}>Switch icon theme</button>
      <MobilePrimaryNavigation current={primary} onSelect={setPrimary} /><ComposerLayoutToggle phase={phase} onChange={setPhase} />
      <MoteIcon size={20} /><WorkflowStatusGlyph status="running" /><WorkflowStatusGlyph status="running" recorded />
      <output>{primary} · {phase} · {theme ? 'custom' : 'default'}</output>
    </header>
    <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <div id="source-host"><FileSourceEditor tabId="proof" surface={{ regionId: 'source-proof', kind: 'file', workspaceId: 'icons-proof', path: 'source.ts' }} viewState={state} /></div>
      <div><ExcalidrawFilePreview content={scene} /></div>
    </section>
    <section><GitDiffCanvas theme="vs" wordWrap={false} language="typescript" diff={{ loading: false, error: null, diff: {
      binary: false, old: { present: true, binary: false, text: 'const before = 1;\n' }, new: { present: true, binary: false, text: 'const after = 2;\n' }, path: 'diff.ts', status: 'modified'
    } as never }} /></section>
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
Object.assign(window, { nativeIconProof: {
  sourceEditor: () => monaco.editor.getEditors().find(editor => editor.getModel()?.uri.scheme === 'agentmux-file'),
  facts: () => ({ models: monaco.editor.getModels().length, editors: monaco.editor.getEditors().length,
    value: monaco.editor.getEditors().find(editor => editor.getModel()?.uri.scheme === 'agentmux-file')?.getValue(),
    styleCount: document.querySelectorAll('[data-monaco-semantic-icons]').length,
    codedIcons: [...document.querySelectorAll('.monaco-editor .codicon')].map(node => node.className),
    controls: [...document.querySelectorAll('.file-excalidraw-preview button, .file-excalidraw-preview input')].map(node => ({ tag: node.tagName, testId: node.getAttribute('data-testid'), className:node.className })) })
} })
