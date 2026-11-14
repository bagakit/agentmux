// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/shared/contracts'
import { BrowserAgentCreationOptionsDialog } from '../src/renderer/src/components/BrowserAgentCreationOptions'
import { BrowserOperationStatus } from '../src/renderer/src/components/BrowserOperationSurface'
import { browserAgentCreationContext, browserAgentCreationDraftKey, createBrowserAgent } from '../src/renderer/src/lib/browser-agent-creation'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab, type BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { executeSpatialControl, type SpatialControlPorts } from '../src/renderer/src/lib/space-agent-control'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const initial = useAppStore.getState(), originalLauncher = useLauncherState.getState()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  useAppStore.setState(initial, true); useLauncherState.setState(originalLauncher, true); vi.restoreAllMocks()
})
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  workspaces: [{ id: 'workspace', hostId: 'local', path: '/actual/project', name: 'Project', kind: 'folder' }],
  executors: { codex: { providerId: 'codex', command: 'codex', label: 'Codex', args: [], env: {}, injectAgentMuxGuide: true },
    claude: { providerId: 'claude', command: 'claude', label: 'Claude', args: [], env: {}, injectAgentMuxGuide: true } },
  browser: { agentAutomation: true, toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } },
  appearance: { terminalTheme: 'graphite' } }
const source = { tabId: 'tab', regionId: 'region', displayWorkspaceId: 'workspace', groupId: 'group' }
function seed() {
  const browser: BrowserWorkbenchSurface = { kind: 'browser', id: 'browser', regionId: 'region', browserId: 'browser', workspaceId: 'workspace',
    mode: 'normal', navigationId: 'page', profileId: 'profile', url: 'https://example.test/', title: 'Page',
    driving: false, loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive', error: null, appLinkPrompt: null,
    control: { owner: 'human', agent: null, revision: 3, activeOperationId: null, inputIsolation: 'inactive' } }
  const executeControl = vi.fn(async (request, _signal, options) => {
    // Exercise the production creation command through its durable spatial admission boundary.
    useAppStore.setState(state => ({ spatialRequests: { ...state.spatialRequests,
      [request.requestId]: { purpose: options.purpose, browserAgent: options.browserAgent } } }))
    return { operation: 'agent.open', requestId: request.requestId, agent: null, issues: [] }
  })
  useAppStore.setState({ config, tabs: { tab: createWorkbenchTab('tab', browser) }, layouts: { workspace: createWorkspaceLayout('group', ['tab']) },
    sessions: [], executorDetections: {}, hostExecutorInventories: {}, spatialRequests: {}, executeControl } as never)
  useLauncherState.setState({ drafts: {}, executors: { workspace: 'codex' } })
  return { browser, executeControl }
}
async function mount(element: ReturnType<typeof createElement>) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(element))
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove() })
  return { host, root }
}
const context = () => browserAgentCreationContext(useAppStore.getState(), 'workspace', 'codex')

