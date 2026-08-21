// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices.js'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { loginShellEnvironmentWarning } from '../src/main/login-shell-environment.js'

const initial = useAppStore.getState()
const environmentWarning = loginShellEnvironmentWarning({ ok: true, shell: '/bin/zsh', mode: 'login' })!
let element: HTMLDivElement
let root: Root
let dispose: (() => void) | undefined
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
beforeEach(() => {
  useAppStore.setState({ ...initial, loading: false, environmentWarning, noticeReadReceipts: {} }, true)
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
})
afterEach(async () => {
  await act(async () => { dispose?.(); root.unmount() })
  dispose = undefined
  element.remove()
  vi.restoreAllMocks()
  useAppStore.setState(initial, true)
})
const trigger = () => element.querySelector<HTMLButtonElement>('.global-system-notices__trigger')!
const details = () => element.querySelector<HTMLDivElement>('.global-system-notices__details')!
async function render() { await act(async () => root.render(<GlobalSystemNotices />)) }
// happy-dom has no native popover implementation. Browser verification exercises real clicks;
// here the native state event drives the actual React handler, as in SessionMailbox's tests.
async function toggle(state: 'open' | 'closed') {
  const event = new Event('toggle')
  Object.defineProperty(event, 'newState', { value: state })
  await act(async () => details().dispatchEvent(event))
}
async function initializeSnapshot(warning: string | null) {
  const config = await api.config.get()
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [], ...(warning ? { environmentWarning: warning } : {}) })
  await act(async () => { dispose = await useAppStore.getState().initialize() })
  return config
}

describe('global shell environment notice', () => {
  it('keeps the snapshot warning in a compact retrievable control across navigation', async () => {
    const config = await initializeSnapshot(environmentWarning)
    await render()
    expect(useAppStore.getState().loading).toBe(false)
    expect(trigger().textContent).toBe('System1')
    expect(trigger().disabled).toBe(false)
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(trigger().getAttribute('data-unread')).toBe('true')
    expect(trigger().querySelector('.global-system-notices__dot')).not.toBeNull()
    expect(document.getElementById(trigger().getAttribute('popovertarget')!)).toBe(details())
    expect(details().getAttribute('popover')).toBe('auto')
    expect(details().querySelector('[role="status"]')?.textContent).toContain(environmentWarning)
    expect(details().textContent).toContain('Local shell environment is incomplete')
    expect(details().textContent).toContain('restart AgentMux')
    expect(details().textContent).toContain('Existing processes keep their original environment.')
    await act(async () => useAppStore.getState().selectWorkspace(config.workspaces[0]!.id))
    expect(trigger().getAttribute('data-unread')).toBe('true')
    expect(useAppStore.getState().environmentWarning).toBe(environmentWarning)
  })

  it('reads only on expansion and collapses without resolving or altering a Session receipt', async () => {
    useAppStore.setState({ noticeReadReceipts: { 'agent-1': { delivery: 'session-receipt' } } })
    await render()
    expect(useAppStore.getState().noticeReadReceipts['global:environment']).toBeUndefined()
    await toggle('open')
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(trigger().getAttribute('data-unread')).toBe('false')
    expect(trigger().querySelector('.global-system-notices__dot')).toBeNull()
    const close = details().querySelector<HTMLButtonElement>('[aria-label="Collapse system notifications"]')!
    expect(close.getAttribute('popovertarget')).toBe(details().id)
    expect(close.getAttribute('popovertargetaction')).toBe('hide')
    await toggle('closed')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(trigger().getAttribute('data-unread')).toBe('false')
    expect(useAppStore.getState().environmentWarning).toBe(environmentWarning)
    expect(useAppStore.getState().noticeReadReceipts['agent-1']).toEqual({ delivery: 'session-receipt' })
    expect(details().textContent).toContain(environmentWarning)
  })

  it('rehydrates the read fingerprint and keeps it while the restart snapshot is still missing', async () => {
    await initializeSnapshot(environmentWarning)
    await render()
    await toggle('open')
    await toggle('closed')
    window.dispatchEvent(new Event('pagehide'))
    const name = useAppStore.persist.getOptions().name!
    const persisted = window.localStorage.getItem(name)!
    expect(JSON.parse(persisted).state.noticeReadReceipts['global:environment'].shell).toBeTruthy()
    await act(async () => root.render(null))
    await act(async () => useAppStore.setState({ loading: true, environmentWarning: initial.environmentWarning, noticeReadReceipts: {} }))
    window.dispatchEvent(new Event('pagehide'))
    window.localStorage.setItem(name, persisted)
    await act(async () => useAppStore.persist.rehydrate())
    await render()
    expect(element.querySelector('.global-system-notices__trigger')).not.toBeNull()
    expect(useAppStore.getState().noticeReadReceipts['global:environment']?.shell).toBeTruthy()
    // A failed snapshot can finish startup without establishing whether the warning recovered.
    await act(async () => useAppStore.setState({ loading: false }))
    expect(useAppStore.getState().noticeReadReceipts['global:environment']?.shell).toBeTruthy()
    await act(async () => useAppStore.setState({ loading: false, environmentWarning }))
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(trigger().getAttribute('data-unread')).toBe('false')
    expect(details().textContent).toContain(environmentWarning)
  })

  it('marks changed content unread but coalesces the same warning', async () => {
    await render()
    await toggle('open')
    await toggle('closed')
    await act(async () => useAppStore.setState({ environmentWarning: `${environmentWarning}` }))
    expect(trigger().getAttribute('data-unread')).toBe('false')
    const changed = 'Shell startup failed: the environment could not be read.'
    await act(async () => useAppStore.setState({ environmentWarning: changed }))
    expect(trigger().getAttribute('data-unread')).toBe('true')
    expect(details().textContent).toContain(changed)
    await toggle('open')
    expect(trigger().getAttribute('data-unread')).toBe('false')
  })

  it('clears only the resolved global receipt and marks a later recurrence unread', async () => {
    await render()
    await toggle('open')
    await toggle('closed')
    await act(async () => useAppStore.setState({ environmentWarning: null }))
    expect(element.querySelector('.service-window')).toBeNull()
    expect(useAppStore.getState().noticeReadReceipts['global:environment']).toBeUndefined()
    await act(async () => useAppStore.setState({ environmentWarning }))
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(trigger().getAttribute('data-unread')).toBe('true')
  })
})

