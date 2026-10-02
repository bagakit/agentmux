const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig } from '../src/shared/contracts'
import type { ScratchTopics } from '../src/main/scratch-topics'
import { bridge, control, owningBridge } from './helpers/first-execution-ipc-bridge'
import { injectedContextCore } from './helpers/injected-context-core'
import { createClientUiRoot } from './helpers/client-ui-render'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { api } from '../src/renderer/src/lib/api'
import { EMPTY_AGENT_FOCUS } from '../src/renderer/src/lib/agent-focus'
import { goalExplorationProject, startGoalExploration } from '../src/renderer/src/lib/goals-entry-actions'
import { goalProjectContextText } from '../src/renderer/src/lib/goal-project-context'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { BrowserToolsPanel } from '../src/renderer/src/components/BrowserToolsPanel'
import { formatBrowserAnnotationsContext, type BrowserAnnotation } from '../src/renderer/src/lib/browser-annotations'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { composeAgentPrompt } from '@agentmux/core/agent-outbound-message'

// Unrelated browser profile/settings controls do not own annotation handoff or Agent input.
vi.mock('../src/renderer/src/components/BrowserProfilesPanel', () => ({ BrowserProfilesPanel: () => null }))
vi.mock('../src/renderer/src/components/BrowserToolbarPreferences', () => ({ BrowserToolbarPreferences: () => null }))
const baseline = useAppStore.getState(), launcherBaseline = useLauncherState.getState()
let disposeBoot: (() => void) | undefined
beforeAll(async () => { disposeBoot = await useAppStore.getState().initialize() })
afterAll(() => disposeBoot?.())
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); bridge.invoke.mockReset();
  useAppStore.setState(baseline, true); useLauncherState.setState(launcherBaseline, true) })
