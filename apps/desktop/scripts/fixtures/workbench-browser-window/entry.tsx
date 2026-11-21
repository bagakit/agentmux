import { useEffect, useRef, useState } from 'react'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { useWorkbenchWindows, WorkbenchWindowNotices } from '../../../src/renderer/src/lib/workbench-windows'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { spatialCatalog } from '../../../src/renderer/src/lib/space-agent-control'
import { workbenchRegionProjectionSlotId, type WorkbenchProjection } from '../../../src/renderer/src/lib/workbench-projection'
import { createWorkspaceLayout } from '@agentmux/layout'
import { updateThemeSelection } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'

const bridge = (window as any).nativeWindowProof
const data = await bridge.data(), phase = data.phase
for (const method of ['registerPresentation', 'updatePresentation', 'removePresentation', 'activatePresentation', 'armPresentationCapture', 'ackPresentationCapture', 'setBounds', 'restore', 'cancelElementSelection', 'setAnnotationMarkers', 'recoveryPreview']) {
  ;(api.browser as any)[method] = (...args: any[]) => bridge.browser(method, ...args)
}
api.browser.onPresentationEvent = bridge.onPresentation
api.browser.onEvent = bridge.onBrowser
api.ui.workbenchWindows = bridge.windows
const preview = await api.config.get()
const resource = { id: 'native-resource', hostId: 'local', path: '/private/native-window-proof', name: 'Original Browser workspace', kind: 'folder' as const }
const surfaces = data.pages.map((page: any, index: number) => ({ ...page, kind: 'browser' as const, browserId: page.id, regionId: index === 0 ? 'http-region' : 'file-region', workspaceId: resource.id }))
let tab = createWorkbenchTab('native-browser-tab', surfaces[0])
tab = addWorkbenchRegion(tab, 'http-region', 'right', surfaces[1])
const cold = createWorkbenchTab('unrelated-cold-tab', { ...surfaces[0], id: 'unrelated-cold-page', browserId: 'unrelated-cold-page', regionId: 'unrelated-cold-region', nativeOwnerDeferred: true })
const launcher = createWorkbenchTab('native-background', { kind: 'launcher', regionId: 'background-region', workspaceId: resource.id })
const layout = createWorkspaceLayout('native-display-group', [tab.id, launcher.id, cold.id]); layout.groups[0]!.activeTabId = launcher.id
const displayId = 'native-cross-display'
useAppStore.setState({ loading: false, initialize: async () => () => {}, config: { ...preview, workspaces: [resource] }, sessions: [], tabs: { [tab.id]: tab, [launcher.id]: launcher, [cold.id]: cold },
  layouts: { [resource.id]: layout, [displayId]: layout }, activeWorkspaceId: resource.id, mainSurface: 'workbench', toolsOpen: false, projectRailOpen: false,
  warmTerminals: {}, prewarmTerminal: async () => {}, workbenchNavigationInputPolicy: null, workbenchSpaceSelection: null })
updateThemeSelection({ appAppearance: 'dark' })
api.browser.onEvent(event => useAppStore.getState().applyBrowserEvent(event))
const target = { kind: 'tab' as const, displayWorkspaceId: displayId, groupId: 'native-display-group', tabId: tab.id }
const region = { ...target, kind: 'region' as const, regionId: 'http-region' }
const focusReference = { displayWorkspaceId: resource.id, groupId: target.groupId, tabId: tab.id, regionId: region.regionId }
const focusProjection: WorkbenchProjection = { entity: { kind: 'region', regionId: region.regionId },
  presentationId: 'focus-workbench', displayWorkspaceId: resource.id, catalog: spatialCatalog(useAppStore.getState(), []),
  selection: [focusReference], onSelect: () => {} }
