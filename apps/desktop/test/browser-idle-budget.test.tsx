// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot } from './helpers/client-ui-render'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useSurfaceMemoryBudget } from '../src/renderer/src/lib/surface-memory-budget-coordinator'

const original = useAppStore.getState()
let root: ReturnType<typeof createClientUiRoot> | undefined, container: HTMLDivElement | undefined
function Probe() {
  const budget = useSurfaceMemoryBudget({ workbenchVisible: true })
  return <output data-browser={[...budget.browserRegionIds].join(',')} data-monaco={[...budget.monacoRegionIds].join(',')} />
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; container?.remove(); container = undefined
  useAppStore.setState(original, true); vi.useRealTimers(); vi.unstubAllGlobals()
})
it('keeps Browser hidden age across projects while retaining the independent Monaco context rule', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.useFakeTimers(); vi.setSystemTime(0)
  const launcher = createWorkbenchTab('launcher', { kind: 'launcher', regionId: 'launcher-region', workspaceId: 'workspace' })
  const browser = createWorkbenchTab('browser-tab', { kind: 'browser', regionId: 'browser-region', workspaceId: 'workspace',
    browserId: 'browser', id: 'browser', navigationId: 'document', profileId: 'profile', mode: 'normal', viewport: 'responsive',
    title: 'Quiet page', url: 'https://example.invalid/', error: null, loading: false, driving: false, appLinkPrompt: null,
    canGoBack: false, canGoForward: false, retention: {status: 'eligible', reasons: []} })
  const file = createWorkbenchTab('file-tab', { kind: 'file', regionId: 'file-region', workspaceId: 'workspace', path: 'draft.md' })
  useAppStore.setState({tabs: {[launcher.id]: launcher, [browser.id]: browser, [file.id]: file},
    layouts: {workspace: createWorkspaceLayout('group',[launcher.id,browser.id,file.id])},
    activeWorkspaceId: 'workspace', documents: {'workspace\0draft.md': {} as never}, dirtyDocuments: {}, savingDocuments: {}})
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  await act(async () => root!.render(<Probe />))
  await act(async () => useAppStore.setState({activeWorkspaceId:'another-workspace'}))
  await act(async () => vi.advanceTimersByTimeAsync(270_000))
  expect(container.querySelector('output')!.dataset.browser).toBe('')
  expect(container.querySelector('output')!.dataset.monaco).toBe('')
  await act(async () => useAppStore.setState({activeWorkspaceId:'workspace'}))
  await act(async () => vi.advanceTimersByTimeAsync(30_001))
  expect(container.querySelector('output')!.dataset.browser).toBe('browser-region')
  expect(container.querySelector('output')!.dataset.monaco).toBe('')
})