const displaced: SessionSnapshot = {
  id: 'unplaced', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local',
  workspacePath: '/repo', label: 'Builder', createdAt: 1, updatedAt: 1, processState: 'running',
  latestOutputBytes: 0, status: { state: 'running', source: 'run-process', observedAt: 1 },
  capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'unplaced', run: { runId: 'unplaced-run' } }
}

describe('one global system inbox', () => {
  it('shows all three owner facts in one collapsible entry and keeps every fact after reading', async () => {
    useAppStore.setState({ runtimeOwnershipWarnings: ['studio'], sessions: [displaced], displacedAgentSessionIds: [displaced.id], tabs: {} })
    await render()
    expect(element.querySelectorAll('.global-system-notices__trigger')).toHaveLength(1)
    expect(trigger().textContent).toBe('System3')
    expect(details().querySelectorAll('.service-window')).toHaveLength(3)
    expect(details().textContent).toContain('Give it a place')
    expect(details().textContent).toContain('Runtime launch record is unavailable')
    expect(details().textContent).toContain('Local shell environment is incomplete')
    await toggle('open')
    await toggle('closed')
    expect(trigger().getAttribute('data-unread')).toBe('false')
    expect(useAppStore.getState().runtimeOwnershipWarnings).toEqual(['studio'])
    expect(useAppStore.getState().displacedAgentSessionIds).toEqual([displaced.id])
    expect(useAppStore.getState().environmentWarning).toBe(environmentWarning)
    expect(details().querySelectorAll('.service-window')).toHaveLength(3)
    expect(useAppStore.getState().noticeReadReceipts['global:runtime-ownership']?.ownership).toBeTruthy()
    expect(useAppStore.getState().noticeReadReceipts['global:displaced-agents']?.unplaced).toBeTruthy()
  })

  it('keeps Runtime and displaced receipts and placement intent through unknown restart snapshots', async () => {
    await initializeSnapshot(environmentWarning)
    useAppStore.setState({ runtimeOwnershipWarnings: ['studio'], sessions: [displaced], displacedAgentSessionIds: [displaced.id], tabs: {} })
    await render()
    await toggle('open')
    await toggle('closed')
    window.dispatchEvent(new Event('pagehide'))
    const name = useAppStore.persist.getOptions().name!
    const persisted = window.localStorage.getItem(name)!
    const saved = JSON.parse(persisted).state
    expect(saved.displacedAgentSessionIds).toEqual([displaced.id])
    expect(Object.keys(saved.noticeReadReceipts).sort()).toEqual(['global:displaced-agents', 'global:environment', 'global:runtime-ownership'])
    await act(async () => root.render(null))
    await act(async () => useAppStore.setState({ loading: true, sessions: [], tabs: {},
      runtimeOwnershipWarnings: initial.runtimeOwnershipWarnings, environmentWarning: initial.environmentWarning,
      displacedAgentSessionIds: [], noticeReadReceipts: {} }))
    window.dispatchEvent(new Event('pagehide'))
    window.localStorage.setItem(name, persisted)
    await act(async () => useAppStore.persist.rehydrate())
    await render()
    await act(async () => useAppStore.setState({ loading: false }))
    expect(useAppStore.getState().noticeReadReceipts).toEqual(saved.noticeReadReceipts)
    expect(useAppStore.getState().displacedAgentSessionIds).toEqual([displaced.id])
    expect(details().textContent).toContain('Waiting for Runtime status.')
    // Environment/host facts can recover before the Session projection; keep the displaced receipt.
    await act(async () => useAppStore.setState({ runtimeOwnershipWarnings: ['studio'], environmentWarning }))
    expect(useAppStore.getState().noticeReadReceipts).toEqual(saved.noticeReadReceipts)
    await act(async () => useAppStore.setState({ sessions: [displaced] }))
    expect(trigger().textContent).toBe('System3')
    expect(trigger().getAttribute('data-unread')).toBe('false')
    await act(async () => useAppStore.setState({ runtimeOwnershipWarnings: ['different-host'] }))
    expect(trigger().getAttribute('data-unread')).toBe('true')
    expect(details().textContent).toContain('different-host')
  })

  it('offers the system inbox with zero Agents and honestly distinguishes unknown from resolved', async () => {
    useAppStore.setState({ sessions: [], environmentWarning: undefined, runtimeOwnershipWarnings: undefined })
    await render()
    expect(trigger().disabled).toBe(false)
    expect(trigger().textContent).toBe('System')
    expect(details().textContent).toContain('Waiting for Runtime status.')
    await act(async () => useAppStore.setState({ environmentWarning: null, runtimeOwnershipWarnings: [] }))
    expect(details().textContent).toContain('No current system notices.')
    expect(details().querySelector('.service-window')).toBeNull()
  })
})
