// @vitest-environment happy-dom
import '../scripts/fixtures/mote-navigation-footer/atomic-move.setup'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { LocalExecutionHost } from '@agentmux/core'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { prepareBrowserAgentWorkspace } from '../src/main/browser-agent-workspace'
import { browserAgentCreationDraftKey, createBrowserAgent, prepareBrowserAgentCreationContext } from '../src/renderer/src/lib/browser-agent-creation'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab, type BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { act, createElement } from 'react'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { createClientUiRoot } from './helpers/client-ui-render'
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
const initial = useAppStore.getState(), launcher = useLauncherState.getState(), roots: string[] = []
afterEach(async () => { useAppStore.setState(initial, true); useLauncherState.setState(launcher, true); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const source = { tabId: 'tab', regionId: 'region', displayWorkspaceId: '__scratch__', groupId: 'group' }
const P1 = '11111111-1111-4111-8111-111111111111'
async function seed() {
  const home = await mkdtemp(join(tmpdir(), 'amux-directory-gui-')); roots.push(home)
  const f = await configOwnerFixture({ workspaces: [{ id: '__scratch__', hostId: 'local', name: 'Scratch', path: join(home, 'scratch'), kind: 'folder' }],
    executors: { codex: { providerId: 'codex', command: 'codex', label: 'Codex', args: [], env: {}, injectAgentMuxGuide: true } } })
  const browser: BrowserWorkbenchSurface = { kind: 'browser', id: 'page', regionId: 'region', browserId: 'page', workspaceId: '__scratch__', mode: 'normal', profileId: P1,
    navigationId: 'navigation', title: 'Original page', url: 'https://example.test', loading: false, driving: false, canGoBack: false, canGoForward: false,
    viewport: 'responsive', error: null, appLinkPrompt: null, control: { owner: 'human', agent: null, revision: 1, activeOperationId: null, inputIsolation: 'inactive' } }
  const native = vi.spyOn(api.browser, 'prepareAgentWorkspace').mockImplementation(input => prepareBrowserAgentWorkspace(input, {
    config: f.owner, browser: id => id === 'page' ? { browserId: 'page', workspaceId: '__scratch__', mode: 'normal', profileId: P1 } : null,
    profileLabel: () => 'Actual Profile', host: () => new LocalExecutionHost(), home: async () => home }))
  const execute = vi.fn(async (request, _signal, options) => {
    useAppStore.setState({ spatialRequests: { [request.requestId]: { browserAgent: options.browserAgent, purpose: 'browser-agent' } } } as never)
    return { operation: 'agent.open', agent: null, issues: [] }
  })
  const layout = createWorkspaceLayout('group'); layout.groups[0]!.tabOrder = ['tab']; layout.groups[0]!.activeTabId = 'tab'
  useAppStore.setState({ config: f.owner.current, tabs: { tab: createWorkbenchTab('tab', browser) }, layouts: { __scratch__: layout }, spatialRequests: {},
    executorDetections: { codex: { state: 'ready', command: 'codex' } }, hostExecutorInventories: {}, executeControl: execute } as never)
  return { ...f, browser, native, execute, home }
}
describe('survey-directory: actual GUI creation consumer', () => {
  it('uses the Main-confirmed Profile resource in agent.open while retaining Browser resource and exact destination', async () => {
    const f = await seed()
    useAppStore.setState({ surveyProfileView: { kind: 'profile', profileId: '22222222-2222-4222-8222-222222222222' } })
    const context = await prepareBrowserAgentCreationContext(f.browser, 'survey')
    expect(context.profileLabel).toBe('Actual Profile'); expect(context.workspace?.path).toBe(join(f.home, '.agentmux/survey', P1))
    await createBrowserAgent('page', source, 'survey', { expectedExecution: { hostId: 'local', path: context.workspace!.path }, split: 'down' })
    expect(f.execute).toHaveBeenCalledOnce()
    const [request, , options] = f.execute.mock.calls[0]!
    expect(request).toMatchObject({ operation: 'agent.open', content: { executionWorkspaceId: context.workspace!.id }, destination: { ...source, split: 'down' } })
    expect(options.browserAgent).toMatchObject({ workspaceId: '__scratch__', executionWorkspaceId: context.workspace!.id,
      executionPath: context.workspace!.path, environment: { mode: 'normal', profileId: P1 } })
    expect(options.authorize()).toBe(true)
    expect((useAppStore.getState().tabs.tab!.regions.region as BrowserWorkbenchSurface).workspaceId).toBe('__scratch__')
    expect((await f.disk()).workspaces.some(row => row.id === context.workspace!.id)).toBe(true)
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: state.config!.workspaces.map(item => item.id === '__scratch__' ? { ...item, path: join(f.home, 'rebound') } : item) } }))
    expect(options.authorize()).toBe(false)
  })
  it('the mounted BrowserPane click reaches Main preparation and the original Agent creation consumer', async () => {
    const f=await seed()
    vi.spyOn(api.browser,'create').mockResolvedValue(f.browser)
    vi.spyOn(api.browser,'restore').mockResolvedValue(f.browser)
    const host=document.createElement('div');document.body.append(host);const root=createClientUiRoot(host)
    try {
      await act(async()=>root.render(createElement(WorkbenchPresentationContext.Provider,{value:{active:true,surface:'survey',reference:source,retainedRegionId:source.regionId}},
        createElement(BrowserPane,{tab:f.browser,visible:true}))))
      const button=host.querySelector<HTMLButtonElement>('[aria-label="在右侧创建 Agent"]')
      expect(button).not.toBeNull()
      await act(async()=>button!.click())
      await act(async()=>vi.waitFor(()=>expect(f.execute).toHaveBeenCalledOnce()))
      const [request]=f.execute.mock.calls[0]!
      const resource=useAppStore.getState().config!.workspaces.find(item=>item.id===request.content.executionWorkspaceId)
      expect(resource?.path).toBe(join(f.home,'.agentmux/survey',P1))
      expect(f.native).toHaveBeenCalledWith({browserId:'page',expected:{workspaceId:'__scratch__',mode:'normal',profileId:P1}})
      expect((await f.disk()).workspaces.some(item=>item.id===resource!.id)).toBe(true)
    } finally {await act(async()=>root.unmount());host.remove()}
  })
  it('keeps later leave-return navigation during directory preparation while the mounted Browser action still creates', async () => {
    const f=await seed(), original=f.native.getMockImplementation()!
    let release!:()=>void;const gate=new Promise<void>(done=>{release=done})
    f.native.mockImplementation(async input=>{await gate;return await original(input)})
    useAppStore.setState({mainSurface:'survey',activeWorkspaceId:'__scratch__',surveyZoneSelection:{kind:'page',regionId:source.regionId,browserId:'page'}})
    vi.spyOn(api.browser,'create').mockResolvedValue(f.browser);vi.spyOn(api.browser,'restore').mockResolvedValue(f.browser)
    const host=document.createElement('div');document.body.append(host);const root=createClientUiRoot(host)
    try{
      await act(async()=>root.render(createElement(WorkbenchPresentationContext.Provider,{value:{active:true,surface:'survey',reference:source,retainedRegionId:source.regionId}},createElement(BrowserPane,{tab:f.browser,visible:true}))))
      await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="在右侧创建 Agent"]')!.click())
      await vi.waitFor(()=>expect(f.native).toHaveBeenCalledOnce())
      await act(async()=>{useAppStore.getState().setMainSurface('board');useAppStore.getState().setMainSurface('survey')})
      const selected=useAppStore.getState().surveyZoneSelection
      await act(async()=>release())
      await act(async()=>vi.waitFor(()=>expect(f.execute).toHaveBeenCalledOnce()))
      const [request,,options]=f.execute.mock.calls[0]!
      expect(request.operation).toBe('agent.open');expect(options.localFocus).toMatchObject({surface:'survey',reference:source,reveal:false})
      expect(useAppStore.getState().surveyZoneSelection).toBe(selected)
      expect((await f.disk()).workspaces.some(item=>item.id===request.content.executionWorkspaceId)).toBe(true)
    }finally{release();await act(async()=>root.unmount());host.remove()}
  })
  it('does not open a late Options dialog after leave-return navigation during directory preparation', async () => {
    const f=await seed(), original=f.native.getMockImplementation()!
    let release!:()=>void, finished=false;const gate=new Promise<void>(done=>{release=done})
    f.native.mockImplementation(async input=>{await gate;try{return await original(input)}finally{finished=true}})
    useAppStore.setState({mainSurface:'survey',activeWorkspaceId:'__scratch__',surveyZoneSelection:{kind:'page',regionId:source.regionId,browserId:'page'}})
    const draftKey=browserAgentCreationDraftKey('page')
    useLauncherState.getState().setBrowserAgentDraft(draftKey,{prompt:'Original task draft',executorId:'codex',hostId:'local',split:'right'})
    vi.spyOn(api.browser,'create').mockResolvedValue(f.browser);vi.spyOn(api.browser,'restore').mockResolvedValue(f.browser)
    const host=document.createElement('div');document.body.append(host);const root=createClientUiRoot(host)
    try{
      await act(async()=>root.render(createElement(WorkbenchPresentationContext.Provider,{value:{active:true,surface:'survey',reference:source,retainedRegionId:source.regionId}},createElement(BrowserPane,{tab:f.browser,visible:true}))))
      await act(async()=>host.querySelector('[aria-label^="Browser activity:"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
      const option=Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item=>item.textContent==='New Agent options…')!
      expect(option).toBeTruthy();await act(async()=>option.click())
      await vi.waitFor(()=>expect(f.native).toHaveBeenCalledOnce())
      await act(async()=>{useAppStore.getState().setMainSurface('board');useAppStore.getState().setMainSurface('survey')})
      await act(async()=>release())
      await act(async()=>vi.waitFor(()=>expect(finished).toBe(true)))
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(useLauncherState.getState().drafts[draftKey]?.prompt).toBe('Original task draft')
      expect(f.execute).not.toHaveBeenCalled()
    }finally{release();await act(async()=>root.unmount());host.remove()}
  })
  it('does not create or select Scratch after a directory preparation unknown result', async () => {
    const f = await seed(); f.save.mockRejectedValueOnce(new Error('Original directory registration ACK unconfirmed'))
    await expect(createBrowserAgent('page', source, 'survey')).rejects.toThrow('registration')
    expect(f.execute).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabs.tab!.regions.region).toBe(f.browser)
  })
  it('continues a retained old intent on its exact Scratch cwd without reinterpreting the new Profile default', async () => {
    const f = await seed(), requestId = 'old-request'
    const recipient = { kind: 'agent', hostId: 'local', agentSessionId: 'retained-agent', run: { runId: 'retained-run' } } as const
    const intent = { browserId: 'page', navigationId: 'navigation', controlRevision: 1, source, workspaceId: '__scratch__', hostId: 'local',
      executionPath: join(f.home, 'scratch'), messageOperationId: 'original-input', prompt: 'Original task', note: 'Original note', inputStarted: true, recipient }
    useAppStore.setState({ tabs: { tab: createWorkbenchTab('tab', { ...f.browser, agentCreationRequestId: requestId }) },
      spatialRequests: { [requestId]: { purpose: 'browser-agent', agentSessionId: recipient.agentSessionId, browserAgent: intent } } } as never)
    f.execute.mockImplementation(async () => ({ operation: 'space.inspect', request: { report: { agent: { hostId: 'local', cwd: intent.executionPath,
      agentSessionId: recipient.agentSessionId, runId: recipient.run.runId } } } }) as never)
    const inspect = vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue({ status: 'admitted' } as never)
    const outcome = await createBrowserAgent('page', source, 'survey', { task: 'New unsent task' }).catch(error => ({ kind: 'failed', message: String(error) }))
    expect(outcome).toEqual({ kind: 'confirmed' })
    expect(f.native).not.toHaveBeenCalled()
    expect(inspect).toHaveBeenCalledExactlyOnceWith(recipient, expect.objectContaining({ submissionId: 'original-input' }))
    expect(useAppStore.getState().spatialRequests[requestId]?.browserAgent).toBe(intent)
    expect(f.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'space.inspect', target: { requestId } }))
  })
  it('inspects an existing request before preparing a changed Profile or execution directory', async () => {
    const f = await seed()
    useAppStore.setState({ tabs: { tab: createWorkbenchTab('tab', { ...f.browser, agentCreationRequestId: 'original' }) } })
    f.execute.mockImplementation(async request => ({ operation: 'space.inspect', request: { known: false, report: null } }) as never)
    await expect(createBrowserAgent('page', source, 'survey', { task: 'new unsent task' })).rejects.toThrow('original Agent request')
    expect(f.native).not.toHaveBeenCalled()
    expect(f.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'space.inspect', target: { requestId: 'original' } }))
  })
})
