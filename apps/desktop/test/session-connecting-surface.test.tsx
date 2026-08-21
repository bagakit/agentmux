// @vitest-environment happy-dom
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: () => null }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <div data-composer="disabled" /> }))
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { SessionConnectingSurface } from '../src/renderer/src/components/SessionConnectingSurface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const prompt = '  Review the complete request.\n\nKeep spacing, 中文 and <symbols> intact.\n'
function pendingFixture(id = 'pending') {
  const tab = createWorkbenchTab('view', { regionId: 'region', kind: 'agent', phase: 'launching', workspaceId: 'workspace', sessionId: id })
  useAppStore.setState({
    config: { ...composerConfig, executors: { ...composerConfig.executors,
      reviewer: { ...composerConfig.executors.codex!, label: 'Code reviewer' } },
      appearance: { ...composerConfig.appearance, agentAvatars: { reviewer: { tint: '#009988', badge: 'R' } } } },
    sessions: [composerSession('neighbor')], activeWorkspaceId: 'workspace',
    tabs: { view: tab }, layouts: { workspace: createWorkspaceLayout('pane', ['view']) },
    pendingAgentLaunches: { [id]: { events: [], overflowed: false, request: { executorId: 'reviewer', prompt } } }
  })
  return tab
}
function pane(id = 'pending') {
  return <SessionPane sessionId={id} surfaceKind="agent" visible interactiveResize={false}
    linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'pane', tabId: 'view', regionId: 'region' }} />
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it.each(['launcher', 'control'] as const)('captures the exact %s request before native launch settles, independent of new drafts', async (entry) => {
  pendingFixture()
  const launcher = createWorkbenchTab('view', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' })
  useAppStore.setState({ tabs: { view: launcher }, pendingAgentLaunches: {} })
  const native = deferred<Awaited<ReturnType<typeof api.sessions.launchAgent>>>()
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockReturnValue(native.promise)
  const operation = entry === 'launcher'
    ? useAppStore.getState().launchAgent('reviewer', prompt, 'pane', { tabId: 'view', regionId: 'region' })
    : useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'loading-proof',
      operation: 'open.agent', content: { kind: 'new-agent', executorId: 'reviewer', prompt },
      destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'region' } } })
  const settled = operation.catch(() => undefined)
  try {
    expect(launch).toHaveBeenCalledOnce()
    const submitted = launch.mock.calls[0]![0]
    expect(submitted.prompt).toBe(prompt)
    const id = submitted.agentSessionId!
    expect(useAppStore.getState().pendingAgentLaunches[id]?.request).toEqual({ executorId: 'reviewer', prompt })
    await dom.render(pane(id))
    await act(async () => useAppStore.setState({ agentComposerDrafts: { [id]: 'not submitted' } }))
    expect(dom.container.querySelector('pre')?.textContent).toBe(prompt)
    expect(dom.container.querySelector('.session-connecting__executor strong')?.textContent).toBe('Code reviewer')
    expect(dom.container.querySelector('.session-connecting__executor-mark')?.getAttribute('aria-label')).toBe('Code reviewer')
    expect(dom.container.querySelector('.session-connecting__executor-mark [data-agent-provider="codex"]')).not.toBeNull()
    expect(dom.container.querySelector('.session-connecting__executor-badge')?.textContent).toBe('R')
    // A connecting surface has no Runtime status fact yet; it must not borrow a status dot from a
    // neighboring Agent or imply that this process is already running.
    expect(dom.container.querySelector('.session-connecting__executor-mark .agent-avatar__status')).toBeNull()
  } finally {
    await act(async () => { native.reject(new Error('fixture complete')); await settled })
  }
})

it('copies the entire submitted prompt through the shared clipboard outlet and reports local failure then retry success', async () => {
  pendingFixture()
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockRejectedValueOnce(new Error('clipboard denied')).mockResolvedValue(undefined)
  const report = vi.spyOn(useAppStore.getState(), 'reportError')
  await dom.render(pane())
  await dom.click('[aria-label="Copy initial prompt"]')
  expect(clipboard).toHaveBeenNthCalledWith(1, prompt)
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('clipboard denied')
  expect(dom.container.textContent).not.toContain('Full prompt copied.')
  expect(dom.container.querySelector('[aria-label="Copy initial prompt"]')?.textContent).toBe('Copy')
  expect(report).not.toHaveBeenCalled()
  await dom.click('[aria-label="Copy initial prompt"]')
  expect(clipboard).toHaveBeenNthCalledWith(2, prompt)
  expect(dom.container.querySelector('[role="alert"]')).toBeNull()
  expect(dom.container.textContent).toContain('Full prompt copied.')
})

