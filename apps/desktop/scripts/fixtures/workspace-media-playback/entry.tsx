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
const mainOf = (region: Element | null) => region?.querySelector<HTMLMediaElement>('.media-player__stage > video, .media-player audio') ?? null
const decoderOf = (region: Element | null) => region?.querySelector<HTMLVideoElement>('.media-player__preview video') ?? null

/**
 * What the driver cannot see from outside: seeks in flight on the main element and on each preview decoder (seeking
 * events not yet answered by seeked), the media time each element last presented, announcements, waiting events and
 * long tasks. Counted from the elements' own events, never from the player's internals.
 */
const watched = {
  path: '', decoder: null as HTMLVideoElement | null, decoders: 0,
  preview: { seeking: 0, seeked: 0, maxInFlight: 0, presented: [] as { mediaTime: number; at: number }[], seeks: [] as { at: number; ms: number | null }[] },
  main: { element: null as HTMLMediaElement | null, seeking: 0, seeked: 0, maxInFlight: 0, waiting: 0, presented: null as { mediaTime: number; at: number } | null },
  said: '', announcements: [] as { text: string; at: number }[], longTasks: [] as number[], crossings: [] as { over: number; out: number | null }[],
  lastMove: null as { at: number; x: number } | null
}
// Each element is followed once; its listeners count only while it is the watched one.
const following = new WeakSet<HTMLMediaElement>()
function follow(element: HTMLMediaElement, role: 'main' | 'preview') {
  if (following.has(element)) return
  following.add(element)
  const counts = () => role === 'main' ? watched.main.element === element ? watched.main : null : watched.decoder === element ? watched.preview : null
  element.addEventListener('seeking', () => { const c = counts(); if (c) { c.seeking++; c.maxInFlight = Math.max(c.maxInFlight, c.seeking - c.seeked); if (c === watched.preview) c.seeks.push({ at: performance.now(), ms: null }) } })
  element.addEventListener('seeked', () => { const c = counts(); if (c) { c.seeked++; const last = c === watched.preview ? c.seeks.at(-1) : null; if (last && last.ms === null) last.ms = Math.round(performance.now() - last.at) } })
  if (role === 'main') element.addEventListener('waiting', () => { if (counts()) watched.main.waiting++ })
  if (element instanceof HTMLVideoElement) {
    const presented: VideoFrameRequestCallback = (now, meta) => {
      if (counts()) { if (role === 'main') watched.main.presented = { mediaTime: meta.mediaTime, at: now }; else watched.preview.presented.push({ mediaTime: meta.mediaTime, at: now }) }
      if (element.isConnected) element.requestVideoFrameCallback(presented)
    }
    element.requestVideoFrameCallback(presented)
  }
}
function sync() {
  if (!watched.path) return
  const region = regionOf(watched.path), main = mainOf(region), decoder = decoderOf(region)
  if (main && main !== watched.main.element) { watched.main.element = main; Object.assign(watched.main, { seeking: 0, seeked: 0, maxInFlight: 0 }); follow(main, 'main') }
  // The in-flight peak survives a new decoder element, so a switch cannot hide two seeks in flight.
  if (decoder && decoder !== watched.decoder) { watched.decoder = decoder; watched.decoders++; Object.assign(watched.preview, { seeking: 0, seeked: 0 }); follow(decoder, 'preview') }
  const said = region?.querySelector('.media-player__announcer')?.textContent ?? ''
  if (said !== watched.said) { watched.said = said; if (said) watched.announcements.push({ text: said, at: performance.now() }) }
}
new PerformanceObserver(list => { for (const entry of list.getEntries()) watched.longTasks.push(Math.round(entry.duration)) }).observe({ type: 'longtask', buffered: false })
// How long the pointer stayed on a timeline, from the page's own boundary events.
const onTimeline = (event: Event) => event.target instanceof Element && event.target.classList.contains('media-player__slider')
document.addEventListener('pointerover', event => { if (onTimeline(event)) watched.crossings.push({ over: event.timeStamp, out: null }) }, true)
document.addEventListener('pointerout', event => { const last = watched.crossings.at(-1); if (onTimeline(event) && last && last.out === null) last.out = event.timeStamp }, true)
// When the page handled the latest move on a timeline: a move delivered late still counts from when it arrived.
document.addEventListener('pointermove', event => { if (onTimeline(event)) watched.lastMove = { at: performance.now(), x: (event as PointerEvent).clientX } }, true)
new MutationObserver(sync).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['src', 'data-frame'] })
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
  /** The played-progress colour the timeline actually paints, resolved by the engine for the current theme. */
  timelineFill(path: string) {
    const slider = regionOf(path)?.querySelector<HTMLElement>('.media-player__slider')
    if (!slider) return null
    // An input renders no children, so the probe sits beside it, under the same player variables.
    const probe = document.createElement('span'); probe.style.color = 'var(--media-fill-color)'; slider.parentElement!.append(probe)
    const color = getComputedStyle(probe).color; probe.remove()
    return color
  },
  /** Put keyboard focus on the player itself, as tabbing to it does; the driver then sends real key input. */
  focusPlayer(path: string) { regionOf(path)?.querySelector<HTMLElement>('.media-player')?.focus() },
  indicator(path: string) {
    const element = regionOf(path)?.querySelector<HTMLElement>('.media-player__indicator')
    return element ? { text: element.textContent, opacity: getComputedStyle(element).opacity } : null
  },
  hover(path: string, fraction: number) {
    const slider = regionOf(path)?.querySelector<HTMLInputElement>('.media-player__slider')
    if (!slider) return false
    const box = slider.getBoundingClientRect()
    slider.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: box.left + box.width * fraction, clientY: box.top + box.height / 2 }))
    return true
  },
  /** Ends a pointing made by hover(): the pointer leaves the timeline for the picture above it. */
  unhover(path: string) {
    const region = regionOf(path), slider = region?.querySelector('.media-player__slider')
    slider?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: region!.querySelector('.media-player__stage') }))
  },
  /** Follow this File's player from now on, with fresh counts. */
  watch(path: string) {
    Object.assign(watched, { path, decoder: null, decoders: 0, said: '', announcements: [], longTasks: [], crossings: [] })
    Object.assign(watched.preview, { seeking: 0, seeked: 0, maxInFlight: 0, presented: [], seeks: [] })
    Object.assign(watched.main, { element: null, seeking: 0, seeked: 0, maxInFlight: 0, waiting: 0, presented: null })
    sync()
  },
  /** Starts a new measurement of seeks in flight, waiting events and long tasks. */
  resetPeaks() {
    for (const counts of [watched.preview, watched.main]) counts.maxInFlight = counts.seeking - counts.seeked
    watched.preview.seeks = []; watched.main.waiting = 0; watched.longTasks = []; watched.announcements = []; watched.crossings = []; watched.lastMove = null
  },
  /** Blocks the page for ms in a task of its own: a long task the observer has to record. */
  busy(ms: number) { setTimeout(() => { for (const end = performance.now() + ms; performance.now() < end;); }) },
  watchState() {
    const { seeking, seeked, maxInFlight, waiting, presented } = watched.main
    return { decoders: watched.decoders, preview: { ...watched.preview, presented: watched.preview.presented.slice(-40), seeks: watched.preview.seeks.slice(-40) },
      main: { seeking, seeked, maxInFlight, waiting, presented }, announcements: watched.announcements, longTasks: watched.longTasks, crossings: watched.crossings, lastMove: watched.lastMove }
  },
  /** The timeline's box and thumb in window px, the span it maps over, and the stage the preview stays inside. */
  timeline(path: string) {
    const region = regionOf(path)!, slider = region.querySelector<HTMLInputElement>('.media-player__slider')!, media = mainOf(region)!
    const box = slider.getBoundingClientRect(), lane = slider.parentElement!.getBoundingClientRect(), stage = region.querySelector('.media-player__stage')!.getBoundingClientRect()
    return { left: box.left, top: box.top, width: box.width, height: box.height, y: box.top + box.height / 2, value: Number(slider.value),
      thumb: Number.parseFloat(getComputedStyle(slider).getPropertyValue('--media-thumb')) || 0, start: 0, end: media.duration,
      inset: Number.parseFloat(getComputedStyle(slider).getPropertyValue('--sp-2')),
      stage: { left: stage.left, top: stage.top, right: stage.right, bottom: stage.bottom, width: stage.width, height: stage.height }, room: lane.top - stage.top }
  },
  /** The pointed time, its frame and the preview decoder, as the screen and the decoder itself report them. */
  preview(path: string) {
    const region = regionOf(path), unit = region?.querySelector<HTMLElement>('.media-player__preview'), decoder = decoderOf(region)
    const box = unit?.getBoundingClientRect(), frame = unit?.hasAttribute('data-frame') ? unit.querySelector('.media-player__preview-frame')!.getBoundingClientRect() : null
    return { unit: Boolean(unit), idle: unit?.hasAttribute('data-idle') ?? false, frame: Boolean(frame), bubble: unit?.querySelector('.media-player__bubble')?.textContent ?? null,
      box: box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom, centre: box.left + box.width / 2 } : null,
      frameBox: frame ? { left: frame.left, right: frame.right, top: frame.top, width: frame.width, height: frame.height } : null,
      decoder: decoder ? { index: watched.decoder === decoder ? watched.decoders : -1, src: decoder.getAttribute('src'), muted: decoder.muted, preload: decoder.getAttribute('preload'),
        tabIndex: decoder.tabIndex, crossOrigin: decoder.getAttribute('crossorigin'), hidden: decoder.closest('[aria-hidden="true"]') !== null,
        pictureInPicture: decoder.disablePictureInPicture, remotePlayback: decoder.disableRemotePlayback,
        currentTime: decoder.currentTime, seeking: decoder.seeking, readyState: decoder.readyState, networkState: decoder.networkState } : null,
      controls: region?.querySelector<HTMLElement>('.media-player')?.dataset.controls ?? null }
  },
  /** The main element's official position and play state, and what the player draws over it. */
  main(path: string) {
    const region = regionOf(path), media = mainOf(region)!
    return { currentTime: media.currentTime, seeking: media.seeking, readyState: media.readyState, paused: media.paused, ended: media.ended,
      disc: Boolean(region?.querySelector('.media-player__start')), playLabel: region?.querySelector('.media-player__bar button')?.getAttribute('aria-label') ?? null }
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
