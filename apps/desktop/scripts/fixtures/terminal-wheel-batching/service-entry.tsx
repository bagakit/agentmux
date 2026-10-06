import React, { Profiler } from 'react'
import { createRoot } from 'react-dom/client'
await import('./entry')
const { useAppStore, initializeRunServiceProjection } = await import('../../../src/renderer/src/store')
const { DesktopClientUiProvider } = await import('../../../src/renderer/src/components/DesktopClientUiProvider')
const { GlobalSystemNotices } = await import('../../../src/renderer/src/components/GlobalSystemNotices')
const { QuickSwitcher } = await import('../../../src/renderer/src/components/QuickSwitcher')
const { runServiceProjection } = await import('../../../src/renderer/src/lib/run-service-projection')

const w = window as any
const releaseProjection = initializeRunServiceProjection()
const chrome = createRoot(document.getElementById('service-chrome')!)
let collectionChanges = 0, chromeCommits = 0
const releaseStore = useAppStore.subscribe((state, previous) => {
  if (state.sessions !== previous.sessions) collectionChanges++
})
const releaseEvents = w.agentmux.sessions.onEvent((event: any) => useAppStore.getState().applyEvent(event))
const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
let serviceRevision = 100000
w.serviceWheelRevisions = []
window.addEventListener('wheel', () => {
  w.serviceWheelRevisions.push(serviceRevision)
  const resume = w.serviceWheelContinue
  if (resume) { w.serviceWheelContinue = null; resume() }
}, true)
function emit(service: any) {
  const session = useAppStore.getState().sessions[0]!
  useAppStore.getState().applyEvent({ type: 'core', hostId: session.hostId, event: {
    type: 'run-service', agentSessionId: session.control.kind === 'agent' ? session.control.agentSessionId : undefined,
    run: session.control.run, nativeService: service,
    evidence: { source: 'run-process', run: session.control.run, observedAt: Date.now() }
  } })
}
function healthy(): any {
  return { revision: ++serviceRevision, owner: { type: 'serving' }, output: { type: 'serving' }, input: {
    phase: { type: 'open' }, unsettledCommands: 0, unsettledRequestBytes: 0,
    writeBlocked: false, completedInputBytes: serviceRevision, currentSize: { cols: 180, rows: 24 }, activeConfirmedBytes: 0
  }, terminalFault: null }
}
w.servicePopulation = async (population: number) => {
  const original = useAppStore.getState().sessions[0]!
  useAppStore.setState({ loading: false, sessions: [original, ...Array.from({ length: population }, (_, i) => ({
    ...original, id: 'private-unrelated-' + i, label: 'Unrelated ' + i,
    control: { kind: 'agent' as const, hostId: 'local', agentSessionId: 'private-unrelated-' + i, run: { runId: 'unrelated-run-' + i } }
  }))] })
  chrome.render(<DesktopClientUiProvider><Profiler id="actual-unrelated-chrome" onRender={() => chromeCommits++}>
    <GlobalSystemNotices /><QuickSwitcher open={false} onClose={() => {}} />
  </Profiler></DesktopClientUiProvider>)
  emit(healthy())
  await frame()
  return { collectionChanges, chromeCommits, sessions: useAppStore.getState().sessions.length }
}
w.serviceProgress = async (count: number, interleaveFirstWheel = false) => {
  const collection = useAppStore.getState().sessions, changes = collectionChanges, commits = chromeCommits, start = performance.now()
  // Each task mirrors a delivered Core event. It does not hide work inside one React batch.
  const channel = new MessageChannel()
  await new Promise<void>(resolve => {
    let remaining = count
    channel.port1.onmessage = () => {
      emit(healthy())
      if (!--remaining) resolve()
      else if (interleaveFirstWheel && remaining === count - 1) {
        // A finite event latch binds the actual trusted wheel between progress deliveries.
        // Avoid relying on CDP beating a free-running producer to the Renderer task queue.
        w.serviceWheelContinue = () => channel.port2.postMessage(0)
      } else channel.port2.postMessage(0)
    }
    channel.port2.postMessage(0)
  })
  channel.port1.close(); channel.port2.close()
  await frame()
  return { count, elapsedMs: performance.now() - start, sameCollection: collection === useAppStore.getState().sessions,
    collectionChanges: collectionChanges - changes, chromeCommits: chromeCommits - commits,
    latestRevision: runServiceProjection.read(useAppStore.getState().sessions[0]!)?.revision, expectedRevision: serviceRevision }
}
w.serviceFault = async (kind: 'pressure' | 'input' | 'recover') => {
  const service = healthy()
  if (kind === 'pressure') service.output = { type: 'backpressured' }
  if (kind === 'input') service.input.phase = { type: 'unavailable', reason: 'write_failed' }
  emit(service)
  await frame()
  return { body: document.body.textContent, revision: service.revision }
}
w.serviceCleanup = () => { releaseEvents(); releaseStore(); releaseProjection(); chrome.unmount() }
w.serviceReady = true
