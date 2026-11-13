import { createRoot } from 'react-dom/client'
import { addTab, createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import type { AppConfig, BrowserSnapshot, SessionSnapshot } from '../../../src/shared/contracts'
import { BrowserPane } from '../../../src/renderer/src/components/BrowserPane'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { WorkbenchDocumentContext } from '../../../src/renderer/src/lib/workbench-document'
import { WorkbenchPresentationContext } from '../../../src/renderer/src/lib/workbench-presentation'
import { useNativeOverlayChrome } from '../../../src/renderer/src/hooks/useNativeOverlayChrome'
import { createWorkbenchTab, type BrowserWorkbenchSurface } from '../../../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { useLauncherState, checkpointLauncherState } from '../../../src/renderer/src/lib/launcher-state'
import { browserAgentCreationDraftKey, createBrowserAgent } from '../../../src/renderer/src/lib/browser-agent-creation'
import '../../../src/renderer/src/styles/index.css'

const browserId = 'handoff-browser', tabId = 'handoff-tab', regionId = 'handoff-browser-region', workspaceId = 'handoff-workspace'
const reference = { displayWorkspaceId: workspaceId, groupId: 'handoff-group', tabId, regionId }
const creationScene = { browserId: 'handoff-create-browser', tabId: 'handoff-create-tab', regionId: 'handoff-create-browser-region',
  reference: { ...reference, tabId: 'handoff-create-tab', regionId: 'handoff-create-browser-region' } }
let activeScene = { browserId, tabId, regionId, reference }
const root = createRoot(document.getElementById('root')!), errors: string[] = []
let startup: (() => void) | undefined, stopTheme: (() => void) | undefined, identity: Awaited<ReturnType<typeof api.ui.workbenchWindows.ready>>
let phase: 'first' | 'restart' = 'first', availableSessions: SessionSnapshot[] = []

function ownedBrowser(): BrowserWorkbenchSurface {
  const browser = useAppStore.getState().tabs[tabId]?.regions[regionId]
  if (browser?.kind !== 'browser' || browser.browserId !== browserId) throw new Error('The original handoff Browser Region was not restored.')
  return browser
}
function candidates(count: number) {
  if (phase !== 'first') throw new Error('Restart reads the original saved workface; it cannot seed candidate Regions again.')
  const browser = ownedBrowser(), next = createWorkbenchTab(tabId, browser)
  for (const [index, session] of availableSessions.filter(item => item.kind === 'agent').slice(0, count).entries()) {
    const region = `handoff-agent-region-${index}`
    next.layout = splitWorkbenchRegion(next.layout, regionId, 'right', region)
    next.regions[region] = { kind: 'agent', phase: 'attached', sessionId: session.id, regionId: region, workspaceId }
  }
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [tabId]: next } }))
}
function Fixture() {
  const scene = activeScene
  const browser = useAppStore(state => state.tabs[scene.tabId]?.regions[scene.regionId])
  const sessions = useAppStore(state => state.sessions)
  const warning = useNativeOverlayChrome(document, identity)
  return <WorkbenchDocumentContext.Provider value={{ document, window: identity }}><DesktopClientUiProvider>
    <WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, surface: 'space', reference: scene.reference }}>
      <main className="handoff-fixture">
        <header><strong>Browser collaboration</strong><span>Private product scene · original page and Core Sessions</span></header>
        <div className="handoff-fixture__body">
          <aside><small>Sessions in this scene</small>{sessions.filter(item => item.kind === 'agent').map(session => <div key={session.id}><strong>{session.label}</strong><span>{session.control.hostId}</span></div>)}</aside>
          <section className="handoff-fixture__browser" data-workbench-region-id={scene.regionId}>
            {browser?.kind === 'browser' ? <BrowserPane tab={browser} visible /> : <p role="status">Original Browser Region is unavailable.</p>}
          </section>
        </div>{warning ? <p role="status">{warning}</p> : null}
      </main>
    </WorkbenchPresentationContext.Provider>
  </DesktopClientUiProvider></WorkbenchDocumentContext.Provider>
}
const style = document.createElement('style')
style.textContent = `html,body,#root{height:100%;margin:0;overflow:hidden}.handoff-fixture{height:100%;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font-family:var(--font-ui)}.handoff-fixture>header{height:42px;flex:none;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 16px;border-bottom:1px solid var(--line);font-size:12px}.handoff-fixture>header>span{color:var(--text-3);font-size:11px}.handoff-fixture__body{flex:1;min-height:0;display:grid;grid-template-columns:180px minmax(0,1fr)}.handoff-fixture aside{padding:14px;border-right:1px solid var(--line)}.handoff-fixture aside>small{color:var(--text-3);font-size:10px}.handoff-fixture aside>div{display:grid;gap:4px;margin-top:14px;font-size:12px}.handoff-fixture aside>div>span{color:var(--text-3);font-size:10px}.handoff-fixture__browser{height:100%;min-width:0;min-height:0}.handoff-fixture__browser>.browser-surface{height:100%}@media(max-width:700px){.handoff-fixture__body{grid-template-columns:minmax(0,1fr)}.handoff-fixture aside{display:none}.handoff-fixture>header>span{display:none}}`
document.head.append(style)

