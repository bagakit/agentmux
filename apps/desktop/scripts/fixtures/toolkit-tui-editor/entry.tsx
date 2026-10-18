import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { editor } from 'monaco-editor'
import { mountThemeRuntime, readResolvedTheme, updateThemeSelection } from '@agentmux/client-ui/theme'
import ToolkitScriptEditor from '../../../src/renderer/src/components/settings/ToolkitScriptEditor'

const script = "# Rendered shell syntax\nexport TOOL_LABEL='Workspace monitor'\nif [ -n \"$TOOL_LABEL\" ]; then\n  echo $TOOL_LABEL $1\n  exec workspace-report --count 7\nfi\n"
mountThemeRuntime(window, { appAppearance: 'dark' })
function View() {
  const [mode, setMode] = useState<'script' | 'tui'>('tui')
  const [value, setValue] = useState(script)
  return <main><nav><button data-mode="script" onClick={() => setMode('script')}>Script</button><button data-mode="tui" onClick={() => setMode('tui')}>TUI</button><button data-theme="light" onClick={() => updateThemeSelection({ appAppearance: 'light' })}>Light</button></nav><ToolkitScriptEditor id="syntax-proof" actionId={null} mode={mode} value={value} onChange={setValue} /></main>
}
createRoot(document.getElementById('root')!).render(<View />)
Object.assign(window, { toolkitEditorProof: { script, facts() {
  const instance = editor.getEditors().find(item => item.getDomNode()?.isConnected)
  const model = instance?.getModel()
  if (!model) return null
  const theme = readResolvedTheme(window)
  return { id: model.id, uri: model.uri.toString(), language: model.getLanguageId(), value: model.getValue(),
    tokens: editor.tokenize(model.getValue(), model.getLanguageId()).map((line, index) => line.map((token, offset) => ({ type: token.type, text: model.getLineContent(index + 1).slice(token.offset, line[offset + 1]?.offset) }))),
    spans: [...document.querySelectorAll<HTMLElement>('.view-line span[class*="mtk"]')].map(node => ({ text: node.textContent?.replaceAll('\u00a0', ' '), color: getComputedStyle(node).color })),
    theme: { mode: theme.mode, colors: theme.variant.colors } }
} } })
