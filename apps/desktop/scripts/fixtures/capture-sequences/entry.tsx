import { createRoot } from 'react-dom/client'
import { mountThemeRuntime, updateObservedTheme } from '@agentmux/client-ui/theme'
import { CaptureSurfaceView } from '../../../src/renderer/screenshot-editor/CaptureSurfaceView'
import { CaptureSequenceView } from '../../../src/renderer/screenshot-editor/CaptureSequenceView'
import type { CaptureSequenceApi } from '../../../src/shared/capture-sequence'
import '../../../src/renderer/screenshot-editor/screenshot-editor.css'
const surface = (window as any).captureSurface
const api = surface ?? (window as unknown as { captureSequence: CaptureSequenceApi }).captureSequence
void api.load().then(input => {
  mountThemeRuntime(window, input.theme.status === 'available' ? { kind: 'observed', document: input.theme.document, appearance: input.theme.appearance } : {})
  if (input.theme.status === 'available') { const theme = input.theme; (window as any).setCaptureFixtureTheme = (appearance: 'dark' | 'light') => updateObservedTheme(theme.document, appearance, window) }
  createRoot(document.getElementById('root')!).render(surface ? <CaptureSurfaceView input={input} api={surface} /> : <CaptureSequenceView input={input} api={api} />)
})
