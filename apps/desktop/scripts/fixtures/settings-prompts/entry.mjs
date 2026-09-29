import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import '../../../src/renderer/src/styles/index.css'
import { SHORTCUT_BINDINGS, chordForPlatform } from '../../../src/renderer/src/lib/shortcut-registry'
import { formatChord } from '../../../src/renderer/src/lib/shortcut-cheat-sheet'
import { isMacPlatform } from '../../../src/renderer/src/lib/host-platform'
import { TERMINAL_THEME_CATALOG } from '../../../src/renderer/src/lib/terminal-theme'
import { TERMINAL_FONT_SIZE_DEFAULT } from '../../../src/shared/contracts'

// Private transport seam only: the actual App and ConfigOwner/ConfigStore own
// rendering and persistence. No user config or Runtime is connected.
const bridge = window.settingsProof
api.config.get = () => bridge.get()
api.config.save = (next, expected) => bridge.save(next, expected)
api.config.onChange = (listener) => bridge.onChange(listener)
await useAppStore.getState().initialize()
createRoot(document.getElementById('root')).render(createElement(App))
const keys = ['tabs', 'layouts', 'sessions', 'activeWorkspaceId', 'agentComposerDrafts', 'agentSteerQueues', 'agentSteerInFlight']
let before
window.promptsProbe = {
  ready: true,
  shortcuts: () => ({ isMac: isMacPlatform(), bindings: SHORTCUT_BINDINGS.map(binding => ({ ...binding, keys: formatChord(chordForPlatform(binding, isMacPlatform()), isMacPlatform()) })) }),
  palettes: () => TERMINAL_THEME_CATALOG.map(({ id, label, description }) => ({ id, label, description })),
  appearanceFontDefault: TERMINAL_FONT_SIZE_DEFAULT,
  config: () => bridge.get(),
  theme: async (mode) => {
    const current = await api.config.get()
    return api.config.save({ ...current, appearance: { ...current.appearance, appAppearance: mode } }, current)
  },
  beginSurface: () => { before = Object.fromEntries(keys.map(key => [key, useAppStore.getState()[key]])); return JSON.stringify(before) },
  surface: () => ({ exact: JSON.stringify(before) === JSON.stringify(Object.fromEntries(keys.map(key => [key, useAppStore.getState()[key]]))),
    references: keys.map(key => ({ key, same: before[key] === useAppStore.getState()[key] })) })
}
