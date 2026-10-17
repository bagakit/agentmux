import { fixturePath as _batchFixturePath } from "../../../../../test/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import type { AgentMuxBrowserTarget } from '@agentmux/core'
import { performanceAttributionSnapshots } from '../performance-panel/data'
import '../../../src/renderer/src/styles/index.css'

// Actual Settings composition, with controlled protocol data for presentation only.
// This document never creates/releases a Browser or measures this machine's memory.
const config = await api.config.get()
config.workspaces = [{ id: 'product', hostId: 'local', name: 'Product', path: _batchFixturePath("private-fixture"), kind: 'folder' }]
config.browser.appLinkSchemes = {}
const page = (id: string, title: string, state: 'live' | 'released' | 'cold' | 'unknown', pid: number | null, reason?: 'visible' | 'operation'): AgentMuxBrowserTarget => ({
  id, source: 'embedded', mode: 'normal', workspaceId: 'product', status: state === 'live' ? 'ready' : 'unavailable',
  title, url: `https://${id}.example.invalid/`, capabilities: [], ...(state === 'live' ? { navigationId: 'original-' + id } : {}),
  resource: { state, locations: [{ workspaceId: 'product', tabId: 'tab-' + id, regionId: 'region-' + id }],
    processes: pid === null ? null : state !== 'live' ? [] : [{ pid, creationTime: 100 }],
    ...(state === 'live' ? { retention: { status: reason ? 'retained' : 'eligible', reasons: reason ? [reason] : [] } } : {}) }
})
const targets = [page('documentation', 'Developer documentation', 'live', 77),
  page('design-notes', 'Design notes — Browser collaboration', 'live', 78, 'visible'),
  page('report', 'Background research report', 'live', 78, 'operation'),
  page('archive', 'Reference archive', 'released', null), page('unconfirmed', 'Earlier page observation', 'unknown', null)]
const snapshot = structuredClone(performanceAttributionSnapshots.fresh)
snapshot.observation!.app.data!.processes = [
  { pid: 77, creationTime: 100, role: 'browser', type: 'Tab', cpuPercent: 1.2, intervalMs: 1000, rssKib: 380928 },
  { pid: 78, creationTime: 100, role: 'browser', type: 'Tab', cpuPercent: 0.4, intervalMs: 1000, rssKib: 192512 }
]
Object.assign(snapshot.observation!.app.data!, { processCount: 2, cpuPercent: 1.6, rssKib: 573440, omittedProcesses: 0,
  groups: [{ role: 'browser', processCount: 2, cpuPercent: 1.6, rssKib: 573440 }] })
let changed: (() => void) | undefined, partial = false
api.browser.listTargets = async () => ({ targets: partial ? targets.slice(0, 4) : targets, coverage: partial ? 'partial' : 'complete',
  ...(partial ? { warning: 'One earlier page was not observed in this query.' } : {}) })
api.browser.onTargetsChanged = listener => { changed = listener; return () => { changed = undefined } }
api.browser.listRetainedUploads = async () => ({ selections: [] })
api.toolkit.observe = (_tool, onSnapshot) => { queueMicrotask(() => onSnapshot(snapshot)); return { dispose() {} } }
api.config.save = async next => { useAppStore.setState({ config: next }) }
const actions: string[] = []
api.browser.release = async (id, navigationId) => { actions.push(id); return { browserId: id, navigationId, status: 'retained', reasons: ['visible'] } }
api.browser.restoreResource = async () => { throw new Error('Native resource lifecycle is not part of this presentation fixture') }
useAppStore.setState({ config, loading: false })
mountThemeRuntime(window, { ...config.appearance, appAppearance: 'dark' })
flushSync(() => createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><SettingsPanel initialSection="browser" onClose={() => {}} /></DesktopClientUiProvider>))
Object.assign(window, { resourceSettingsVisual: { ready: true, actions, markPrevious: () => { partial = true; changed?.() } } })
