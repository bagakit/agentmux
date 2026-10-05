import '../../monaco'
import Editor from '@monaco-editor/react'
import { useMonacoTheme } from '../../hooks/useMonacoTheme'

/** Only the selected visible tool owns a model; the draft itself lives in the Settings Pane. */
export default function ToolkitScriptEditor({ id, actionId, display = false, value, onChange }: { id: string; actionId: string | null; display?: boolean; value: string; onChange(value: string): void }) {
  const theme = useMonacoTheme()
  return <Editor height="260px" language="javascript" theme={theme} path={`toolkit:///${encodeURIComponent(id)}${display ? '/display' : actionId === null ? '' : `/actions/${encodeURIComponent(actionId)}`}.mjs`}
    value={value} onChange={text => onChange(text ?? '')} keepCurrentModel={false} saveViewState
    loading={<span className="settings-hint">Opening script editor…</span>}
    options={{ minimap: { enabled: false }, fontSize: 12, lineNumbers: 'on', scrollBeyondLastLine: false, wordWrap: 'on', automaticLayout: true, padding: { top: 14, bottom: 14 }, tabSize: 2 }} />
}