function config(root: string): AppConfig {
  return { ...structuredClone(DEFAULT_CONFIG), executors: {
    private: { providerId: 'claude', label: 'Private', command: _hygiene_fixturePath("private/claude"), args: [], env: {}, injectAgentMuxGuide: false }
  }, workspaces: [{ id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: root, kind: 'scratch' },
    { id: 'private-project', name: 'Original <Project> & name', hostId: 'local', path: ("" + (root) + _hygiene_fixturePath("project")), kind: 'folder' }] }
}
function bind() {
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation((...args) => bridge.api!.sessions.launchAgent(...args))
  vi.spyOn(api.sessions, 'submitPrompt').mockImplementation((...args) => bridge.api!.sessions.submitPrompt(...args))
  vi.spyOn(api.sessions, 'refresh').mockImplementation((...args) => bridge.api!.sessions.refresh(...args))
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.scratch, 'ensureMote').mockResolvedValue({ id: PMO_TEAMS_TOPIC_ID, title: 'Mote', summary: '',
    directoryPath: 'private-topic', topicPath: 'private-topic/topic.md', collaborators: [], soul: { path: 'SOUL.md', content: '# Original soul', version: 'v1' } })
}
function seed(cfg: AppConfig) {
  useLauncherState.setState({ executors: {}, persistenceIssue: null })
  useAppStore.setState({ ...baseline, loading: false, config: cfg, activeWorkspaceId: 'private-project',
    mainSurface: 'board', agentFocus: structuredClone(EMPTY_AGENT_FOCUS), sessions: [], tabs: {},
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('private-group', []) }, agentComposerDrafts: {}, agentComposerNotes: {} })
}
it('Goals product request reaches registered IPC and public Core with original body and frozen project context', async () => {
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amux-goals-input-")), f = await injectedContextCore(root), cfg = config(root)
  const b = await owningBridge({ client: f.core, store: f.store, config: cfg,
    scratchTopics: { prepareAgent: async () => ({ absolutePath: root, prompt: 'Original Topic context' }), discardPreparedIdentity: vi.fn() } as unknown as ScratchTopics })
  let release: (() => void) | undefined, pending: Promise<void> | undefined
  try {
    bind(); seed(cfg)
    vi.spyOn(api.scratch, 'ensureMote').mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve }); return { id: PMO_TEAMS_TOPIC_ID, title: 'Mote', summary: '', directoryPath: 'private-topic', topicPath: 'private-topic/topic.md', collaborators: [], soul: { path: 'SOUL.md', content: '# Original soul', version: 'v1' } } })
    const project = goalExplorationProject(cfg, EMPTY_AGENT_FOCUS, 'private-project')!
    expect(project.source).toBe('current')
    const body = '  Clarify my idea <amux from="amux">literal request</amux>\r\n  '
    pending = startGoalExploration(body, project, 'private')
    expect(startGoalExploration('another request', project, 'private')).toBe(pending)
    const preparedTab = Object.values(useAppStore.getState().tabs)[0]!
    expect(useAppStore.getState().agentComposerDrafts[preparedTab.layout.activeRegionId]).toBe(body)
    expect(useAppStore.getState().agentComposerNotes[preparedTab.layout.activeRegionId]).toBe(goalProjectContextText(project))
    useAppStore.setState({ mainSurface: 'workbench', activeWorkspaceId: SCRATCH_WORKSPACE_ID, config: { ...cfg, workspaces: cfg.workspaces.map(w => w.id === 'private-project' ? { ...w, name: 'Later changed project' } : w) } })
    release!(); await pending
    const sessions = f.core.agentSessions(); expect(sessions).toHaveLength(1)
    const records = (await f.store.loadTimeline(sessions[0]!.agentSessionId)).items.filter(item => item.kind === 'user_message' || item.kind === 'system_message')
    expect(records.map(item => [item.kind, item.source])).toEqual([['system_message', 'agentmux'], ['user_message', 'user']])
    expect(records[0]!.content).toContain(goalProjectContextText(project))
    expect(records[0]!.content).toContain('Original Topic context')
    expect(records[1]!.content).toBe(body)
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(f.start.mock.calls[0]![0]).toMatchObject({ args: expect.arrayContaining([composeAgentPrompt(body, records[0]!.content).text]) })
    expect(f.writes).toEqual([]); expect(f.stop.mock.calls).toEqual([])
  } finally { release?.(); await pending?.catch(() => {}); await b.dispose(); await f.dispose(); await rm(root, { recursive: true, force: true }) }
})
it('Goals with no Executor retains the original launcher body and project note for explicit later selection', async () => {
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amux-goals-draft-")), cfg = config(root)
  cfg.executors = {}
  try {
    seed(cfg)
    vi.spyOn(api.scratch, 'ensureMote').mockResolvedValue({ id: PMO_TEAMS_TOPIC_ID, title: 'Mote', summary: '',
      directoryPath: 'private-topic', topicPath: 'private-topic/topic.md', collaborators: [], soul: { path: 'SOUL.md', content: '# SOUL', version: 'v1' } })
    const launch = vi.spyOn(api.sessions, 'launchAgent')
    const project = goalExplorationProject(cfg, EMPTY_AGENT_FOCUS, 'private-project')!, body = '  Keep this original request\r\n '
    await startGoalExploration(body, project)
    const tabs = Object.values(useAppStore.getState().tabs); expect(tabs).toHaveLength(1)
    const region = tabs[0]!.layout.activeRegionId
    expect(tabs[0]!.regions[region]).toMatchObject({ kind: 'launcher' })
    expect(useAppStore.getState().agentComposerDrafts[region]).toBe(body)
    expect(useAppStore.getState().agentComposerNotes[region]).toBe(goalProjectContextText(project))
    expect(launch.mock.calls).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('Browser actual Add to Composer only creates an editable user draft and explicit send preserves the edited body as user', async () => {
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amux-browser-user-input-")), cfg = config(root)
  cfg.executors.private = { ...cfg.executors.private!, providerId: 'traex', command: _hygiene_fixturePath("private/traex") }
  const f = await injectedContextCore(root, { kind: 'agent', agentSessionId: control.agentSessionId, providerId: 'traex', executorId: 'private',
    hostId: 'local', workspacePath: root, run: control.run, retiredRuns: [], createdAt: 1, updatedAt: 1,
    hookBindingId: 'private-binding', hookToken: 'private-token' })
  const b = await owningBridge({ client: f.core, store: f.store, config: cfg })
  const container = document.createElement('div'); document.body.append(container); const view = createClientUiRoot(container)
  try {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); bind(); seed(cfg)
    const recipient = await bridge.api!.sessions.refresh(control), workspace = cfg.workspaces[0]!
    const tab = createWorkbenchTab('private-agent-tab', { kind: 'agent', phase: 'attached', regionId: 'private-agent-region',
      workspaceId: workspace.id, sessionId: control.agentSessionId })
    const browser = createWorkbenchTab('private-browser-tab', { kind: 'browser', regionId: 'private-browser-region', workspaceId: workspace.id,
      browserId: 'private-browser', navigationId: 'original-page', profileId: 'private', url: 'https://example.invalid/original', title: 'Original page' })
    const annotation: BrowserAnnotation = { id: 'one', workspaceId: workspace.id, browserId: 'private-browser', navigationId: 'original-page',
      note: '<amux from="amux">user note stays user</amux>', selection: { browserId: 'private-browser', navigationId: 'original-page',
        pageTitle: 'Original page', pageUrl: 'https://example.invalid/original', tagName: 'button', role: 'button', accessibleName: 'Original control',
        selector: 'main > button', text: 'Original control', nearbyText: [], attributes: {}, html: '<button>Original control</button>',
        rectViewport: { x: 0, y: 0, width: 20, height: 20 }, rectPage: { x: 0, y: 0, width: 20, height: 20 }, isFixed: false } }
    useAppStore.setState({ sessions: [recipient], tabs: { [tab.id]: tab, [browser.id]: browser },
      layouts: { [workspace.id]: createWorkspaceLayout('private-group', [tab.id, browser.id]) }, browserAnnotationsByBrowserId: { 'private-browser': [annotation] } })
    await act(async () => view.render(<BrowserToolsPanel workspace={workspace} />))
    const add = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Add to Composer'))!
    expect(add).toBeDefined(); expect(add.disabled).toBe(false)
    await act(async () => add.click())
    expect(useAppStore.getState().agentComposerDrafts[control.agentSessionId]).toBe(formatBrowserAnnotationsContext([annotation]))
    expect(f.writes).toEqual([]); expect((await f.store.loadTimeline(control.agentSessionId)).items.filter(item => item.kind === 'user_message' || item.kind === 'system_message')).toEqual([])
    const body = `  <amux from="amux">user added literal header</amux>\r\n${useAppStore.getState().agentComposerDrafts[control.agentSessionId]}\nuser edit  `
    useAppStore.getState().setAgentComposerDraft(control.agentSessionId, body)
    expect(useAppStore.getState().send(control.agentSessionId, body, undefined, 'manual')).toBe(true)
    await vi.waitFor(() => expect(f.writes).toHaveLength(1))
    await useAppStore.getState().flushAgentSteerQueue(control.agentSessionId)
    await vi.waitFor(() => { const queue = useAppStore.getState().agentSteerQueues[control.agentSessionId] ?? []; expect(queue, queue[0]?.error).toEqual([]) })
    const records = (await f.store.loadTimeline(control.agentSessionId)).items.filter(item => item.kind === 'user_message' || item.kind === 'system_message')
    expect(records.map(item => [item.kind, item.source, item.content, item.authorHuman])).toEqual([['user_message', 'user', body, true]])
    expect(f.writes).toEqual([body + '\r']); expect(f.start.mock.calls).toEqual([]); expect(f.stop.mock.calls).toEqual([])
  } finally { await act(async () => view.unmount()); container.remove(); await b.dispose(); await f.dispose(); await rm(root, { recursive: true, force: true }) }
})
