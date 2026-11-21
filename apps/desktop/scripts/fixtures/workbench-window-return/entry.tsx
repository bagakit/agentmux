import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { StableWorkbenchView, WorkbenchSurfaceHost } from '../../../src/renderer/src/components/StableWorkbenchView'
import { useWorkbenchWindows, WorkbenchWindowNotices } from '../../../src/renderer/src/lib/workbench-windows'
import { originalWorkbenchHost } from '../../../src/renderer/src/lib/workbench-window-registry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'

const bridge = (window as any).windowProof
const actions: Array<{ method: string; input: any; page: any }> = []
api.ui.workbenchWindows = { ...bridge, async call(method: string, input: any) {
  const page = await bridge.call(method, input)
  if (method !== 'app.window.ls') actions.push({ method, input, page })
  return page
} }
const reference = { displayWorkspaceId: 'private-workspace', groupId: 'private-group', tabId: 'private-tab', regionId: 'private-region' }
const target = { kind: 'tab' as const, displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId }
const surveyTarget = { kind: 'surface' as const, surface: 'survey' as const }
const tab = createWorkbenchTab(reference.tabId, { kind: 'launcher', workspaceId: reference.displayWorkspaceId, regionId: reference.regionId })
const layout = createWorkspaceLayout(reference.groupId, [tab.id])
useAppStore.setState({ loading: false, tabs: { [tab.id]: tab }, layouts: { [reference.displayWorkspaceId]: layout } })
const phase = new URL(location.href).searchParams.get('phase')!
mountThemeRuntime(window, { appAppearance: 'dark' })
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
const wait = async (read: () => any) => { const until = Date.now() + 12000; do { const value = read(); if (value) return value; await new Promise(done => setTimeout(done, 20)) } while (Date.now() < until); throw new Error('Private workface did not settle') }
function Proof() {
  const windows = useWorkbenchWindows(true)
  const [showFocus, setShowFocus] = useState(false)
  const started = useRef(false)
  useEffect(() => {
    if (started.current || phase !== 'seed' && !windows.some(item => item.target)) return
    started.current = true
    void (async () => {
      const original = await wait(() => originalWorkbenchHost(target)?.host.querySelector('input')) as HTMLInputElement
      const call = (method: string, input: any) => bridge.call(method, input)
      let page
      const frames: Array<{ file: string; geometry: any }> = []
      const capture = async (file: string, width: number, height: number, reduced = false) => {
        const geometry = await bridge.snapshot(file, width, height, reduced)
        assert(geometry.theme === (file.endsWith('-light.png') ? 'light' : 'dark'), 'The capture must use the requested original theme')
        assert(geometry.title === 'This Tab is in a separate window.', 'Actual placeholder explains the original Tab')
        assert(geometry.buttons.some((button: any) => button.label === 'Show window' && button.hit) &&
          geometry.buttons.some((button: any) => button.label === 'Bring back' && button.hit), 'The original actions are visible and hittable')
        frames.push({ file, geometry })
        return geometry
      }
      if (phase === 'seed') {
        original.value = 'Original unsent draft stays in the same DOM node'
        const midpoint = wait(() => document.querySelector('#original-home .detached-workface__window')?.getAnimations()[0]).then((motion: Animation) => {
          motion.pause()
          motion.currentTime = Number(motion.effect!.getComputedTiming().duration) / 4
          return motion
        })
        page = await call('app.window.open', { operationId: 'seed-open', target, focus: false })
        assert(page.recordedOperation.state === 'confirmed', 'Open must confirm the exact original placement')
        const motion = await midpoint
        const during = await capture('space-lifting-dark.png', 960, 680)
        assert(during.animations.some((item: any) => item.name === 'detached-window-lift' && item.time > 0), 'Capture the actual lift between its endpoints')
        motion.finish()
        const settled = await capture('space-settled-dark.png', 960, 680)
        assert(settled.animations.length === 0, 'The branded notice settles without a loop')
        setShowFocus(true)
        await wait(() => document.querySelector('#focus-home .detached-workface'))
        updateThemeSelection({ appAppearance: 'light' })
        await Promise.all(document.querySelector('#focus-home .detached-workface')!.getAnimations({ subtree: true }).map(motion => motion.finished))
        await capture('focus-narrow-light.png', 430, 380)
        updateThemeSelection({ appAppearance: 'dark' })
        const reduced = await capture('focus-short-reduced-dark.png', 480, 170, true)
        assert(reduced.reduced && reduced.animations.length === 0, 'Reduced motion shows a static original notice')
      } else {
        await wait(() => original.ownerDocument !== document)
        page = await call('app.window.ls', {})
      }
      const child = page.windows.find((item: any) => item.target?.kind === 'tab')
      assert(child, 'Original durable window must remain recorded')
      if (phase !== 'seed') assert(child.windowId === localStorage.getItem('originalWindow'), 'Restart must restore the same durable window identity')
      let returned
      if (phase === 'seed') {
        await bridge.click('#focus-home .detached-workface__actions button:first-child')
        const show = await wait(() => actions.find(action => action.method === 'app.window.focus'))
        assert(show.page.recordedOperation.state === 'confirmed' && show.input.windowId === child.windowId &&
          show.input.documentGeneration === child.documentGeneration, 'Show window focuses the exact existing native window')
        await bridge.click('#focus-home .detached-workface__actions button:nth-child(2)')
        const recall = await wait(() => actions.find(action => action.method === 'app.window.return'))
        assert(recall.input.windowId === child.windowId && recall.input.documentGeneration === child.documentGeneration, 'Bring back addresses the exact original window')
        returned = recall.page
        assert(document.getElementById('focus-home')!.contains(original), 'Recall preserves the currently selected Focus occurrence')
        setShowFocus(false)
        await wait(() => document.getElementById('original-home')!.contains(original))
      } else {
        returned = await call('app.window.return', { operationId: phase + '-return', windowId: child.windowId, documentGeneration: child.documentGeneration })
      }
      assert(returned.recordedOperation.state === 'confirmed', 'Return must confirm without manual repair')
      assert(original.ownerDocument === document && document.getElementById('original-home')!.contains(original), 'Same original DOM content must return to its Main home')
      if (phase === 'seed') assert(original.value === 'Original unsent draft stays in the same DOM node', 'Return preserves the original unsent input')
      assert(!returned.windows.some((item: any) => item.windowId === child.windowId), 'Confirmed return retires only its shell')
      let reopened
      if (phase === 'seed') {
        reopened = await call('app.window.open', { operationId: 'seed-reopen', target, focus: false })
        assert(reopened.recordedOperation.state === 'confirmed', 'Original host remains usable for another open')
        localStorage.setItem('originalWindow', reopened.recordedOperation.windowId)
        const survey = await call('app.window.open', { operationId: 'seed-survey', target: surveyTarget, focus: true })
        assert(survey.recordedOperation.state === 'confirmed', 'Open must confirm the original Survey window')
        localStorage.setItem('originalSurvey', survey.recordedOperation.windowId)
      }
      const surveyHost = await wait(() => {
        const host = originalWorkbenchHost(surveyTarget)?.host
        return host && host.ownerDocument !== document && host
      })
      const survey = (await call('app.window.ls', {})).windows.find((item: any) => item.target?.surface === 'survey')
      assert(survey?.windowId === localStorage.getItem('originalSurvey'), 'Quit and restart must preserve the same Survey window')
      assert(surveyHost.querySelector('input')?.value === 'Original Survey content', 'The original Survey content is visible in its own document')
      await bridge.done({ passed: true, durableWindowId: reopened?.recordedOperation.windowId ?? child.windowId, durableSurveyWindowId: survey.windowId, returned: returned.recordedOperation, sameDomNode: true, frames,
        boundary: 'Real Electron Main/Renderer and production WorkbenchWindows, durable window store, hook and StableWorkbenchView. Controlled input, no user App/Run or native webpage.' })
    })().catch(error => bridge.done({ passed: false, error: String(error), stack: error.stack }))
  }, [windows.length])
  return <><WorkbenchWindowNotices /><div hidden><div id="survey-home" /><WorkbenchSurfaceHost surface="survey" homeId="survey-home" visible><input defaultValue="Original Survey content" /></WorkbenchSurfaceHost></div>
    <main style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--surface-0)' }}>
    <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)', color: 'var(--text-2)' }}>{showFocus ? 'Focus' : 'Space'} · Original work</div>
    <div id="original-home" className="workbench-tab-slot" style={{ display: showFocus ? 'none' : undefined }} />
    <div id="focus-home" className="workbench-tab-slot" style={{ display: showFocus ? undefined : 'none' }} />
    <StableWorkbenchView homeId="original-home" targetId={showFocus ? 'focus-home' : null} primaryTabId={reference.tabId} reference={reference} windowTarget={target} active visible retainedRegionId={reference.regionId}>
    <input defaultValue="Original controlled input" />
  </StableWorkbenchView></main></>
}
createRoot(document.getElementById('root')!).render(<Proof />)
