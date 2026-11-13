import { createClientUiRoot as createRoot } from '../../../test/helpers/client-ui-render'
import { flushSync } from 'react-dom'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { FileExplorer } from '../../../src/renderer/src/components/FileExplorer'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { addWorkbenchRegion, fileTabId } from '../../../src/renderer/src/lib/workbench-tabs'
import '../../../src/renderer/src/styles/index.css'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'

const boot = (window as any).mediaPlaybackFixtureBoot
// The app shell mounts the semantic icon sprite before any surface renders.
mountThemeRuntime(window, { appAppearance: 'dark' })
if (!boot || !window.agentmux) throw new Error('Private native preload facts are required')
const workspaceId = boot.config.workspaces[0].id
api.files = window.agentmux.files
api.spatial = window.agentmux.spatial
api.config.get = async () => structuredClone(boot.config)
api.config.save = async (config) => structuredClone(config)
api.sessions.snapshot = async () => ({ sessions: [], timelines: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], environmentWarning: null })
await useAppStore.getState().initialize()
useAppStore.setState({ toolsOpen: false })
const restored = useAppStore.getState()
const beforeFixture = boot.phase === 'restart' ? { tabs: structuredClone(restored.tabs), layouts: structuredClone(restored.layouts), activeWorkspaceId: restored.activeWorkspaceId } : null
// A first File gives the Workspace a layout before the workbench mounts, as an opened project has.
if (boot.phase === 'capture') {
  // A fresh profile has no active project; choose it the way a person does before opening files.
  await useAppStore.getState().selectWorkspace(workspaceId)
}
const root = createRoot(document.getElementById('root')!)
function Shell() { return <><aside id="fixture-tree"><FileExplorer /></aside><div id="fixture-workbench"><WorkspaceWorkbench workspaceId={workspaceId} /></div><WindowOverlayHost /></> }
flushSync(() => root.render(<Shell />))
if (boot.phase === 'capture') {
  // The mounted workbench gives the project its first layout; files open into it like a person's click.
  for (let attempt = 0; attempt < 50 && !useAppStore.getState().layouts[workspaceId]; attempt++) await new Promise(resolve => setTimeout(resolve, 100))
  const opened = await useAppStore.getState().openFile('notes.md', undefined, undefined, workspaceId)
  const state = useAppStore.getState(), layout = state.layouts[workspaceId]
  ;(window as any).mediaPlaybackOpen = { opened, hasLayout: Boolean(layout), active: state.activeWorkspaceId, lastError: state.lastError,
    groups: layout?.groups.map(group => ({ id: group.id, tabs: group.tabOrder, active: group.activeTabId })), tabs: Object.keys(state.tabs), surface: state.mainSurface, configWorkspaces: state.config?.workspaces?.map(item => item.id) ?? null, bootWorkspaces: boot.config.workspaces.map((item: { id: string }) => item.id) }
}

function regionOf(path: string): HTMLElement | null {
  const tab = useAppStore.getState().tabs[fileTabId(workspaceId, path)]
  const surface = tab ? Object.values(tab.regions).find(item => item.kind === 'file' && item.path === path) : undefined
  return surface ? document.querySelector(`[data-workbench-region-id="${surface.regionId}"]`) : null
}
const probe = {
  workspaceId, beforeFixture,
  async open(path: string) { await useAppStore.getState().openFile(path, undefined, undefined, workspaceId) },
  theme(theme: 'dark' | 'light') { updateThemeSelection({ appAppearance: theme }) },
  /** Put a second File beside this one so the player sits in a narrow Region. */
  split(path: string, neighbor: string, ratio: number) {
    const state = useAppStore.getState(), tabId = fileTabId(workspaceId, path), tab = state.tabs[tabId]!
    const regionId = tab.layout.activeRegionId
    let next = Object.values(tab.regions).some(surface => surface.regionId !== regionId) ? tab
      : addWorkbenchRegion(tab, regionId, 'right', { regionId: `media-neighbor-${Object.keys(state.tabs).indexOf(tabId)}`, kind: 'file', workspaceId, path: neighbor })
    if (next.layout.root.type === 'split') next = { ...next, layout: { ...next.layout, root: { ...next.layout.root, ratio }, activeRegionId: regionId } }
    flushSync(() => useAppStore.setState({ tabs: { ...state.tabs, [tabId]: next } }))
  },
  player(path: string) {
    const region = regionOf(path), player = region?.querySelector<HTMLElement>('.media-player'), media = player?.querySelector<HTMLMediaElement>('video, audio')
    if (!region || !player || !media) return null
    const box = region.getBoundingClientRect(), seekable = media.seekable
    return { kind: media.tagName.toLowerCase(), src: media.getAttribute('src'), decode: player.dataset.decodeState, stream: player.dataset.stream,
      controls: player.dataset.controls, label: player.getAttribute('aria-label'), readyState: media.readyState, paused: media.paused,
      currentTime: media.currentTime, duration: Number.isFinite(media.duration) ? media.duration : String(media.duration),
      seekable: seekable.length ? [seekable.start(seekable.length - 1), seekable.end(seekable.length - 1)] : null,
      width: (media as HTMLVideoElement).videoWidth ?? 0, region: { width: box.width, height: box.height },
      alert: player.querySelector('[role="alert"]')?.textContent ?? null, live: player.querySelector('.media-player__live')?.getAttribute('aria-label') ?? null,
      text: player.textContent ?? '' }
  },
  async play(path: string) { const media = regionOf(path)?.querySelector<HTMLMediaElement>('video, audio'); media!.muted = true; await media!.play() },
  pause(path: string) { regionOf(path)?.querySelector<HTMLMediaElement>('video, audio')?.pause() },
  seekFraction(path: string, fraction: number) { const media = regionOf(path)!.querySelector<HTMLMediaElement>('video, audio')!; media.currentTime = media.duration * fraction },
  showControls(path: string) { regionOf(path)?.querySelector('.media-player')?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })) },
  hover(path: string, fraction: number) {
    const slider = regionOf(path)?.querySelector<HTMLInputElement>('.media-player__slider')
    if (!slider) return false
    const box = slider.getBoundingClientRect()
    slider.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: box.left + box.width * fraction, clientY: box.top + box.height / 2 }))
    return true
  },
  facts() { const state = useAppStore.getState(); return { tabs: state.tabs, layouts: state.layouts, activeWorkspaceId: state.activeWorkspaceId } },
  /** What quitting the app does: commit the current workface to durable storage. */
  flush() { return prepareRendererUpdate('quit') },
  async layoutDiagnosis() {
    const { workbenchObjectLayout } = await import('../../../src/renderer/src/lib/desktop-focus-navigation')
    const state = useAppStore.getState(), result = workbenchObjectLayout({ ...state, sessions: [] } as never, workspaceId)
    return { hasLayout: Boolean(state.layouts[workspaceId]), tabs: Object.keys(state.tabs), choice: result.choice, confirmed: result.confirmed, issues: result.issues,
      selection: state.workbenchSpaceSelection, zoneBindings: (state as any).spaceZoneBindings?.length ?? null }
  }
}
;(window as any).mediaPlaybackProbe = probe
