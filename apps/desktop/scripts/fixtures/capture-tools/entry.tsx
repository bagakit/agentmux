import '../../../src/renderer/screenshot-editor/entry'
import { updateObservedTheme } from '@agentmux/client-ui/theme'
const api = (window as any).captureSurface ?? (window as any).screenshotEditor
void api.load().then((input: any) => { if (input.theme.status === 'available') (window as any).setFixtureTheme = (value: 'dark' | 'light') => updateObservedTheme(input.theme.document, value, window) })