describe('Browser Agent options keep the original creation and task', () => {
  it('uses the offered Executor and exact source, sends the selected split, and retains all task text in the original intent', async () => {
    const { executeControl } = seed(), task = '  Keep my exact words.\n' + 'More detail. '.repeat(1500)
    await expect(createBrowserAgent('browser', source, undefined, { executorId: 'claude', split: 'down', task,
      expectedPage: { navigationId: 'page', controlRevision: 3 }, expectedExecution: { hostId: 'local', path: '/actual/project' } })).resolves.toMatchObject({ kind: 'setup-unconfirmed' })
    expect(executeControl).toHaveBeenCalledOnce()
    const [request, , admission] = executeControl.mock.calls[0]!
    expect(request).toMatchObject({ operation: 'agent.open', content: { kind: 'new-agent', executorId: 'claude', executionWorkspaceId: 'workspace' }, destination: { ...source, split: 'down' } })
    expect(admission.browserAgent.prompt).toContain('\n\n用户任务：\n' + task)
    expect(admission.browserAgent.prompt).not.toContain('等待用户的具体任务')
    expect(admission.browserAgent).toMatchObject({ source, hostId: 'local', executionPath: '/actual/project', navigationId: 'page', controlRevision: 3 })
    expect(admission.authorize()).toBe(true)
  })

  it('keeps one-step creation on the original default Executor, right split and observation-only task', async () => {
    const { executeControl } = seed()
    await createBrowserAgent('browser', source)
    expect(executeControl.mock.calls[0]![0]).toMatchObject({ content: { executorId: 'codex' }, destination: { ...source, split: 'right' } })
    expect(executeControl.mock.calls[0]![2].browserAgent.prompt).toContain('等待用户的具体任务')
  })

  it.each(['page', 'execution'] as const)('does not create against a changed %s while preserving saved input', async change => {
    const { executeControl } = seed(), key = browserAgentCreationDraftKey('browser')
    useLauncherState.getState().setBrowserAgentDraft(key, { prompt: 'Retained original task', executorId: 'claude', split: 'left', hostId: 'local' })
    const options = { executorId: 'claude', expectedPage: { navigationId: change === 'page' ? 'older-page' : 'page', controlRevision: 3 },
      expectedExecution: { hostId: 'local', path: change === 'execution' ? '/older/project' : '/actual/project' } }
    await expect(createBrowserAgent('browser', source, undefined, options)).rejects.toThrow('changed')
    expect(executeControl).not.toHaveBeenCalled()
    expect(useLauncherState.getState().drafts[key]?.prompt).toBe('Retained original task')
  })

  it('reads an existing request before new options and never substitutes a new Agent or task', async () => {
    const { browser } = seed()
    useAppStore.setState({ tabs: { tab: createWorkbenchTab('tab', { ...browser, agentCreationRequestId: 'original-request' }) },
      spatialRequests: { 'original-request': { purpose: 'browser-agent', browserAgent: { prompt: 'Original retained task' } } } } as never)
    const executeControl = vi.fn(async () => ({ operation: 'space.inspect', request: { known: true, report: { agent: null } } }))
    useAppStore.setState({ executeControl } as never)
    await expect(createBrowserAgent('browser', source, undefined, { executorId: 'different-executor', task: 'New unsent task', split: 'up',
      expectedPage: { navigationId: 'stale', controlRevision: 0 } })).resolves.toMatchObject({ kind: 'setup-unconfirmed' })
    expect(executeControl).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'space.inspect', target: { requestId: 'original-request' } }))
    expect(useAppStore.getState().spatialRequests['original-request']?.browserAgent?.prompt).toBe('Original retained task')
  })

  it('keeps the original request pointer and task when actual spatial inspection finds no local binding', async () => {
    const { browser } = seed(), key = browserAgentCreationDraftKey('browser')
    useLauncherState.getState().setBrowserAgentDraft(key, { prompt: 'Original authored task', executorId: 'claude', split: 'down', hostId: 'local' })
    useAppStore.setState({ tabs: { tab: createWorkbenchTab('tab', { ...browser, agentCreationRequestId: 'unobserved-original-request' }) }, spatialRequests: {} })
    const bindings = useAppStore.getState().spatialRequests, draft = useLauncherState.getState().drafts[key]
    const ports = { get: () => useAppStore.getState(), topics: async () => [] } as unknown as SpatialControlPorts
    let inspection: unknown
    const executeControl = vi.fn(async request => {
      if (request.operation !== 'space.inspect') throw new Error('A second Agent creation reached its admission boundary')
      inspection = await executeSpatialControl(ports, request)
      return inspection
    })
    useAppStore.setState({ executeControl } as never)
    await expect(createBrowserAgent('browser', source, undefined, { task: 'Never substitute this task', executorId: 'claude', split: 'down' }))
      .rejects.toThrow('original Agent request unobserved-original-request')
    expect(inspection).toMatchObject({ operation: 'space.inspect', request: { known: false, report: null } })
    expect(executeControl.mock.calls.map(call => call[0].operation)).toEqual(['space.inspect'])
    expect((useAppStore.getState().tabs.tab?.regions.region as BrowserWorkbenchSurface).agentCreationRequestId).toBe('unobserved-original-request')
    expect(useAppStore.getState().spatialRequests).toBe(bindings)
    expect(useLauncherState.getState().drafts[key]).toBe(draft)
    expect(useAppStore.getState().sessions).toEqual([])
  })

  it('keeps a remote preferred Executor visible when Host discovery is unavailable', () => {
    seed()
    const remote = { ...config, hosts: [{ id: 'remote', kind: 'ssh', label: 'Server' }], workspaces: [{ ...config.workspaces[0], hostId: 'remote' }] } as AppConfig
    expect(browserAgentCreationContext({ config: remote, executorDetections: {}, hostExecutorInventories: {} }, 'workspace', 'remote-codex')).toMatchObject({
      defaultExecutorId: 'remote-codex', executors: [{ id: 'remote-codex', detail: 'Host discovery unconfirmed' }] })
  })
})

