import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { BrowserPane } from '../../../src/renderer/src/components/BrowserPane'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import type { WorkbenchBrowserPresentation } from '../../../src/renderer/src/components/BrowserPresentationStage'
import type { BrowserPresentationEvent, BrowserSnapshot } from '../../../src/shared/contracts'
import type { BrowserOperation } from '../../../src/shared/browser-operation'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import '../../../src/renderer/src/styles/index.css'

type Phase = 'waiting' | 'navigation' | 'script' | 'observe' | 'completed' | 'failed' | 'stopped' | 'human'
const browserId = 'continuity-page', regionId = 'continuity-region', tabId = 'continuity-tab', workspaceId = 'continuity-workspace'
const operationId = 'continuity-operation', captureId = 'continuity-capture'
const root = createRoot(document.getElementById('root')!), errors: string[] = [], calls: unknown[] = []
const listeners = new Set<(event: BrowserPresentationEvent) => void>()
const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540
const context = canvas.getContext('2d')!
const stream = canvas.captureStream(12)
let acquisitions = 0, sourceFrames = 0, frameTimer: ReturnType<typeof setInterval> | undefined
let base: BrowserSnapshot, appearance: any, stopTheme: (() => void) | undefined
let stopEvents: (() => void) | undefined
const phaseMarkers: Record<Phase, [number, number, number]> = { waiting: [30, 70, 130], navigation: [210, 90, 30], script: [150, 45, 160],
  observe: [30, 155, 170], completed: [40, 145, 55], failed: [185, 50, 50], stopped: [135, 125, 25], human: [155, 100, 45] }