it('keeps late clipboard completion and copied feedback scoped to the original Session', async () => {
  pendingFixture()
  const clipboard = deferred<void>()
  vi.spyOn(api.ui, 'writeClipboardText').mockReturnValue(clipboard.promise)
  await dom.render(pane())
  await dom.click('[aria-label="Copy initial prompt"]')
  expect(dom.container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
  await act(async () => useAppStore.setState((state) => ({ pendingAgentLaunches: { ...state.pendingAgentLaunches,
    second: { events: [], overflowed: false, request: { executorId: 'reviewer', prompt: 'Second request' } } } })))
  await dom.render(pane('second'))
  expect(dom.container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false)
  await act(async () => clipboard.resolve())
  expect(dom.container.textContent).not.toContain('Full prompt copied.')
  expect(dom.container.querySelector('pre')?.textContent).toBe('Second request')
})

it('does not invent an Executor or initial prompt for legacy pending and persisted unknown Sessions', async () => {
  const tab = pendingFixture()
  await act(async () => useAppStore.setState({ pendingAgentLaunches: { pending: { events: [], overflowed: false } } }))
  await dom.render(pane())
  expect(dom.container.textContent).toContain('Starting your agent')
  expect(dom.container.textContent).toContain('Executor not yet known')
  expect(dom.container.textContent).toContain('initial prompt is unavailable for this launch')
  expect(dom.container.querySelector('[aria-label="Copy initial prompt"]')).toBeNull()
  await act(async () => useAppStore.setState({ pendingAgentLaunches: {} }))
  await dom.render(pane())
  expect(dom.container.textContent).toContain('Connecting to this session')
  expect(dom.container.textContent).toContain('not available while reconnecting')
  expect(useAppStore.getState().tabs.view).toEqual(tab)
  expect(useAppStore.getState().layouts.workspace).toEqual(createWorkspaceLayout('pane', ['view']))
})

it('uses only the matching recovery candidate identity, never a neighbor or editable draft', async () => {
  pendingFixture()
  const session = composerSession('pending')
  await act(async () => useAppStore.setState({ pendingAgentLaunches: {}, recoveryCandidates: [{
    agentSessionId: 'pending', executorId: 'reviewer', providerId: 'codex', hostId: 'local', workspacePath: '/repo',
    label: 'Saved agent', createdAt: 1, updatedAt: 2, capabilities: session.capabilities, run: session.control.run
  }], agentComposerDrafts: { pending: 'not the original request' } }))
  await dom.render(pane())
  expect(dom.container.textContent).toContain('Restoring your session')
  expect(dom.container.textContent).toContain('Code reviewer')
  expect(dom.container.querySelector('pre')).toBeNull()
  await dom.render(pane('other-unknown'))
  expect(dom.container.textContent).toContain('Executor not yet known')
  expect(dom.container.textContent).not.toContain('Code reviewer')
})

it('distinguishes an intentionally empty prompt and keeps terminal loading free of Agent claims', async () => {
  await dom.render(<SessionConnectingSurface phase="launch" surfaceKind="agent" request={{ executorId: 'removed-executor' }} />)
  expect(dom.container.textContent).toContain('removed-executor')
  expect(dom.container.textContent).toContain('No initial prompt was submitted.')
  expect(dom.container.querySelector('button')).toBeNull()
  await dom.render(<SessionConnectingSurface phase="connect" surfaceKind="terminal" />)
  expect(dom.container.textContent).toContain('Terminal')
  expect(dom.container.querySelector('[aria-label="Initial prompt"]')).toBeNull()
})

it('keeps reduced motion and readable prompt constraints on the actual imported stylesheet', () => {
  const styles = readFileSync(join(import.meta.dirname, '../src/renderer/src/styles/session-connecting.css'), 'utf8')
  const index = readFileSync(join(import.meta.dirname, '../src/renderer/src/styles/index.css'), 'utf8')
  expect(index).toContain("@import './session-connecting.css'")
  expect(styles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation:\s*none/)
  const start = styles.indexOf('.session-connecting__prompt pre {')
  const end = styles.indexOf('}', start)
  expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start)
  const promptStyle = styles.slice(start, end)
  expect(promptStyle).toContain('white-space: pre-wrap')
  expect(promptStyle).toContain('overflow-wrap: anywhere')
  expect(promptStyle).toContain('user-select: text')
})

it('keeps both state stages full-Region and gives Terminal recovery the same static reduced-motion frame', () => {
  const styles = readFileSync(join(import.meta.dirname, '../src/renderer/src/styles/terminal.css'), 'utf8')
  const connectingStart = styles.indexOf('.terminal-hydration {')
  const connectingEnd = styles.indexOf('}', connectingStart)
  expect(connectingStart).toBeGreaterThan(-1)
  expect(connectingEnd).toBeGreaterThan(connectingStart)
  const hydration = styles.slice(connectingStart, connectingEnd)
  expect(hydration).toContain('inset: 0')
  expect(hydration).toContain('background-size: 72px 72px')
  expect(styles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?terminal-hydration__content::before[\s\S]*?animation:\s*none/)
  expect(styles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?terminal-hydration__cursor[\s\S]*?animation:\s*none/)
})
