// @vitest-environment happy-dom
// Source behavior only. DOM input here is not an OS/native focus or complete Desktop recovery receipt.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { build } from 'vite'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { webcrypto } from 'node:crypto'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { createWorkspaceLayout, moveTabToNewGroup } from '@agentmux/layout'
import { AgentMuxControlServer, parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from '../../../packages/core/src/control-host'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../../../packages/core/src/control'
import { AGENTMUX_CLI_SKILL, agentMuxCommandHelp } from '../../../packages/core/src/agentmux-cli-help'
import type { AppConfig, BrowserSnapshot, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { planControlOpen } from '../src/renderer/src/lib/control'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'

const initial = useAppStore.getState()
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private Source' }],
  executors: {}, workspaces: ['user', 'background'].map(id => ({ id, name: id, hostId: 'local', path: `/${id}`, kind: 'folder' })),
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true,
    viewport: true, saveBookmark: true, more: true } } }
const session: Extract<SessionSnapshot, { kind: 'agent' }> = { id: 'managed-caller', kind: 'agent', providerId: 'codex', executorId: 'source', hostId: 'local',
  workspacePath: '/background', label: 'Source caller', createdAt: 1, updatedAt: 1, processState: 'running',
  agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null,
  status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
  capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'managed-caller', run: { runId: 'source-run' } } }
