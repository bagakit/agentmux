// @vitest-environment happy-dom
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { AgentMuxControlServer, parseAgentMuxControlReceipt } from '../../../packages/core/src/control-host.js'
import { isLongAgentMuxControlOperation, type AgentMuxControlRequest } from '../../../packages/core/src/control.js'
import { parseSpaceControlRequest } from '../../../packages/core/src/space-control-parser.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { prepareRendererUpdate, useAppStore } from '../src/renderer/src/store.js'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs.js'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture.js'

const exec = promisify(execFile)
const cli = join(process.cwd(), 'packages/core/bin/agentmux')
const original = useAppStore.getState()
const sid = 'agent-name-exact'
const tabId = 'tab-name-exact'
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [
    { id: 'execution', name: 'Execution', hostId: 'local', path: '/tmp/name-execution', kind: 'folder' },
    { id: 'display', name: 'Display', hostId: 'local', path: '/tmp/name-display', kind: 'folder' }
  ], appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const agent: SessionSnapshot = {
  id: sid, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local',
  workspacePath: '/tmp/name-execution', label: 'Original', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1,
  capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
  control: { kind: 'agent', hostId: 'local', agentSessionId: sid, run: { runId: 'run-name-exact' } }
}

// Real compiled public bin -> Unix Control -> real Store owner -> real storage flush.
// Runtime/config/flush APIs supply explicit synthetic facts only; no user App or Run is controlled.
describe('Desktop display names through the compiled public CLI', () => {
  let server: AgentMuxControlServer
  let env: NodeJS.ProcessEnv
  let seen: AgentMuxControlRequest[]
  let before: ReturnType<typeof protectedFacts>
  let snapshot: ReturnType<typeof vi.spyOn>
  let agentRename: ReturnType<typeof vi.spyOn>
  let tabRename: ReturnType<typeof vi.spyOn>
  let flush: ReturnType<typeof vi.spyOn>
  let otherSessionCalls: MockInstance[]

  function protectedFacts() {
    const state = useAppStore.getState()
    return structuredClone({ sessions: state.sessions, layouts: state.layouts,
      tabs: Object.fromEntries(Object.entries(state.tabs).map(([id, { name: _name, ...tab }]) => [id, tab])),
      activeWorkspaceId: state.activeWorkspaceId, mainSurface: state.mainSurface, agentFocus: state.agentFocus,
      regionCaretFocus: state.regionCaretFocus, drafts: state.agentComposerDrafts })
  }
  function noFactsOrLifecycle() {
    expect(snapshot).not.toHaveBeenCalled()
    for (const call of otherSessionCalls) expect(call).not.toHaveBeenCalled()
    expect(protectedFacts()).toEqual(before)
  }
  beforeEach(async () => {
    vi.restoreAllMocks()
    localStorage.clear()
    useAppStore.setState(original, true)
    let tab = createWorkbenchTab(tabId, { regionId: 'region-name-a', kind: 'agent', phase: 'attached', workspaceId: 'execution', sessionId: sid })
    tab = addWorkbenchRegion(tab, 'region-name-a', 'right', {
      regionId: 'region-name-b', kind: 'agent', phase: 'attached', workspaceId: 'execution', sessionId: sid
    })
    // The display Workspace differs from both Regions' execution resource. Rename targets the entity.
    tab = { ...tab, workspaceId: 'display' }
    useAppStore.setState({ config, sessions: [agent], tabs: { [tabId]: tab },
      layouts: { display: createWorkspaceLayout('name-group', [tabId]) }, activeWorkspaceId: 'execution',
      mainSurface: 'workbench', loading: false, agentNames: {}, agentComposerDrafts: { [sid]: 'Keep this draft\n草稿' },
      spaceZoneBindings: {}, spatialRequests: {}, pendingAgentLaunches: {}, error: null })
    await initializeSpatialControlFixture()
    snapshot = vi.mocked(api.sessions.snapshot)
    snapshot.mockClear()
    otherSessionCalls = ['launchAgent', 'launchTerminal', 'creation', 'timeline', 'historyPage', 'recover', 'resume', 'refresh', 'stop', 'submitPrompt', 'attach'].map(
      name => vi.spyOn(api.sessions, name as keyof typeof api.sessions))
    agentRename = vi.spyOn(useAppStore.getState(), 'renameAgent')
    tabRename = vi.spyOn(useAppStore.getState(), 'renameTab')
    flush = vi.mocked(api.ui.requestStorageFlush)
    flush.mockClear()
    seen = []
    before = protectedFacts()
    expect(before.sessions.map(item => item.id)).toEqual([sid])
    expect(Object.keys(before.tabs)).toEqual([tabId])
    expect(Object.keys(before.tabs[tabId]!.regions)).toEqual(['region-name-a', 'region-name-b'])
    const root = await mkdtemp('/tmp/amx-names-')
    env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_')))
    Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
      AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') })
    server = new AgentMuxControlServer({ async execute(request) {
      seen.push(request)
      return useAppStore.getState().executeControl(request)
    } }, join(root, 'control.sock'))
    await server.start()
  })
  afterEach(async () => { await server?.stop(); vi.restoreAllMocks(); useAppStore.setState(original, true) })

  async function run(args: string[]) {
    try { return { code: 0, ...await exec(process.execPath, [cli, ...args], { env, timeout: 5_000 }) } }
    catch (error) {
      const failure = error as { code: number; stdout: string; stderr: string }
      // A killed child or spawn/setup error is never converted into an Assertion RED.
      if (typeof failure.code !== 'number') throw error
      return failure
    }
  }
  async function success(args: string[], code = 0) {
    const result = await run(args)
    expect(result.code, result.stderr).toBe(code)
    const lines = result.stdout.trim().split('\n')
    expect(lines).toHaveLength(1)
    const receipt = parseAgentMuxControlReceipt(JSON.parse(lines[0]!))
    expect(receipt.ok).toBe(true)
    if (!receipt.ok) throw new Error('Expected a typed success report.')
    return receipt
  }
  const agentArgs = (name: string) => ['agent', 'rename', '--session', sid, '--name', name]
  const tabArgs = (name: string) => ['space', 'rename', '--tab', tabId, '--name', name]
  const saved = { layoutApplied: false, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed', reason: null }

  it('renames one Agent with two Regions, trims through the owner and persists its actual override', async () => {
    const receipt = await success(agentArgs('  中文 "调查"  '))
    expect(receipt).toMatchObject({ operation: 'agent.rename', result: {
      agentSessionId: sid, override: '中文 "调查"', changed: true, outcome: 'renamed', save: saved } })
    expect(agentRename).toHaveBeenCalledExactlyOnceWith(sid, '  中文 "调查"  ')
    expect(tabRename).not.toHaveBeenCalled()
    // The existing localStorage writer requests a background flush; the explicit save also awaits one.
    expect(flush).toHaveBeenCalledTimes(2)
    const stored = JSON.parse(localStorage.getItem('agentmux-workbench-v1')!)
    expect(stored.state.agentNames).toEqual({ [sid]: '中文 "调查"' })
    noFactsOrLifecycle()
  })
  it('renames the exact cross-display Tab and compares actual values rather than new object identity', async () => {
    const first = await success(tabArgs('  Tab 名  '))
    expect(first).toMatchObject({ operation: 'space.rename', result: { tabId, override: 'Tab 名', changed: true, outcome: 'renamed', save: saved } })
    const second = await success(tabArgs('Tab 名'))
    expect(second).toMatchObject({ result: { override: 'Tab 名', changed: false, outcome: 'unchanged', save: saved } })
    expect(tabRename).toHaveBeenCalledTimes(2)
    expect(agentRename).not.toHaveBeenCalled()
    expect(flush).toHaveBeenCalledTimes(3)
    expect(JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.restoredWorkbench.tabs[tabId].name).toBe('Tab 名')
    noFactsOrLifecycle()
  })
  it('keeps --help as name data and reports clearing and unchanged Agent values', async () => {
    expect(await success(agentArgs('--help'))).toMatchObject({ result: { override: '--help', changed: true } })
    expect(await success(agentArgs('--help'))).toMatchObject({ result: { override: '--help', changed: false, outcome: 'unchanged' } })
    expect(await success(['agent', 'rename', '--session', sid, '--clear'])).toMatchObject({ result: { override: null, changed: true } })
    expect(await success(agentArgs('   '))).toMatchObject({ result: { override: null, changed: false } })
    expect(useAppStore.getState().agentNames).toEqual({})
    noFactsOrLifecycle()
  })
  it('clears the Tab name and restores both names through the real persistence entry', async () => {
    await success(agentArgs('Saved Agent'))
    await success(tabArgs('Saved Tab'))
    const record = localStorage.getItem('agentmux-workbench-v1')!
    useAppStore.setState({ agentNames: {}, tabs: {}, layouts: {} })
    localStorage.setItem('agentmux-workbench-v1', record)
    await useAppStore.persist.rehydrate()
    const dispose = await useAppStore.getState().initialize()
    dispose()
    expect(useAppStore.getState().agentNames).toEqual({ [sid]: 'Saved Agent' })
    expect(useAppStore.getState().tabs[tabId]!.name).toBe('Saved Tab')
    expect(await success(['space', 'rename', '--tab', tabId, '--clear'])).toMatchObject({ result: { override: null, changed: true, save: saved } })
    const stored = JSON.parse(localStorage.getItem('agentmux-workbench-v1')!)
    expect(stored.state.restoredWorkbench.tabs[tabId].name).toBeUndefined()
    expect(stored.state.agentNames).toEqual({ [sid]: 'Saved Agent' })
  })
  it.each(['agent', 'space'] as const)('keeps the applied %s name after a failed platform save', async kind => {
    flush.mockRejectedValue(new Error('private flush refused'))
    const receipt = await success(kind === 'agent' ? agentArgs('Applied') : tabArgs('Applied'), 1)
    expect(receipt).toMatchObject({ result: { override: 'Applied', changed: true, outcome: 'partial', save: {
      layoutApplied: false, localStorageWritten: true, storageFlushRequested: false, diskDurability: 'unconfirmed', reason: 'private flush refused' } } })
    expect(kind === 'agent' ? useAppStore.getState().agentNames[sid] : useAppStore.getState().tabs[tabId]!.name).toBe('Applied')
    noFactsOrLifecycle()
  })
  it('reads an applied alias after missing save confirmation without reissuing the write, then reads a later user edit', async () => {
    flush.mockRejectedValue(new Error('confirmation missing'))
    await success(agentArgs('Applied first'), 1)
    flush.mockResolvedValue(undefined)
    agentRename.mockClear(); tabRename.mockClear(); flush.mockClear(); seen = []
    expect(await success(['agent', 'inspect', '--session', sid])).toMatchObject({ operation: 'agent.inspect', result: { agentSessionId: sid, override: 'Applied first' } })
    expect(seen.map(item => item.operation)).toEqual(['agent.inspect'])
    expect(agentRename).not.toHaveBeenCalled(); expect(tabRename).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled()
    useAppStore.getState().renameAgent(sid, 'Later user name')
    await prepareRendererUpdate()
    flush.mockClear()
    agentRename.mockClear()
    expect(await success(['agent', 'inspect', '--session', sid])).toMatchObject({ result: { agentSessionId: sid, override: 'Later user name' } })
    expect(agentRename).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled()
    noFactsOrLifecycle()
  })
  it('reads retained aliases with empty Session facts and returns null without guessing retirement', async () => {
    useAppStore.getState().renameAgent(sid, 'Retained alias')
    useAppStore.setState({ sessions: [] })
    await prepareRendererUpdate()
    agentRename.mockClear(); flush.mockClear()
    expect(await success(['agent', 'inspect', '--session', sid])).toMatchObject({ result: { agentSessionId: sid, override: 'Retained alias' } })
    expect(await success(['agent', 'inspect', '--session', 'never-observed'])).toMatchObject({ result: { agentSessionId: 'never-observed', override: null } })
    expect(seen.map(item => item.operation)).toEqual(['agent.inspect', 'agent.inspect'])
    expect(agentRename).not.toHaveBeenCalled(); expect(tabRename).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions).toEqual([])
    for (const call of otherSessionCalls) expect(call).not.toHaveBeenCalled()
  })
  it('reads only own alias entries for exact opaque IDs, including prototype property names', async () => {
    const ids = ['constructor', 'toString', '__proto__']
    const results = []
    for (const id of ids) {
      const receipt = await success(['agent', 'inspect', '--session', id])
      results.push(receipt.result)
    }
    expect(results).toEqual(ids.map(agentSessionId => ({ agentSessionId, override: null })))
    expect(agentRename).not.toHaveBeenCalled(); expect(tabRename).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled()
    for (const id of ids) useAppStore.getState().renameAgent(id, 'Own ' + id)
    await prepareRendererUpdate()
    agentRename.mockClear(); flush.mockClear()
    const owned = []
    for (const id of ids) owned.push((await success(['agent', 'inspect', '--session', id])).result)
    expect(owned).toEqual(ids.map(agentSessionId => ({ agentSessionId, override: 'Own ' + agentSessionId })))
    expect(Object.keys(useAppStore.getState().agentNames)).toEqual(ids)
    expect(agentRename).not.toHaveBeenCalled(); expect(tabRename).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled()
    noFactsOrLifecycle()
  })
  it('rejects non-own Tab entries for opaque prototype IDs before rename or save, preserving the nonempty workbench', async () => {
    const results = []
    for (const id of ['constructor', 'toString', '__proto__']) {
      const result = await run(['space', 'rename', '--tab', id, '--name', 'No phantom Tab'])
      expect(result.code).toBe(1)
      const receipt = parseAgentMuxControlReceipt(JSON.parse(result.stderr.trim()))
      results.push(receipt.ok ? null : receipt.error.code)
    }
    expect(results).toEqual(['TAB_NOT_OPEN', 'TAB_NOT_OPEN', 'TAB_NOT_OPEN'])
    expect(Object.keys(useAppStore.getState().tabs)).toEqual([tabId])
    expect(agentRename).not.toHaveBeenCalled(); expect(tabRename).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled()
    noFactsOrLifecycle()
  })
  it('reads the current alias after the caller discards the original rename receipt, without replaying it', async () => {
    const { code } = await run(agentArgs('Applied before receipt loss'))
    expect(code).toBe(0) // Deliberately discard stdout: this query has no prior completion receipt.
    agentRename.mockClear(); tabRename.mockClear(); flush.mockClear(); seen = []
    const receipt = await success(['agent', 'inspect', '--session', sid])
    expect(receipt).toMatchObject({ result: { agentSessionId: sid, override: 'Applied before receipt loss' } })
    expect(Object.keys(receipt.result)).toEqual(['agentSessionId', 'override'])
    expect(seen.map(item => item.operation)).toEqual(['agent.inspect'])
    expect(agentRename).not.toHaveBeenCalled(); expect(tabRename).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled()
    noFactsOrLifecycle()
  })
  it('captures the applied receipt before awaiting save and never restores it over a later user name', async () => {
    let release!: () => void
    const saving = new Promise<void>(resolve => { release = resolve })
    flush.mockImplementation(() => saving)
    const pending = run(agentArgs('First applied'))
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(2))
    expect(useAppStore.getState().agentNames[sid]).toBe('First applied')
    useAppStore.getState().renameAgent(sid, 'Later user edit')
    release()
    const result = await pending
    expect(result.code, result.stderr).toBe(0)
    expect(parseAgentMuxControlReceipt(JSON.parse(result.stdout))).toMatchObject({ result: { override: 'First applied', changed: true, save: saved } })
    expect(useAppStore.getState().agentNames[sid]).toBe('Later user edit')
    noFactsOrLifecycle()
  })
  it.each([
    ['agent', 'rename', '--session', sid],
    ['agent', 'rename', '--session', sid, '--name', 'A', '--clear'],
    ['agent', 'rename', '--session', sid, '--name', 'A', '--name', 'B'],
    ['agent', 'rename', '--session', 'self', '--clear'],
    ['space', 'rename', '--tab', tabId, '--clear', '--space', 'wrong'],
    ['space', 'rename', '--clear'],
    ['agent', 'inspect', '--session', sid, '--clear']
  ].map(args => ({ args })))('rejects invalid CLI grammar before reaching a write: $args', async ({ args }) => {
    const result = await run(args)
    expect(result.code).toBe(1)
    expect(seen).toEqual([])
    expect(agentRename).not.toHaveBeenCalled(); expect(tabRename).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled()
    noFactsOrLifecycle()
  })
  it('does not rename an observed Terminal as an Agent or infer an Agent lifecycle fact', async () => {
    const { capabilities: _capabilities, executorId: _executorId, ...common } = agent as Extract<SessionSnapshot, { kind: 'agent' }>
    useAppStore.setState({ sessions: [{ ...common, kind: 'terminal', providerId: null,
      control: { kind: 'terminal', hostId: 'local', runId: 'run-name-exact', run: { runId: 'run-name-exact' } } }] })
    before = protectedFacts()
    const result = await run(agentArgs('Never applied'))
    expect(result.code).toBe(1)
    expect(parseAgentMuxControlReceipt(JSON.parse(result.stderr.trim()))).toMatchObject({ ok: false, error: { code: 'UNKNOWN_AGENT_SESSION' } })
    expect(agentRename).not.toHaveBeenCalled(); expect(tabRename).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled()
    noFactsOrLifecycle()
  })
  it.each([
    { args: ['agent', 'rename', '--session', 'not-observed', '--clear'], code: 'UNKNOWN_AGENT_SESSION' },
    { args: ['space', 'rename', '--tab', 'not-open', '--clear'], code: 'TAB_NOT_OPEN' }
  ])('reports $code without changing the original workbench', async ({ args, code }) => {
    const result = await run(args)
    expect(result.code).toBe(1)
    const receipt = parseAgentMuxControlReceipt(JSON.parse(result.stderr.trim()))
    expect(receipt).toMatchObject({ ok: false, error: { code } })
    expect(agentRename).not.toHaveBeenCalled(); expect(tabRename).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled()
    noFactsOrLifecycle()
  })
  it('keeps strict typed request/receipt envelopes and the existing persistence budget', async () => {
    expect(isLongAgentMuxControlOperation('agent.rename')).toBe(true)
    expect(isLongAgentMuxControlOperation('space.rename')).toBe(true)
    expect(isLongAgentMuxControlOperation('agent.inspect')).toBe(false)
    const receipt = await success(agentArgs('Typed'))
    expect(() => parseAgentMuxControlReceipt({ ...receipt, result: { ...receipt.result, override: undefined } })).toThrow()
    expect(() => parseSpaceControlRequest({ schemaVersion: 5, requestId: 'wrong-field', operation: 'agent.inspect', agentSessionId: sid, name: 'wrong' })).toThrow()
    expect(() => parseSpaceControlRequest({ schemaVersion: 5, requestId: 'self', operation: 'space.rename', tabId, name: null })).toThrow()
  })
})