const focusPrefix = 'focus-workbench-slot'
const focusSlot = workbenchRegionProjectionSlotId(focusPrefix, focusReference)
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message) }
const wait = async (name: string, read: () => any) => {
  const until = Date.now() + 15000
  do { const result = await read(); if (result) return result; await new Promise(done => setTimeout(done, 25)) } while (Date.now() < until)
  throw new Error('Renderer condition did not settle: ' + name)
}
function Proof() {
  const windows = useWorkbenchWindows(true)
  const [visible, show] = useState(false)
  const [focusRegion, showFocusRegion] = useState(false)
  const started = useRef(false)
  useEffect(() => {
    if (started.current || phase === 'restore' && !windows.some(item => item.target)) return
    started.current = true
    void (async () => {
      await bridge.fill()
      const call = bridge.windows.call
      let open = phase === 'seed' ? await call('app.window.open', { operationId: 'http-file-tab-open', target, focus: false }) : await call('app.window.ls', {})
      const child = await wait('same child descriptor', async () => (await call('app.window.ls', {})).windows.find((row: any) => row.target?.kind === 'tab' && row.documentGeneration))
      assert(phase !== 'seed' || open.recordedOperation.state === 'confirmed', 'Original Tab opening is confirmed')
      if (phase === 'restore') assert(child.windowId === localStorage.getItem('durable-native-window'), 'Real restart restores the same durable window identity')
      const childDocument = { windowId: child.windowId, documentGeneration: child.documentGeneration }
      const detached = await bridge.inspect(phase + '-tab-detached', 'child', { ids: data.pages.map((page: any) => page.id), window: childDocument })
      assert(detached.every((page: any) => page.form.draft === 'Unsubmitted draft ' + page.id && page.form.title === 'Unsent title ' + page.id), 'Same-process native forms remain unsubmitted after detaching')
      showFocusRegion(true)
      await wait('the visible original Tab notice in Focus Region', () => {
        const title = document.getElementById(focusSlot)?.querySelector('.detached-workface__title')
        const bounds = title?.getBoundingClientRect()
        return title?.textContent === 'This Tab is in a separate window.' && bounds &&
          document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) === title
      })
      const focused = await bridge.inspect(phase + '-focus-region', 'child', { ids: data.pages.map((page: any) => page.id), window: childDocument })
      assert(focused.every((page: any) => page.form.draft === 'Unsubmitted draft ' + page.id), 'Focus Region retains both drafts in the independent Tab')
      showFocusRegion(false)
      await wait('Focus Region closed', () => !document.getElementById(focusSlot))
      const returned = await call('app.window.return', { operationId: phase + '-tab-return', ...childDocument })
      assert(returned.recordedOperation.state === 'confirmed', 'Original Tab return is confirmed')
      await bridge.inspect(phase + '-tab-return-hidden', 'hidden', { ids: data.pages.map((page: any) => page.id) })
      if (phase === 'seed') {
        await new Promise<void>(done => { show(true); requestAnimationFrame(() => requestAnimationFrame(() => done())) })
        const state = useAppStore.getState(); state.selectMainRegion({ displayWorkspaceId: resource.id, groupId: 'native-display-group', tabId: tab.id, regionId: 'http-region' })
        await bridge.inspect('seed-original-main', 'main', { ids: data.pages.map((page: any) => page.id) })
        const regionOpen = await call('app.window.open', { operationId: 'http-region-open', target: region, focus: false })
        assert(regionOpen.recordedOperation.state === 'confirmed', 'Exact Region opens')
        const regionDoc = { windowId: regionOpen.recordedOperation.windowId, documentGeneration: regionOpen.recordedOperation.documentGeneration }
        const separate = await bridge.inspect('seed-region-detached', 'child', { ids: [data.pages[0].id], window: regionDoc })
        assert(separate[1].host === 'main' && separate[1].visible, 'Other original page remains in Main while one Region detaches')
        const regionReturn = await call('app.window.return', { operationId: 'http-region-return', ...regionDoc })
        assert(regionReturn.recordedOperation.state === 'confirmed', 'Exact Region returns')
        const restored = await bridge.inspect('seed-region-return', 'main', { ids: data.pages.map((page: any) => page.id) })
        assert(restored.every((page: any) => page.form.draft === 'Unsubmitted draft ' + page.id), 'Same original forms survive every window handoff')
        show(false)
        const reopen = await call('app.window.open', { operationId: 'durable-native-tab-open', target, focus: false })
        assert(reopen.recordedOperation.state === 'confirmed', 'Original Tab remains usable for durable re-open')
        localStorage.setItem('durable-native-window', reopen.recordedOperation.windowId)
        await bridge.inspect('seed-before-restart', 'child', { ids: data.pages.map((page: any) => page.id), window: { windowId: reopen.recordedOperation.windowId, documentGeneration: reopen.recordedOperation.documentGeneration } })
        await bridge.done({ passed: true, durableWindowId: reopen.recordedOperation.windowId })
      } else await bridge.done({ passed: true, durableWindowId: child.windowId })
    })().catch(error => bridge.done({ passed: false, failure: { message: String(error), stack: error.stack } }))
  }, [windows.length])
  return <><header style={{ height: 48, padding: 14, fontWeight: 600 }}>Main workface — detached pages must stay in their original window</header>
    <div style={{ height: 'calc(100% - 74px)', position: 'relative' }}>
      <div hidden={!visible} style={{ height: '100%' }}><WorkspaceWorkbench workspaceId={resource.id} visible={visible} viewTargets={focusRegion ? { [tab.id]: [
        { hostId: focusSlot, projection: focusProjection, reference: focusReference, surface: 'focus', active: true, visible: true }
      ] } : {}} windowTargets={windows} /></div>
      {focusRegion ? <WorkspaceWorkbench workspaceId={resource.id} viewOwnership="projection" projection={focusProjection} viewHostPrefix={focusPrefix} /> : null}
    </div><footer className="window-status-bar"><WorkbenchWindowNotices /></footer></>
}
createClientUiRoot(document.getElementById('root')!).render(<Proof />)
