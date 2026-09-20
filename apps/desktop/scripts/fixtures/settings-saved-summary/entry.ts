import '../settings-search-refinement/entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'

// Keep the original SettingsPanel/SurfaceSwitch/CSS fixture. Only connect its actual preview
// configuration publication so Save can update the same saved props it does in the product.
api.config.onChange(config => useAppStore.setState({ config }))
Object.assign(window, { __settingsSavedSummary: {
  saved: () => ({ copy: useAppStore.getState().config?.copyPathsAsAbsolute === true,
    browser: useAppStore.getState().config?.browser.agentAutomation === true })
} })