Object.assign(window, { browserHandoffFixture: {
  async setup(input: { config: AppConfig; browser: BrowserSnapshot; sessions: SessionSnapshot[]; phase?: 'first' | 'restart'; theme?: 'dark' | 'light'; candidateCount?: number }) {
    phase = input.phase ?? 'first'; availableSessions = input.sessions
    startup = await useAppStore.getState().initialize()
    identity = await api.ui.workbenchWindows.ready()
    stopTheme = mountThemeRuntime(window, { ...input.config.appearance, appAppearance: input.theme ?? 'dark' })
    const reportError = useAppStore.getState().reportError
    useAppStore.setState({ reportError(error, context) { errors.push(error instanceof Error ? error.message : String(error)); reportError(error, context) } })
    if (phase === 'first') {
      const browser: BrowserWorkbenchSurface = { ...input.browser, kind: 'browser', browserId, regionId, workspaceId }
      const tab = createWorkbenchTab(tabId, browser)
      useAppStore.setState({ config: input.config, sessions: input.sessions, tabs: { [tabId]: tab },
        layouts: { [workspaceId]: createWorkspaceLayout(reference.groupId, [tabId]) }, activeWorkspaceId: workspaceId,
        loading: false, mainSurface: 'workbench', toolsOpen: false, error: null })
      candidates(input.candidateCount ?? input.sessions.length)
    } else {
      ownedBrowser()
      // Refresh current Core facts only. Durable Regions, layout and drafts come from initialize().
      useAppStore.setState({ config: input.config, sessions: input.sessions, loading: false, toolsOpen: false })
    }
    root.render(<Fixture />)
    return this.inspect()
  },
  setCandidateCount(count: number) { candidates(count); return this.inspect() },
  showCreationScene(input: { browser: BrowserSnapshot }) {
    if (input.browser.id !== creationScene.browserId || input.browser.control?.owner !== 'human' || input.browser.control.agent !== null) {
      throw new Error('Creation scene requires its own Main-confirmed, unassociated Browser identity.')
    }
    const state = useAppStore.getState()
    if (state.tabs[creationScene.tabId]) throw new Error('The original creation scene already exists; inspect it instead of replacing it.')
    const browser: BrowserWorkbenchSurface = { ...input.browser, kind: 'browser', browserId: creationScene.browserId, regionId: creationScene.regionId, workspaceId }
    useAppStore.setState({ tabs: { ...state.tabs, [creationScene.tabId]: createWorkbenchTab(creationScene.tabId, browser) },
      layouts: { ...state.layouts, [workspaceId]: addTab(state.layouts[workspaceId]!, reference.groupId, creationScene.tabId) } })
    activeScene = creationScene; root.render(<Fixture />)
    return this.inspectCreation()
  },
  showOriginal() { activeScene = { browserId, tabId, regionId, reference }; root.render(<Fixture />); return this.inspect() },
  async recheckCreation() { return createBrowserAgent(creationScene.browserId, creationScene.reference) },
  inspectCreation() {
    const state = useAppStore.getState(), browser = state.tabs[creationScene.tabId]?.regions[creationScene.regionId]
    return { browser, tab: state.tabs[creationScene.tabId], sessions: state.sessions, spatialRequests: state.spatialRequests,
      queues: state.agentSteerQueues, creationDraft: useLauncherState.getState().drafts[browserAgentCreationDraftKey(creationScene.browserId)],
      notice: document.querySelector('.service-window')?.textContent, errors: errors.slice() }
  },
  appearance(mode: 'dark' | 'light') { updateThemeSelection({ ...useAppStore.getState().config!.appearance, appAppearance: mode }) },
  async persist(text = 'Keep this Browser opinion with its original Agent.') {
    const state = useAppStore.getState(), original = state.browserOpinionDrafts[browserId]
    const session = availableSessions.find(item => item.kind === 'agent')
    if (!original && session?.kind !== 'agent') throw new Error('The exact original Agent is required to capture the retained draft.')
    await state.saveBrowserOpinionDraft(browserId, original ?? { original: { browserId, control: session!.control as Extract<SessionSnapshot, { kind: 'agent' }>['control'],
      name: session!.label, operationId: undefined }, text, includeContext: false, pending: null }, true)
    await checkpointLauncherState()
    return this.inspect()
  },
  inspect() {
    const state = useAppStore.getState(), browser = state.tabs[tabId]?.regions[regionId]
    return { phase, browser, tab: state.tabs[tabId], layout: state.layouts[workspaceId], draft: state.browserOpinionDrafts[browserId],
      creationDraft: useLauncherState.getState().drafts[browserAgentCreationDraftKey(browserId)], errors: errors.slice(),
      buttons: Array.from(document.querySelectorAll<HTMLButtonElement>('.browser-toolbar button')).map(button => ({ label: button.getAttribute('aria-label'),
        text: button.textContent, disabled: button.disabled, bounds: button.getBoundingClientRect().toJSON() })),
      notice: document.querySelector('.service-window')?.textContent, menu: document.querySelector('[role="menu"]')?.textContent }
  },
  click(selector: string) {
    const node = document.querySelector<HTMLElement>(selector)
    if (!node) throw new Error('The requested visible Browser control is absent: ' + selector)
    node.click(); return true
  },
  dispose() { root.unmount(); startup?.(); stopTheme?.(); style.remove(); return { errors: errors.slice() } }
} })