function page(id: string, url = 'https://generic.invalid/page'): BrowserSnapshot {
  return { id, url, title: 'Source page', canGoBack: false, canGoForward: false, loading: false, profileId: 'default',
    viewport: 'responsive', navigationId: 'source-navigation', error: null, driving: false, appLinkPrompt: null }
}
function selection() {
  const state = useAppStore.getState()
  return { mainSurface: state.mainSurface, activeWorkspaceId: state.activeWorkspaceId, selectedDemandId: state.selectedDemandId,
    projectRailOpen: state.projectRailOpen, agentFocus: state.agentFocus, workbenchSpaceSelection: state.workbenchSpaceSelection,
    retainedSpatialFocus: state.retainedSpatialFocus, workbenchNavigationInputPolicy: state.workbenchNavigationInputPolicy,
    regionCaretFocus: state.regionCaretFocus,
    layouts: Object.fromEntries(Object.entries(state.layouts).map(([id, layout]) => [id, {
      activeGroupId: layout.activeGroupId, groups: layout.groups.map(group => ({ id: group.id,
        activeTabId: group.activeTabId, recentTabIds: group.recentTabIds })) }])),
    regions: Object.fromEntries(Object.entries(state.tabs).map(([id, tab]) => [id, tab.layout.activeRegionId])) }
}
function existingSelection() {
  const picked = selection()
  // New background tabs have their own local Region. They do not count as replacing an existing human choice.
  return { ...picked, regions: Object.fromEntries(Object.entries(picked.regions).filter(([id]) => !id.startsWith('view:'))) }
}
function open(destination: unknown) {
  return parseAgentMuxControlRequest({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: crypto.randomUUID(),
    operation: 'open.browser', url: 'https://generic.invalid/page', destination })
}
let userInput: HTMLTextAreaElement
let root: string, cli: string
beforeAll(async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  root = await mkdtemp(resolve('.tmp/browser-nonactivating-source-'))
  cli = join(root, 'source-cli.mjs')
  await build({ configFile: false, logLevel: 'silent', plugins: [{ name: 'actual-public-cli-source', enforce: 'pre', transform(source, id) {
    const path = id.split('?')[0]!
    if (!path.startsWith(resolve('packages/core/src') + '/')) return
    let code = source
    if (process.env.AGENTMUX_BROWSER_NONACTIVATING_MUTATION === 'cli-browser-op-misdirected' && path === resolve('packages/core/src/agentmux.ts')) {
      const block = ": await requestAgentMuxControl({ ...requestBase(), operation: 'open.browser',"
      assert.equal(source.split(block).length - 1, 1, 'Unique actual CLI Browser request construction')
      code = source.replace(block, ": await requestAgentMuxControl({ ...requestBase(), operation: 'open.terminal',")
    }
    if (process.env.AGENTMUX_BROWSER_NONACTIVATING_LOADED) appendFileSync(process.env.AGENTMUX_BROWSER_NONACTIVATING_LOADED,
      JSON.stringify({ path: path.slice(resolve('.').length + 1), consumer: 'public-source-cli-ssr',
        sourceSha256: createHash('sha256').update(source).digest('hex'), loadedSha256: createHash('sha256').update(code).digest('hex'),
        ...(code !== source ? { mutation: 'cli-browser-op-misdirected' } : {}) }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }], build: { ssr: true, minify: false, emptyOutDir: false, outDir: root,
    rollupOptions: { input: resolve('packages/core/src/agentmux.ts'), output: { format: 'es', entryFileNames: 'source-cli.mjs' } } } })
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  const user = createWorkbenchTab('user-tab', { kind: 'file', regionId: 'user-region', workspaceId: 'user', path: 'note.md' })
  const other = createWorkbenchTab('user-other', { kind: 'file', regionId: 'user-other-region', workspaceId: 'user', path: 'other.md' })
  const anchor = createWorkbenchTab('background-anchor', { kind: 'agent', phase: 'attached', regionId: 'background-region',
    workspaceId: 'background', sessionId: session.id })
  const selected = createWorkbenchTab('background-selected', { kind: 'launcher', regionId: 'background-selected-region', workspaceId: 'background' })
  const background = moveTabToNewGroup(createWorkspaceLayout('background-group', [selected.id, anchor.id]), selected.id,
    'background-group', 'background-group', 'right', 'background-selected-group')
  expect(background.groups).toHaveLength(2)
  const layouts = { user: createWorkspaceLayout('user-group', [user.id, other.id]), background }
  useAppStore.setState({ ...initial, config, sessions: [session], activeWorkspaceId: 'user', mainSurface: 'board',
    selectedDemandId: 'user-goal', projectRailOpen: false, tabs: { [user.id]: user, [other.id]: other,
      [anchor.id]: anchor, [selected.id]: selected }, layouts,
    regionCaretFocus: { regionId: 'user-region', nonce: 7 }, workbenchNavigationInputPolicy: 'preserve' }, true)
  await initializeSpatialControlFixture()
  userInput = document.createElement('textarea'); userInput.value = 'unsent draft'; document.body.append(userInput)
  userInput.focus(); userInput.setSelectionRange(2, 5)
  vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => page(id, url))
})
afterEach(() => { userInput?.remove(); vi.restoreAllMocks(); useAppStore.setState(initial, true) })
function retained(before = existingSelection()) {
  expect(existingSelection()).toEqual(before)
  expect(document.activeElement).toBe(userInput)
  expect([userInput.value, userInput.selectionStart, userInput.selectionEnd]).toEqual(['unsent draft', 2, 5])
  expect(useAppStore.getState().sessions).toEqual([session])
}

describe('actual Control Browser open preserves the existing selection', () => {
  it('places a background split without choosing its Region, Tab or workspace', async () => {
    const before = existingSelection()
    const result = await useAppStore.getState().executeControl(open({ kind: 'split', direction: 'right',
      region: { kind: 'region', regionId: 'background-region' } }))
    expect(result).toMatchObject({ operation: 'open.browser', region: { workspaceId: 'background', tabId: 'background-anchor' } })
    if (result.operation !== 'open.browser') throw new Error('Expected Browser result')
    expect(useAppStore.getState().tabs[result.region.tabId]!.regions[result.region.regionId]).toMatchObject({ kind: 'browser', browserId: result.region.browserId })
    retained(before)
  })
  it('adds a background Tab without changing the selected Tab, group or recency', async () => {
    const before = existingSelection()
    const result = await useAppStore.getState().executeControl(open({ kind: 'new-tab', after: { kind: 'tab', tabId: 'background-anchor' } }))
    if (result.operation !== 'open.browser') throw new Error('Expected Browser result')
    expect(useAppStore.getState().layouts.background!.groups[0]!.tabOrder).toContain(result.region.tabId)
    expect(Object.keys(useAppStore.getState().tabs)).toHaveLength(5)
    retained(before)
  })
  it('uses the same preserving path for a managed self selector', async () => {
    const before = existingSelection()
    const request = parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'managed-self', operation: 'open.browser',
      url: 'https://generic.invalid/page', caller: { agentSessionId: session.id },
      destination: { kind: 'split', direction: 'down', region: { kind: 'self' } } })
    expect(await useAppStore.getState().executeControl(request)).toMatchObject({ operation: 'open.browser' })
    retained(before)
  })
  it('fills an explicit background Launcher without selecting it', async () => {
    const before = existingSelection()
    const result = await useAppStore.getState().executeControl(open({ kind: 'launcher', regionId: 'background-selected-region' }))
    expect(result).toMatchObject({ operation: 'open.browser', region: { regionId: 'background-selected-region' } })
    retained(before)
  })
  it('does not steal a user choice or caret when create completes late', async () => {
    let release!: (page: BrowserSnapshot) => void
    let issued = ''
    vi.mocked(api.browser.create).mockImplementation(id => { issued = id; return new Promise(resolve => { release = resolve }) })
    const pending = useAppStore.getState().executeControl(open({ kind: 'new-tab', after: { kind: 'tab', tabId: 'background-anchor' } }))
    useAppStore.getState().focusRegion('user', 'user-other', 'user-other-region', 'pointer')
    const before = existingSelection()
    release(page(issued)); expect(await pending).toMatchObject({ operation: 'open.browser' })
    retained(before)
  })
  it('rolls back only its own failed placement, preserving the later human selection', async () => {
    let reject!: (error: Error) => void
    vi.mocked(api.browser.create).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    const close = vi.spyOn(api.browser, 'close').mockResolvedValue()
    const pending = useAppStore.getState().executeControl(open({ kind: 'new-tab', after: { kind: 'tab', tabId: 'background-anchor' } }))
    const rejected = expect(pending).rejects.toThrow('Main create unavailable')
    useAppStore.getState().focusRegion('user', 'user-other', 'user-other-region', 'pointer')
    const before = existingSelection()
    reject(new Error('Main create unavailable')); await rejected
    retained(before); expect(close).not.toHaveBeenCalled(); expect(Object.keys(useAppStore.getState().tabs)).toHaveLength(4)
  })
  it('does not reselect an unchanged Launcher after the human selects its neighboring Region', async () => {
    const target = useAppStore.getState().tabs['background-selected']!
    const sibling = { kind: 'file' as const, regionId: 'human-sibling', workspaceId: 'background', path: 'human.md' }
    const { addWorkbenchRegion } = await import('../src/renderer/src/lib/workbench-tabs')
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [target.id]: addWorkbenchRegion(target, 'background-selected-region', 'right', sibling) } }))
    let reject!: (error: Error) => void
    vi.mocked(api.browser.create).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    const pending = useAppStore.getState().executeControl(open({ kind: 'launcher', regionId: 'background-selected-region' }))
    const rejected = expect(pending).rejects.toThrow('Main create unavailable')
    useAppStore.getState().focusRegion('background', 'background-selected', 'human-sibling', 'pointer')
    const before = existingSelection()
    reject(new Error('Main create unavailable')); await rejected
    retained(before)
  })
  it('retains original UI open and Terminal placement selection intent', async () => {
    useAppStore.setState({ mainSurface: 'workbench' })
    await useAppStore.getState().createBrowser('user-group')
    const selectedId = useAppStore.getState().layouts.user!.groups[0]!.activeTabId!
    expect(useAppStore.getState().tabs[selectedId]!.regions).toEqual(expect.objectContaining({
      [useAppStore.getState().tabs[selectedId]!.layout.activeRegionId]: expect.objectContaining({ kind: 'browser' }) }))
    const state = useAppStore.getState()
    const terminal = planControlOpen(state, { kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'background-region' } },
      undefined, 'terminal-tab', 'terminal-region', 'open.terminal')
    expect(terminal.tabs['background-anchor']!.layout.activeRegionId).toBe('terminal-region')
    expect(terminal.layouts.background!.groups[0]!.activeTabId).toBe('background-anchor')
  })
})

