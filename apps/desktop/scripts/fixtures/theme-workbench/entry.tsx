import { fixturePath as _reshape_fixturePath } from "../../../../../test/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { GRAPHITE_THEME, themeValue } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'

// Actual App/Settings/Store/CSS and preview API. No installed App, live Run or user configuration.
const originalGet = api.config.get, originalSave = api.config.save, originalOnChange = api.config.onChange
const usesOwner = new URLSearchParams(location.search).get('owner') === '1'
const configListeners = new Set<Parameters<typeof api.config.onChange>[0]>()
if (usesOwner) {
  api.config.get = async () => (await fetch('/proof-config')).json()
  api.config.save = async (next, expected) => {
    const response = await fetch('/proof-config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ next, expected }) })
    const value = await response.json()
    if (!response.ok) throw new Error(value.error)
    for (const listener of configListeners) listener(value)
    return value
  }
  api.config.onChange = listener => { configListeners.add(listener); return () => configListeners.delete(listener) }
} else {
  const custom = structuredClone(GRAPHITE_THEME)
  custom.id = 'custom.owner-proof'; custom.name = 'Owner proof'; custom.description = 'Private candidate to prove settings and runtime consumption.'
  custom.variants.dark.colors.surface0 = '#20354a'; custom.variants.light.colors.surface0 = '#faeed1'
  const original = await originalGet()
  await originalSave({ ...original, workspaces: original.workspaces.map((workspace, index) => ({ ...workspace, path: _reshape_fixturePath(`private/tmp/theme-owner-workspace-${index}`) })),
    appearance: { ...original.appearance, customThemes: { [custom.id]: themeValue(custom) } } }, original)
}
const errors: string[] = []
window.addEventListener('error', event => errors.push(event.message))
createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><App /></DesktopClientUiProvider>)
Object.assign(window, { themeProof: {
  facts() { return { errors, loading:useAppStore.getState().loading, config: useAppStore.getState().config?.appearance, theme: document.documentElement.dataset.theme,
    mode: document.documentElement.dataset.appearance, surface0: document.documentElement.style.getPropertyValue('--surface-0') } }
} })
