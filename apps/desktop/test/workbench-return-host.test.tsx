// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { StableWorkbenchView } from '../src/renderer/src/components/StableWorkbenchView'
import { WorkbenchBrowserTargetsContext, type WorkbenchViewTarget } from '../src/renderer/src/lib/workbench-presentation'
import { originalWorkbenchHost, placeWorkbenchWindow } from '../src/renderer/src/lib/workbench-window-registry'
const reference = { displayWorkspaceId: 'return-display', groupId: 'return-group', tabId: 'return-tab', regionId: 'return-region' }
const target = { kind: 'region' as const, ...reference }
let root: ReturnType<typeof createClientUiRoot> | undefined, container: HTMLElement | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container?.remove(); container = undefined; vi.unstubAllGlobals() })
async function mount(targets: WorkbenchViewTarget[]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  await act(async () => root!.render(<WorkbenchBrowserTargetsContext.Provider value={targets}><div id="return-home" /><div id="return-window" />
    <StableWorkbenchView kind="region" nativeRegionId={reference.regionId} homeId="return-home" targetId={null} reference={reference}
      active={false} visible={false} surface="space" retainedRegionId={null}><input defaultValue="Original parked input" /></StableWorkbenchView>
  </WorkbenchBrowserTargetsContext.Provider>))
  return originalWorkbenchHost(target)!
}
const survey = (): WorkbenchViewTarget => ({ hostId: 'survey-original', active: true, visible: true, surface: 'survey', reference,
  returnSelection: { kind: 'page', regionId: reference.regionId, browserId: 'original-browser' } })
it('[window-return] the original host uses its unique visible exact occurrence, never an unrelated or hidden source', async () => {
  const host = await mount([{ hostId: 'hidden-space', active: false, visible: false, surface: 'space', reference },
    { ...survey(), reference: { ...reference, groupId: 'other-group' } }, survey()])
  expect(host.getReturnContext?.()).toEqual({ surface: 'survey', reference, selection: survey().returnSelection })
})
it('[window-return] ambiguous visible occurrences stay unknown without taking away the original host or its retained context', async () => {
  const host = await mount([survey(), { hostId: 'focus-original', active: true, visible: true, surface: 'focus', reference }])
  expect(host.getReturnContext?.()).toBeNull()
  const input = host.host.querySelector('input')!, value = { surface: 'focus' as const, reference, view: 'region' as const }
  let placed!: Promise<void>
  await act(() => { placed = placeWorkbenchWindow(target, { destination: container!.querySelector('#return-window')!,
    window: { windowId: 'return-window', documentGeneration: 'return-document' }, returnContext: value }) })
  await placed
  expect(host.getReturnContext?.()).toEqual(value)
  expect(host.host.querySelector('input')).toBe(input); expect(input.value).toBe('Original parked input')
})