describe('the real pending Launcher consumes Region input selection', () => {
  async function mount(tabId?: string, regionId?: string) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const container = document.createElement('div')
    if (regionId) container.dataset.workbenchRegionId = regionId
    document.body.append(container)
    const reactRoot = createRoot(container)
    await act(async () => reactRoot.render(createElement(WorkbenchPresentationContext.Provider,
      { value: { active: true, retainedRegionId: null } },
      createElement(NewTabSurface, { tabGroupId: 'user-group', ...(tabId === undefined ? {} : { tabId }),
        ...(regionId === undefined ? {} : { regionId }), visible: true }))))
    const editor = container.querySelector<HTMLElement>('.launcher-composer .tiptap')
    expect(editor).not.toBeNull()
    // InlineComposer calls the real TipTap focus command, which is scheduled in a native RAF.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    return { editor: editor!, async unmount() { await act(async () => reactRoot.unmount()); container.remove() } }
  }
  const launcherInitial = useLauncherState.getState()
  beforeEach(() => {
    useLauncherState.setState({ sections: { user: { agents: 'expanded', terminal: 'hidden' } } })
    useAppStore.setState({ mainSurface: 'workbench', workbenchNavigationInputPolicy: null,
      workbenchSpaceSelection: null, prewarmTerminal: vi.fn(), detectExecutors: vi.fn(async () => {}) })
  })
  afterEach(() => useLauncherState.setState(launcherInitial, true))
  it('keeps the original rich-input owner while a visible CLI split Launcher mounts in the active Tab', async () => {
    let release!: (page: BrowserSnapshot) => void, issued = ''
    vi.mocked(api.browser.create).mockImplementation(id => { issued = id; return new Promise(resolve => { release = resolve }) })
    const pending = useAppStore.getState().executeControl(open({ kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'user-region' } }))
    const tab = useAppStore.getState().tabs['user-tab']!
    const pendingLaunchers = Object.values(tab.regions).filter(surface => surface.kind === 'launcher')
    expect(pendingLaunchers).toHaveLength(1)
    expect(tab.layout.activeRegionId).toBe('user-region')
    const before = existingSelection()
    const dom = await mount(tab.id, pendingLaunchers[0]!.regionId)
    try {
      expect(document.activeElement).toBe(userInput)
      retained(before)
    } finally {
      await dom.unmount(); release(page(issued)); await pending
    }
  })
  it('keeps human-selected Launcher and empty-group input available through the original autoFocus path', async () => {
    const target = createWorkbenchTab('human-launcher', { kind: 'launcher', regionId: 'human-input', workspaceId: 'user' })
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [target.id]: target }, regionCaretFocus: null }))
    const selected = await mount(target.id, 'human-input')
    try { expect(document.activeElement).toBe(selected.editor) } finally { await selected.unmount() }
    userInput.focus()
    const empty = await mount()
    try { expect(document.activeElement).toBe(empty.editor) } finally { await empty.unmount() }
  })
  it('consumes the existing preserve input policy even for a selected Launcher', async () => {
    const target = createWorkbenchTab('human-launcher', { kind: 'launcher', regionId: 'human-input', workspaceId: 'user' })
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [target.id]: target }, regionCaretFocus: null,
      workbenchNavigationInputPolicy: 'preserve' }))
    const dom = await mount(target.id, 'human-input')
    try { expect(document.activeElement).toBe(userInput) } finally { await dom.unmount() }
  })
  it('does not start detection, launch a PTY or replace a healthy warm Run for the unselected CLI Launcher', async () => {
    const warm = { ...session, id: 'healthy-source-warm', kind: 'terminal' as const, providerId: null,
      control: { kind: 'terminal' as const, hostId: 'local', runId: 'healthy-source-warm-run', run: { runId: 'healthy-source-warm-run' } } }
    const prewarm = vi.fn(initial.prewarmTerminal), detect = vi.fn(initial.detectExecutors)
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue(warm)
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()
    const detection = vi.spyOn(api.executors, 'detect').mockRejectedValue(new Error('Source detection unconfirmed'))
    useLauncherState.setState({ sections: { user: { agents: 'expanded', terminal: 'expanded' } } })
    useAppStore.setState({ config: { ...config, executors: { codex: { label: 'Source Codex', providerId: 'codex',
      command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } } }, executorDetections: {},
      prewarmTerminal: prewarm, detectExecutors: detect,
      warmTerminal: { key: 'local:/background', ownerLauncherId: 'region:original-warm', ready: Promise.resolve(warm), session: warm } })
    let release!: (page: BrowserSnapshot) => void, issued = ''
    vi.mocked(api.browser.create).mockImplementation(id => { issued = id; return new Promise(resolve => { release = resolve }) })
    const pending = useAppStore.getState().executeControl(open({ kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'user-region' } }))
    const tab = useAppStore.getState().tabs['user-tab']!
    const launchers = Object.values(tab.regions).filter(surface => surface.kind === 'launcher')
    expect(launchers).toHaveLength(1)
    const dom = await mount(tab.id, launchers[0]!.regionId)
    try {
      expect([prewarm.mock.calls.length, detect.mock.calls.length, launch.mock.calls.length, stop.mock.calls.length,
        detection.mock.calls.length]).toEqual([0, 0, 0, 0, 0])
      expect(useAppStore.getState().warmTerminal?.session).toBe(warm)
      expect(useAppStore.getState().warmTerminal?.ownerLauncherId).toBe('region:original-warm')
      expect(useAppStore.getState().sessions).toEqual([session])
    } finally { await dom.unmount(); release(page(issued)); await pending }
  })
  it('retains the actual prewarm and detection consumers for a human-selected Launcher', async () => {
    const target = createWorkbenchTab('human-launcher', { kind: 'launcher', regionId: 'human-input', workspaceId: 'user' })
    const warm = { ...session, id: 'new-source-warm', kind: 'terminal' as const, providerId: null,
      control: { kind: 'terminal' as const, hostId: 'local', runId: 'new-source-warm-run', run: { runId: 'new-source-warm-run' } } }
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue(warm)
    const detection = vi.spyOn(api.executors, 'detect').mockRejectedValue(new Error('Source detection unconfirmed'))
    useLauncherState.setState({ sections: { user: { agents: 'expanded', terminal: 'expanded' } } })
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [target.id]: target }, regionCaretFocus: null, warmTerminal: null,
      config: { ...config, executors: { codex: { label: 'Source Codex', providerId: 'codex', command: 'codex',
        args: [], env: {}, injectAgentMuxGuide: true } } }, executorDetections: {},
      prewarmTerminal: initial.prewarmTerminal, detectExecutors: initial.detectExecutors }))
    const dom = await mount(target.id, 'human-input')
    try {
      expect(launch).toHaveBeenCalledOnce(); expect(detection).toHaveBeenCalledOnce()
      expect(useAppStore.getState().warmTerminal?.session).toBe(warm)
      expect(document.activeElement).toBe(dom.editor)
    } finally { await dom.unmount() }
  })
})

