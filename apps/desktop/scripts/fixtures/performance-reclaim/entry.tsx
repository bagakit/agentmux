import { useMemo, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import type { AgentMuxBrowserTarget } from '@agentmux/core'
import { parseRendererCacheResult, type RendererCacheInput, type RendererCacheResult, type RendererCacheSnapshot } from '@agentmux/core/control'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { PerformanceOverview } from '../../../src/renderer/src/components/performance/PerformanceOverview'
import { ToolkitPopoverSurface } from '../../../src/renderer/src/components/performance/PerformancePopover'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { performanceAttributionSnapshots } from '../performance-panel/data'
import { fixturePath } from '../../lib/fixture-values.mjs'
import '../../../src/renderer/src/styles/index.css'

// Controlled typed protocol inputs exercise original presentation only. No native
// cache reclamation, Browser close, Run lifecycle or machine measurement is done.
const config = await api.config.get()
config.workspaces = [{ id: 'product', hostId: 'local', name: 'Product', path: fixturePath('reclaim/workspace'), kind: 'folder' }]
const page = (id: string, title: string, state: 'live' | 'released' | 'unknown', pid: number | null,
  reason?: 'visible' | 'operation'): AgentMuxBrowserTarget => ({
  id, source: 'embedded', mode: 'normal', workspaceId: 'product', status: state === 'live' ? 'ready' : 'unavailable',
  title, url: `https://${id}.example.invalid/`, capabilities: [], ...(state === 'live' ? { navigationId: 'document-' + id } : {}),
  resource: { state, locations: [{ workspaceId: 'product', tabId: 'tab-' + id, regionId: 'region-' + id }],
    processes: pid === null ? null : [{ pid, creationTime: 100 }],
    ...(state === 'live' ? { retention: { status: reason ? 'retained' : 'eligible', reasons: reason ? [reason] : [] } } : {}) }
})
const targets = [page('documentation', 'Developer documentation', 'live', 77),
  page('research', 'Background research report', 'live', 79),
  page('design', 'Design notes — Browser collaboration', 'live', 78, 'visible'),
  page('upload', 'Reference upload in progress', 'live', 78, 'operation'),
  page('archive', 'Reference archive', 'released', null),
  page('unconfirmed', 'Earlier page observation', 'unknown', null)]
const snapshot = structuredClone(performanceAttributionSnapshots.fresh)
snapshot.observation!.app.data!.processes.push(
  { pid: 77, creationTime: 100, role: 'browser', type: 'Tab', cpuPercent: 1.2, intervalMs: 1000, rssKib: 380928 },
  { pid: 78, creationTime: 100, role: 'browser', type: 'Tab', cpuPercent: 0.4, intervalMs: 1000, rssKib: 192512 },
  { pid: 79, creationTime: 100, role: 'browser', type: 'Tab', cpuPercent: 0.1, intervalMs: 1000, rssKib: 131072 })
let changed: (() => void) | undefined, partial = false, directoryReaders = 0
const actions: Array<{ kind: string; id?: string; navigationId?: string }> = []
api.browser.listTargets = async () => ({ targets: partial ? targets.slice(0, 5) : targets,
  coverage: partial ? 'partial' : 'complete', ...(partial ? { warning: 'One earlier page was not observed in this query.' } : {}) })
api.browser.onTargetsChanged = listener => { changed = listener; directoryReaders++; return () => { changed = undefined; directoryReaders-- } }
api.browser.release = async (id, navigationId) => {
  actions.push({ kind: 'browser-release', id, navigationId })
  return { browserId: id, navigationId, status: id === 'documentation' ? 'unknown' : 'released', reasons: [] }
}
api.browser.restoreResource = async () => { throw Error('Native Browser restoration is outside this visual fixture') }
api.toolkit.observe = () => { throw Error('Performance must consume its provided snapshot, not start another observer') }
const sampledAt = snapshot.observation!.observedAt
const usage = (sizeBytes: number): RendererCacheSnapshot => ({ sampledAt,
  usage: { images: { count: 12, sizeBytes, decodedBytes: Math.floor(sizeBytes / 2) }, scripts: { count: 8, sizeBytes: 2097152, decodedBytes: 0 },
    cssStyleSheets: { count: 3, sizeBytes: 524288, decodedBytes: 0 }, xslStyleSheets: { count: 0, sizeBytes: 0, decodedBytes: 0 },
    fonts: { count: 2, sizeBytes: 1048576, decodedBytes: 524288 }, other: { count: 1, sizeBytes: 262144, decodedBytes: 0 } } })
let cacheUnknown = false
function cacheReceipt(input: RendererCacheInput, action: 'inspect' | 'reclaim'): RendererCacheResult {
  actions.push({ kind: 'cache-' + action })
  const unknown = action === 'reclaim' && cacheUnknown
  return parseRendererCacheResult({ ...input, schema: 'agentmux.renderer-cache.v1', scope: 'renderer-process-platform-cache', units: 'bytes',
    action, status: unknown ? 'unknown' : 'completed', timing: { requestedAt: sampledAt, finishedAt: sampledAt + 1 },
    sourceVerified: { before: true, after: !unknown }, clear: { requested: action === 'reclaim', completed: action === 'reclaim' },
    before: usage(25165824), after: action === 'inspect' || unknown ? null : usage(1048576),
    issues: unknown ? [{ stage: 'after', code: 'CONTROL_OWNER_LOST', message: 'Native cleanup returned; the final observation could not confirm this original Renderer. No automatic retry was made.', messageTruncated: false }] : [] }, input, action)
}
api.performance.inspectCache = async input => cacheReceipt(input, 'inspect')
api.performance.reclaimCache = async input => cacheReceipt(input, 'reclaim')
useAppStore.setState({ config, loading: false })
mountThemeRuntime(window, { ...config.appearance, appAppearance: 'dark' })
function Surface() {
  const panel = useRef<HTMLDivElement>(null)
  const surface = useMemo(() => ({ panel, setResizable() {} }), [])
  return <DesktopClientUiProvider><ToolkitPopoverSurface.Provider value={surface}>
    <div ref={panel} className="performance-popover reclaim-review-surface" role="dialog" aria-label="Performance">
      <PerformanceOverview snapshot={snapshot} close={() => {}} onPause={() => {}} onConfigure={() => {}} onViewScript={() => {}} />
    </div>
  </ToolkitPopoverSurface.Provider></DesktopClientUiProvider>
}
flushSync(() => createRoot(document.getElementById('root')!).render(<Surface />))
Object.assign(window, { reclaimVisual: { ready: true, actions, facts: () => ({ directoryReaders, actions }),
  theme: (appAppearance: 'light' | 'dark') => updateThemeSelection({ ...config.appearance, appAppearance }),
  markPrevious: () => { partial = true; changed?.() }, unknownCache: () => { cacheUnknown = true } } })
