import { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { StableWorkbenchView } from '../../../src/renderer/src/components/StableWorkbenchView'
import { useWorkbenchWindows, WorkbenchWindowNotices } from '../../../src/renderer/src/lib/workbench-windows'
import { originalWorkbenchHost } from '../../../src/renderer/src/lib/workbench-window-registry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'

const bridge = (window as any).windowProof
api.ui.workbenchWindows = bridge
const reference = { displayWorkspaceId: 'private-workspace', groupId: 'private-group', tabId: 'private-tab', regionId: 'private-region' }
const target = { kind: 'tab' as const, displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId }
const tab = createWorkbenchTab(reference.tabId, { kind: 'launcher', workspaceId: reference.displayWorkspaceId, regionId: reference.regionId })
const layout = createWorkspaceLayout(reference.groupId, [tab.id])
useAppStore.setState({ loading: false, tabs: { [tab.id]: tab }, layouts: { [reference.displayWorkspaceId]: layout } })
const phase = new URL(location.href).searchParams.get('phase')!
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
const wait = async (read: () => any) => { const until = Date.now() + 12000; do { const value = read(); if (value) return value; await new Promise(done => setTimeout(done, 20)) } while (Date.now() < until); throw new Error('Private workface did not settle') }
function Proof() {
  const windows = useWorkbenchWindows(true)
  const started = useRef(false)
  useEffect(() => {
    if (started.current || phase !== 'seed' && !windows.some(item => item.target)) return
    started.current = true
    void (async () => {
      const original = await wait(() => originalWorkbenchHost(target)?.host.querySelector('input')) as HTMLInputElement
      const call = (method: string, input: any) => bridge.call(method, input)
      let page
      if (phase === 'seed') {
        original.value = 'Original unsent draft stays in the same DOM node'
        page = await call('app.window.open', { operationId: 'seed-open', target, focus: false })
        assert(page.recordedOperation.state === 'confirmed', 'Open must confirm the exact original placement')
      } else {
        await wait(() => original.ownerDocument !== document)
        page = await call('app.window.ls', {})
      }
      const child = page.windows.find((item: any) => item.target)
      assert(child, 'Original durable window must remain recorded')
      if (phase !== 'seed') assert(child.windowId === localStorage.getItem('originalWindow'), 'Restart must restore the same durable window identity')
      const returned = await call('app.window.return', { operationId: phase + '-return', windowId: child.windowId, documentGeneration: child.documentGeneration })
      assert(returned.recordedOperation.state === 'confirmed', 'Return must confirm without manual repair')
      assert(original.ownerDocument === document && document.getElementById('original-home')!.contains(original), 'Same original DOM content must return to its Main home')
      if (phase === 'seed') assert(original.value === 'Original unsent draft stays in the same DOM node', 'Return preserves the original unsent input')
      assert(!returned.windows.some((item: any) => item.windowId === child.windowId), 'Confirmed return retires only its shell')
      let reopened
      if (phase === 'seed') {
        reopened = await call('app.window.open', { operationId: 'seed-reopen', target, focus: false })
        assert(reopened.recordedOperation.state === 'confirmed', 'Original host remains usable for another open')
        localStorage.setItem('originalWindow', reopened.recordedOperation.windowId)
      }
      await bridge.done({ passed: true, durableWindowId: reopened?.recordedOperation.windowId ?? child.windowId, returned: returned.recordedOperation, sameDomNode: true,
        boundary: 'Real Electron Main/Renderer and production WorkbenchWindows, durable window store, hook and StableWorkbenchView. Controlled input, no user App/Run or native webpage.' })
    })().catch(error => bridge.done({ passed: false, error: String(error), stack: error.stack }))
  }, [windows.length])
  return <><WorkbenchWindowNotices /><div id="original-home" /><StableWorkbenchView homeId="original-home" targetId={null} primaryTabId={reference.tabId} reference={reference} windowTarget={target} active visible retainedRegionId={reference.regionId}>
    <input defaultValue="Original controlled input" />
  </StableWorkbenchView></>
}
createRoot(document.getElementById('root')!).render(<Proof />)