describe('public Source CLI consumes the existing Browser owner', () => {
  async function run(args: string[], input = '') {
    return await new Promise<{ code: number; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: root,
        AGENTMUX_STATE_DIRECTORY: join(root, 'state'), AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined },
        stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('Private Source CLI timed out')) }, 10_000)
      child.stdout.setEncoding('utf8').on('data', value => { stdout += value })
      child.stderr.setEncoding('utf8').on('data', value => { stderr += value })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => { clearTimeout(timer); resolveResult({ code: code ?? -1, stdout, stderr }) })
      child.stdin.end(input)
    })
  }
  it('actual argv → private socket → Store opens, inspects and runs without selecting the Browser', async () => {
    const before = existingSelection(), seen: string[] = []
    const server = new AgentMuxControlServer({ async execute(request) {
      seen.push(request.operation)
      return await useAppStore.getState().executeControl(request)
    } }, join(root, 'control.sock'))
    const runScript = vi.spyOn(api.browser, 'runScript').mockResolvedValue({ result: { websiteChanged: true }, logs: ['Source result'],
      outcome: { kind: 'completed' }, runOperation: { id: 'source-operation', browserId: 'source-browser',
        operator: { id: 'source-agent', name: 'Source agent' }, startedAt: 1, phase: 'completed', summary: 'Source only',
        url: 'https://generic.invalid/page', steps: [] } })
    await server.start()
    try {
      const opened = await run(['open', 'browser', '--url', 'https://generic.invalid/page', '--tab', 'background-anchor', '--new-tab'])
      expect(opened.code, opened.stderr).toBe(0)
      const receipt = parseAgentMuxControlReceipt(JSON.parse(opened.stdout))
      expect(receipt).toMatchObject({ ok: true, operation: 'open.browser' })
      if (!receipt.ok || receipt.operation !== 'open.browser') throw new Error('Expected typed Browser open')
      const found = await run(['inspect', '--region', receipt.result.region.regionId])
      expect(found.code, found.stderr).toBe(0)
      expect(JSON.parse(found.stdout)).toMatchObject({ result: { region: { browserId: receipt.result.region.browserId } } })
      const code = 'await gotoUrl("https://generic.invalid/next"); return await snapshot()'
      const driven = await run(['browser', 'run', '--browser', receipt.result.region.browserId], code)
      expect(driven.code, driven.stderr).toBe(0)
      expect(JSON.parse(driven.stdout)).toMatchObject({ result: { result: { websiteChanged: true }, outcome: { kind: 'completed' } } })
      expect(runScript).toHaveBeenCalledWith(receipt.result.region.browserId, code, undefined, undefined)
      expect(seen).toEqual(['open.browser', 'inspect.region', 'browser.run'])
      retained(before)
    } finally { await server.stop() }
  })
  it('keeps the durable Browser and healthy Source session when its owner is unknown', async () => {
    const browser = { ...page('durable-browser'), kind: 'browser' as const, regionId: 'durable-region', workspaceId: 'background', browserId: 'durable-browser' }
    const tab = createWorkbenchTab('durable-tab', browser)
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [tab.id]: tab } }))
    const before = selection()
    const runScript = vi.spyOn(api.browser, 'runScript').mockRejectedValue(new Error('Unknown browser'))
    const close = vi.spyOn(api.browser, 'close').mockResolvedValue()
    const request = parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'unknown-original', operation: 'browser.run', browserId: browser.id, code: 'return await snapshot()' })
    await expect(useAppStore.getState().executeControl(request)).rejects.toThrow('Unknown browser')
    expect(selection()).toEqual(before); expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
    expect(useAppStore.getState().sessions).toEqual([session]); expect(runScript).toHaveBeenCalledTimes(1)
    expect(api.browser.create).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
  })
  it('projects Browser progress locally without selecting another Tab', () => {
    const browser = { ...page('durable-browser'), kind: 'browser' as const, regionId: 'durable-region', workspaceId: 'background', browserId: 'durable-browser' }
    const tab = createWorkbenchTab('durable-tab', browser)
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [tab.id]: tab } }))
    const before = selection(), layouts = useAppStore.getState().layouts
    useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...page(browser.id), driving: true } })
    expect(useAppStore.getState().tabs[tab.id]!.regions[browser.regionId]).toMatchObject({ driving: true })
    expect(useAppStore.getState().layouts).toBe(layouts); expect(selection()).toEqual(before)
    useAppStore.getState().applyBrowserEvent({ type: 'unavailable', id: browser.id, error: 'Owner observation unconfirmed' })
    expect(useAppStore.getState().tabs[tab.id]!.regions[browser.regionId]).toMatchObject({ nativeOwnerUnavailable: true })
    expect(selection()).toEqual(before)
  })
  it('generates the discover-first CLI route and rejects GUI fallback without a second capability list', () => {
    const skill = AGENTMUX_CLI_SKILL.replace(/\s+/g, ' ')
    expect(skill.length).toBeGreaterThan(0)
    expect(skill).toContain('First inspect the exact Tab/Region and read its typed Browser id')
    expect(skill).toContain('or use GUI input to get around that result.')
    expect(skill).toContain('explicit focus is a separate navigation action.')
    expect(agentMuxCommandHelp('open.browser')).toContain('preserves the current Workbench selection')
  })
})