let sourcePhase: Phase = 'waiting'
let currentBrowser: BrowserSnapshot
function paint(phase: Phase) {
  sourcePhase = phase
  context.fillStyle = '#f2f0e9'; context.fillRect(0, 0, 960, 540)
  context.fillStyle = '#223d50'; context.fillRect(0, 0, 960, 92)
  context.fillStyle = '#ffffff'; context.font = 'bold 30px system-ui'; context.fillText('Field notes', 42, 57)
  context.fillStyle = '#263b45'; context.font = 'bold 37px system-ui'; context.fillText('One original page. Two views.', 42, 167)
  context.font = '21px system-ui'; context.fillText('Canvas fixture feed · actual shared MediaStream playback', 42, 210)
  for (let index = 0; index < 3; index++) {
    context.fillStyle = ['#e0e8e6', '#e6dfce', '#dedfe6'][index]!; context.fillRect(42 + index * 299, 260, 277, 164)
    context.fillStyle = '#263b45'; context.font = 'bold 24px system-ui'; context.fillText(['Read', 'Compare', 'Continue'][index]!, 61 + index * 299, 305)
    context.font = '17px system-ui'; context.fillText('Original content stays readable', 61 + index * 299, 343)
  }
  context.fillStyle = '#465a66'; context.font = '19px system-ui'; context.fillText('Declared fixture phase: ' + phase, 42, 486)
  context.fillStyle = `rgb(${phaseMarkers[phase].join(',')})`; context.fillRect(930, 14, 16, 16)
  stream.getVideoTracks().forEach(track => (track as CanvasCaptureMediaStreamTrack).requestFrame())
}
Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => { acquisitions++; return stream } })
api.browser.registerPresentation = async request => { calls.push({ method: 'register', request }); return { leaseId: request.occurrence.presentationId + '-lease' } }
api.browser.updatePresentation = async (leaseId, geometry) => { calls.push({ method: 'geometry', leaseId, geometry }) }
api.browser.removePresentation = async leaseId => { calls.push({ method: 'remove', leaseId }) }
api.browser.armPresentationCapture = async leaseId => { calls.push({ method: 'arm', leaseId }); return { browserId, captureId } }
api.browser.ackPresentationCapture = async (id, ack) => { calls.push({ method: 'ack', captureId: id, ack }) }
api.browser.activatePresentation = async (leaseId, intent) => { calls.push({ method: 'select', leaseId, intent }); return { outcome: 'selected' } }
api.browser.onPresentationEvent = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
api.browser.takeControl = async id => { calls.push({ method: 'takeControl', browserId: id }); return phase('human') }
api.browser.returnControl = async id => { calls.push({ method: 'returnControl', browserId: id }); return phase('stopped') }
const reference = { displayWorkspaceId: workspaceId, groupId: 'continuity-group', tabId, regionId }
const presentations: WorkbenchBrowserPresentation[] = (['space', 'survey'] as const).map(surface => ({
  occurrence: { presentationId: surface + '-continuity', location: reference }, stageHostId: surface + '-continuity-slot',
  visible: true, active: surface === 'space', yieldToFocusRing: false,
  target: { hostId: surface + '-continuity-host', surface, active: surface === 'space', visible: true, reference,
    projection: { entity: { kind: 'region', regionId }, presentationId: surface + '-continuity', displayWorkspaceId: workspaceId,
      catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] }, selection: [reference], onSelect: () => {} } }
}))
function Fixture() {
  const surface = useAppStore(state => state.tabs[tabId]?.regions[regionId])
  return <DesktopClientUiProvider><main className="continuity-renderer">
    <header><strong>Browser control continuity</strong><span>Renderer proof · one simulated page source</span></header>
    <div className="continuity-renderer__layout">
      <article><h2>Original position</h2><section className="continuity-renderer__pane" data-workbench-region-id={regionId}>
        {surface?.kind === 'browser' ? <BrowserPane tab={surface} visible presentations={presentations} presentationTargetId="space-continuity-host"
          renderPresentationFrame={content => <section className="continuity-renderer__pane" data-workbench-region-id={regionId}>{content}</section>} /> : null}
      </section></article>
      <article><h2>Same page · second position</h2><div className="continuity-renderer__slot" id="survey-continuity-slot" /></article>
    </div>
  </main></DesktopClientUiProvider>
}
const style = document.createElement('style')
style.textContent = `html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}.continuity-renderer{width:100%;height:100%;display:flex;flex-direction:column;color:var(--text-1);background:var(--bg-0)}.continuity-renderer>header{display:flex;justify-content:space-between;gap:12px;padding:15px 18px;font-size:13px;border-bottom:1px solid var(--border)}.continuity-renderer>header span{color:var(--text-3)}.continuity-renderer__layout{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:18px;padding:18px;flex:1;min-height:0}.continuity-renderer article{display:flex;flex-direction:column;min-width:0;min-height:0}.continuity-renderer h2{font-size:12px;color:var(--text-2);font-weight:500;margin:0 0 9px}.continuity-renderer__pane,.continuity-renderer__slot{display:flex;flex:1;min-width:0;min-height:0;overflow:hidden}.continuity-renderer__pane>.browser-surface,.continuity-renderer__pane>.browser-workface-boundary,.continuity-renderer__slot>.retained-workbench-region{width:100%;height:100%}.continuity-renderer__slot .retained-workbench-region,.continuity-renderer__slot .continuity-renderer__pane{height:100%;width:100%}@media(max-width:600px){.continuity-renderer>header{padding:10px 12px}.continuity-renderer>header span{display:none}.continuity-renderer__layout{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr);gap:10px;padding:10px}}`
document.head.append(style)
function facts() {
  const sample = document.createElement('canvas'); sample.width = sample.height = 1
  const sampleContext = sample.getContext('2d', { willReadFrequently: true })!
  return { errors: errors.slice(), acquisitions, sourceFrames, sourcePhase, sourceMarker: phaseMarkers[sourcePhase], viewport: { width: innerWidth, height: innerHeight },
    trackIds: stream.getTracks().map(track => track.id), trackStates: stream.getTracks().map(track => track.readyState),
    calls: calls.slice(), currentBrowser, stages: [...document.querySelectorAll<HTMLElement>('[data-browser-presentation-id]')].map(stage => {
      const video = stage.querySelector('video'), boundary = stage.querySelector<SVGSVGElement>('[data-browser-control-boundary]'), rect = boundary?.querySelector('rect')
      const matrix = rect?.getScreenCTM(), box = stage.getBoundingClientRect(), chrome = stage.closest('.browser-surface')?.querySelector('.browser-operation-status')
      let marker: number[] | null = null
      if (video && video.readyState >= 2 && video.videoWidth === 960 && video.videoHeight === 540 && video.srcObject) {
        sampleContext.drawImage(video, 938, 22, 1, 1, 0, 0, 1, 1); marker = [...sampleContext.getImageData(0, 0, 1, 1).data].slice(0, 3)
      }
      return { id: stage.dataset.browserPresentationId, bounds: { x: box.x, y: box.y, width: box.width, height: box.height },
        video: video ? { width: video.videoWidth, height: video.videoHeight, readyState: video.readyState, paused: video.paused, marker, streamId: (video.srcObject as MediaStream | null)?.id ?? null } : null,
        boundary: boundary ? { viewBox: boundary.getAttribute('viewBox'), opacity: getComputedStyle(boundary).opacity,
          matrix: matrix ? { a: matrix.a, d: matrix.d, e: matrix.e, f: matrix.f } : null } : null,
        chrome: { phase: chrome?.getAttribute('data-phase'), owner: chrome?.getAttribute('data-control'), operation: chrome?.getAttribute('data-operation-id'),
          text: chrome?.textContent, label: chrome?.querySelector('button')?.getAttribute('aria-label') } }
    }) }
}
function phase(phase: Phase): BrowserSnapshot {
    const method = phase === 'navigation' ? 'gotoUrl' : phase === 'script' ? 'js' : 'snapshot'
    const human = phase === 'human'
    const terminal = ['completed', 'failed', 'stopped'].includes(phase)
    const operation: BrowserOperation = { id: operationId, browserId, operator: { id: 'fixture-operator', name: 'Research Agent' },
      startedAt: 1, phase: phase === 'waiting' ? 'waiting' : terminal ? phase as 'completed' | 'failed' | 'stopped' : phase === 'human' ? 'human' : 'running',
      summary: 'Read and compare the original page', url: base.url, steps: [{ sequence: 1, method, label: method, startedAt: 1,
        status: terminal ? phase === 'completed' ? 'completed' : phase === 'failed' ? 'failed' : 'stopped' : 'running' }] }
    const browser: BrowserSnapshot = { ...base, driving: !human && !terminal, loading: phase === 'navigation',
      activity: { operation, control: human ? 'human' : 'agent' },
      control: { owner: human ? 'human' : 'agent', activeOperationId: human || terminal ? null : operationId, revision: 2, inputIsolation: human ? 'inactive' : 'isolated' } }
    useAppStore.getState().applyBrowserEvent({ type: 'updated', browser })
    currentBrowser = browser
    paint(phase)
    return browser
}
Object.assign(window, { continuityRenderer: {
  async setup() {
    const config = await api.config.get(); appearance = config.appearance
    config.browser.agentControl = { ...config.browser.agentControl, glowEnabled: true, glowColor: '#22cc66', glowOpacity: 1 }
    base = await api.browser.create(browserId, 'https://example.invalid/field-notes', workspaceId)
    const surface = { ...base, kind: 'browser' as const, browserId, regionId, workspaceId }
    const tab = createWorkbenchTab(tabId, surface)
    useAppStore.setState({ config, tabs: { [tabId]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('continuity-group', [tabId]) },
      executeControl: async request => { calls.push({ method: 'executeControl', request }); return {} as any },
      mainSurface: 'workbench', loading: false, toolsOpen: false, reportError: error => { errors.push(String(error)) } })
    stopEvents = api.browser.onEvent(event => useAppStore.getState().applyBrowserEvent(event))
    stopTheme = mountThemeRuntime(window, { ...appearance, appAppearance: 'light' })
    root.render(<Fixture />)
    this.phase('waiting')
    // A live fixture source supplies its own new frames when a retained receiver resumes.
    frameTimer = setInterval(() => {
      context.fillStyle = sourceFrames++ % 2 ? '#617a8a' : '#9caab4'; context.fillRect(916, 480, 12, 12)
      stream.getVideoTracks().forEach(track => (track as CanvasCaptureMediaStreamTrack).requestFrame())
    }, 80)
  },
  phase,
  coverage(presentationId: string | null) {
    const event: BrowserPresentationEvent = { type: 'native-coverage-changed', browserId,
      coverage: presentationId ? { leaseId: presentationId + '-lease', captureId } : null }
    for (const listener of listeners) listener(event)
  },
  theme(mode: 'light' | 'dark') { updateThemeSelection({ ...appearance, appAppearance: mode }) },
  facts,
  dispose() { clearInterval(frameTimer); root.unmount(); stopEvents?.(); stopTheme?.(); stream.getTracks().forEach(track => track.stop()); return { listenerCount: listeners.size, trackStates: stream.getTracks().map(track => track.readyState), errors } }
} })