describe('Browser creation options use the existing utility draft owner', () => {
  it('makes Executor, Host, directory, task and placement reviewable and preserves draft after cancellation and failure', async () => {
    seed()
    const key = browserAgentCreationDraftKey('browser'), close = vi.fn(), create = vi.fn(async () => 'Core admission unavailable; original request kept')
    useLauncherState.getState().setBrowserAgentDraft(key, { prompt: 'Review this page', executorId: 'claude', split: 'left', hostId: 'local' })
    const view = await mount(createElement(BrowserAgentCreationOptionsDialog, { browserId: 'browser', context: context(), hostLabel: 'This Mac', ownerDocument: document, onCreate: create, onClose: close }))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('This Mac'); expect(dialog.textContent).toContain('/actual/project')
    expect(dialog.querySelector<HTMLTextAreaElement>('[aria-label="Task for new Browser Agent"]')?.value).toBe('Review this page')
    const selects = dialog.querySelectorAll<HTMLSelectElement>('select')
    expect(selects[0]!.value).toBe('claude'); expect(selects[1]!.value).toBe('left')
    await act(async () => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(create).toHaveBeenCalledExactlyOnceWith({ executorId: 'claude', split: 'left', task: 'Review this page' })
    expect(dialog.textContent).toContain('Core admission unavailable'); expect(close).not.toHaveBeenCalled()
    await act(async () => Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Cancel')!.click())
    expect(close).toHaveBeenCalledOnce(); expect(useLauncherState.getState().drafts[key]?.prompt).toBe('Review this page')
    await act(async () => view.root.render(createElement('div')))
  })

  it('does not restore a stale Executor just because a user changes placement after the execution Host changed', async () => {
    seed(); const key = browserAgentCreationDraftKey('browser'), create = vi.fn(async () => null)
    useLauncherState.getState().setBrowserAgentDraft(key, { prompt: 'Keep me', executorId: 'old-host-agent', split: 'right', hostId: 'old-host' })
    await mount(createElement(BrowserAgentCreationOptionsDialog, { browserId: 'browser', context: context(), hostLabel: 'This Mac', ownerDocument: document, onCreate: create, onClose: vi.fn() }))
    const dialog = document.querySelector('[role="dialog"]')!, selects = dialog.querySelectorAll<HTMLSelectElement>('select')
    expect(selects[0]!.value).toBe('')
    await act(async () => { selects[1]!.value = 'down'; selects[1]!.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(selects[0]!.value).toBe(''); expect(useLauncherState.getState().drafts[key]?.prompt).toBe('Keep me')
    await act(async () => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(create).not.toHaveBeenCalled(); expect(dialog.textContent).toContain('Choose an Executor')
  })

  it('exposes options and meaningful permission service actions without blocking an existing control capability', async () => {
    const configure = vi.fn(), give = vi.fn(), settings = vi.fn(), retry = vi.fn()
    const view = await mount(createElement(BrowserOperationStatus, { activity: { operation: null, control: 'human' },
      control: { owner: 'human', agent: null, revision: 1, activeOperationId: null, inputIsolation: 'inactive' },
      onCreateAgent: vi.fn(), onConfigureAgent: configure, creationDescription: 'Codex · Server · Right', onGiveControl: give,
      automationNotice: { message: 'Profile access is unconfirmed', actionLabel: 'Profile access settings', action: settings, retry } }))
    await act(async () => view.host.querySelector('[aria-label^="Browser activity:"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    const menu = document.querySelector('[role="menu"]')!
    expect(menu.textContent).toContain('Codex · Server · Right'); expect(menu.textContent).toContain('Profile access is unconfirmed')
    const option = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent === 'New Agent options…')!
    await act(async () => option.click()); expect(configure).toHaveBeenCalledOnce()
    expect(view.host.querySelector<HTMLButtonElement>('[aria-label="在右侧创建 Agent"]')!.disabled).toBe(false)
  })
})


describe('survey-directory: creation options keep task editing during preparation failure', () => {
  it('shows an unconfirmed directory while keeping the original draft, Executor and Create retry reachable', async () => {
    seed()
    const key=browserAgentCreationDraftKey('browser'), create=vi.fn(async()=> 'Original Host directory is still unconfirmed')
    useLauncherState.getState().setBrowserAgentDraft(key,{prompt:'Keep my research task',executorId:'claude',split:'right',hostId:'local'})
    await mount(createElement(BrowserAgentCreationOptionsDialog,{browserId:'browser',context:context(),hostLabel:'This Mac',ownerDocument:document,
      preparationIssue:'Directory registration ACK unconfirmed',onCreate:create,onClose:vi.fn()}))
    const dialog=document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('Execution directory unconfirmed')
    expect(dialog.textContent).not.toContain('/actual/project')
    const task=dialog.querySelector<HTMLTextAreaElement>('[aria-label="Task for new Browser Agent"]')!
    expect(task.value).toBe('Keep my research task');expect(task.disabled).toBe(false)
    expect(dialog.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false)
    await act(async()=>dialog.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
    expect(create).toHaveBeenCalledExactlyOnceWith({executorId:'claude',split:'right',task:'Keep my research task'})
    expect(useLauncherState.getState().drafts[key]?.prompt).toBe('Keep my research task')
  })
})
