import '../settings-search-refinement/entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'

// Configure only owned preview data via its real config owner, then consume actual publication.
api.config.onChange(config => useAppStore.setState({ config }))
const current = await api.config.get()
await api.config.save({ ...current, browser: { ...current.browser, appLinkSchemes: { 'tool-a': 'allow', 'tool-b': 'deny' } },
  composerShortcuts: [{ id: 'read', keyword: 'read', label: 'Read', body: 'Read the selected text.' }] }, current)
Object.assign(window, { __settingsIntroduction: { ready: true,
  browserSaved: () => useAppStore.getState().config?.browser.agentAutomation === true } })
