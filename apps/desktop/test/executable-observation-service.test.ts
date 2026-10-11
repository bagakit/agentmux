import { afterEach, expect, it, vi } from 'vitest'
import { cleanupExecutableNativeFixtures, executableNativeFixture, until } from '../../../packages/core/test/helpers/executable-native-fixture.js'
import type { AgentMuxClientEvent } from '../../../packages/core/src/types.js'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'

const faults = vi.hoisted(() => new Map<string, 'stat' | 'access'>())
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  function check(path: unknown, operation: 'stat' | 'access') {
    if (faults.get(String(path)) === operation) throw Object.assign(new Error('Original executable observation failed'), { code: 'EIO' })
  }
  return { ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => { check(args[0], 'stat'); return await actual.stat(...args) },
    access: async (...args: Parameters<typeof actual.access>) => { check(args[0], 'access'); return await actual.access(...args) }
  }
})
const initial = useAppStore.getState()
afterEach(async () => { faults.clear(); await cleanupExecutableNativeFixtures(); useAppStore.setState(initial, true); vi.restoreAllMocks() })

it.each(['stat', 'access'] as const)('%s failure reaches the real Hosted Native owner and persistent Renderer service notice', async operation => {
  const f = await executableNativeFixture('configured-path'), caller = await f.hosted(), events: AgentMuxClientEvent[] = []
  const off = caller.onEvent(event => { if (event.type === 'agent-error') events.push(event) })
  faults.set(f.executable, operation)
  const created = await caller.createAgent({ providerId: 'claude', executorId: 'fixture', workspacePath: f.root,
    commandOverride: f.command, env: f.env, injectAgentMuxGuide: false, prompt: 'original service task' })
  expect((await f.receipt(created)).sid).toBe(created.agentSessionId)
  const diagnostic = await until(() => events.find(event => event.type === 'agent-error' && event.code === 'AGENT_EXECUTABLE_CHECK_UNCONFIRMED'), Boolean)
  if (!diagnostic || diagnostic.type !== 'agent-error') throw new Error('Expected original Hosted diagnostic')
  expect(diagnostic.agentSessionId).toBeUndefined()
  expect(diagnostic.evidence.run).toEqual(created.run)
  const view = { ...composerSession(created.agentSessionId, 'claude'), executorId: 'fixture', workspacePath: f.root,
    control: { kind: 'agent' as const, hostId: 'local', agentSessionId: created.agentSessionId, run: created.run } }
  useAppStore.setState({ sessions: [view], config: composerConfig, loading: false, pendingAgentLaunches: {},
    notificationEvents: [], error: null, lastError: null, errorDismissed: false, errorNoticeContext: null,
    tabs: {}, layouts: {}, agentComposerDrafts: { [view.id]: 'Keep the unsent draft' } })
  // Public Store action used by the live Renderer IPC subscription, with the actual Unix RPC event.
  useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: diagnostic })
  const state = useAppStore.getState(), record = state.notificationEvents.find(item => item.message.includes('AGENT_EXECUTABLE_CHECK_UNCONFIRMED'))!
  expect(record).toBeDefined()
  expect(record.message).toContain('Executable preflight')
  expect(record.message).toContain('EIO: Original executable observation failed')
  expect(record.message).toContain(created.run.runId)
  expect(record.message).toContain('Native start returned Run ' + created.run.runId + ' in running state')
  expect(record.message).toContain('Recheck this Executor’s availability')
  expect(record.context?.kind).toBe('indeterminate')
  expect(state.sessions[0]?.status.state).toBe('running')
  expect(state.sessions[0]?.control).toEqual(view.control)
  expect(state.agentComposerDrafts[view.id]).toBe('Keep the unsent draft')
  // Clearing this fault makes the named original recheck progress. An unrelated
  // healthy Session projection cannot silently erase the retained diagnostic.
  faults.clear()
  expect(await caller.probeExecutorAvailability('claude', f.command, { workspacePath: f.root, env: f.env })).toMatchObject({ availability: 'available' })
  useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'agent-session', session: f.client.agentSession(view.id) } })
  expect(useAppStore.getState().notificationEvents).toContainEqual(record)
  expect((await caller.statusAgent(view.id)).run.state).toBe('running')
  off()
}, 35_000)
