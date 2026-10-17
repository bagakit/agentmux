import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'

// The real Settings composition in a private visual document. Config facts are local preview
// data; durable Main and actual CLI behavior are proved by the adjacent owning tests.
const config = await api.config.get()
useAppStore.setState({ config: { ...config, browser: { ...config.browser } }, loading: false })
mountThemeRuntime(window, { ...config.appearance, appAppearance: 'dark' })
const saves: unknown[] = []
api.config.save = async (next, expected) => { saves.push({ next, expected }); useAppStore.setState({ config: next }) }
flushSync(() => createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><SettingsPanel initialSection="browser-agent-control" onClose={() => {}} /></DesktopClientUiProvider>))
Object.assign(window, { browserUseVisual: { saves, appearance: (mode: 'dark' | 'light') => updateThemeSelection({ ...config.appearance, appAppearance: mode }) } })
