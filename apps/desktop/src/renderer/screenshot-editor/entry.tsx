import { createRoot } from 'react-dom/client'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import type { SystemScreenshotEditorApi } from '../../shared/system-screenshot-editor'
import { SystemScreenshotEditorView } from './SystemScreenshotEditorView'
import { installFileDropGuard } from '../src/lib/file-drop-guard'
import './screenshot-editor.css'
import { ScreenshotSourceView } from './ScreenshotSourceView'
import type { ScreenshotSourceApi } from '../../shared/screenshot-source'

const api = (window as unknown as { screenshotEditor: SystemScreenshotEditorApi }).screenshotEditor
installFileDropGuard(window)
const root = createRoot(document.getElementById('root')!)
const sources = (window as unknown as { screenshotSources?: ScreenshotSourceApi }).screenshotSources
if (sources) void sources.load().then(input => {
  mountThemeRuntime(window, input.theme.status === 'available' ? { kind: 'observed', document: input.theme.document, appearance: input.theme.appearance } : {})
  root.render(<ScreenshotSourceView input={input} api={sources} />)
}).catch(error => { root.render(<main className="screenshot-editor-startup" role="alert">{String(error)}</main>) })
else void api.load().then(input => {
  mountThemeRuntime(window, input.theme.status === 'available'
    ? { kind: 'observed', document: input.theme.document, appearance: input.theme.appearance } : {})
  root.render(<SystemScreenshotEditorView input={input} api={api} />)
}).catch(error => {
  mountThemeRuntime(window)
  root.render(<main className="screenshot-editor-startup" role="alert"><strong>Screenshot editor could not open</strong><p>{error instanceof Error ? error.message : String(error)}</p><p>Close this window and start another capture.</p></main>)
})
