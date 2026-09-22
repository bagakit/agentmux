// @vitest-environment happy-dom
import { act, Component, type ReactNode } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxClient, AgentMuxFileAgentSessionStore } from '@agentmux/core'
import type { AgentMuxStoredAgentSession } from '@agentmux/core'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
let disposeBootstrap: (() => void) | undefined
const clients: AgentMuxClient[] = []
const clientRegistry = new Map<string, AgentMuxClient>()

beforeAll(async () => {
  disposeBootstrap = await useAppStore.getState().initialize()
})

afterAll(() => {
  disposeBootstrap?.()
})

afterEach(async () => {
  clientRegistry.clear()
  for (const client of clients.splice(0)) {
    await client.dispose()
  }
  vi.restoreAllMocks()
})

const trigger = () => dom.container.querySelector<HTMLButtonElement>('.composer__mailbox')!
const mailbox = () => dom.container.querySelector<HTMLDivElement>('.composer-mailbox')!

let digest: { mock: { results: { value: unknown }[] } }
beforeEach(() => {
  clientRegistry.clear()
  digest = vi.spyOn(crypto.subtle, 'digest')
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (control, options) => {
    const targetId = control?.agentSessionId
    const client = targetId ? clientRegistry.get(targetId) : undefined
    if (client && targetId) {
      return client.sessionHistoryPage(targetId, options)
    }
    return { items: [], nextCursor: null }
  })
})

async function settleFingerprints() {
  await act(async () => {
    await Promise.all(digest.mock.results.map((result) => result.value))
  })
}

async function toggle(state: 'open' | 'closed') {
  if (state === 'open') await settleFingerprints()
  const event = new Event('toggle')
  Object.defineProperty(event, 'newState', { value: state })
  await act(async () => mailbox().dispatchEvent(event))
}

async function folder(name: 'inbox' | 'outbox' | 'system') {
  await dom.click(`[role="tab"][id$="-${name}-tab"]`)
}

async function setupProductionClaudeSpine(sessionId: string) {
  const rootDir = await mkdtemp(join(tmpdir(), 'mailbox-spine-claude-'))
  const transcriptPath = join(rootDir, 'claude.jsonl')
  const nativeSessionId = 'spine-claude-sess'

  const lines = [
    {
      sessionId: nativeSessionId,
      uuid: 'claude-u-101',
      type: 'user',
      message: { role: 'user', content: 'Terminal input message alpha' },
      timestamp: '2026-10-03T01:10:00.000Z'
    },
    {
      sessionId: nativeSessionId,
      uuid: 'claude-u-102',
      type: 'user',
      message: { role: 'user', content: 'Second terminal command bravo' },
      timestamp: '2026-10-03T01:10:30.000Z'
    }
  ]
  await writeFile(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const storePath = join(rootDir, 'sessions.json')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = {
    kind: 'agent',
    agentSessionId: sessionId,
    providerId: 'claude',
    executorId: 'claude',
    hostId: 'local',
    workspacePath: rootDir,
    run: { runId: `run-${sessionId}` },
    retiredRuns: [],
    hookBindingId: 'spine-binding',
    hookToken: 'spine-token',
    createdAt: 1,
    updatedAt: 1,
    nativeHandle: {
      kind: 'provider',
      providerId: 'claude',
      sessionId: nativeSessionId,
      transcriptPath
    }
  }
  await store.compareAndSwap(null, session)

  const client = new AgentMuxClient({ store })
  clients.push(client)
  const inner = client as unknown as {
    kernel: Record<string, unknown>
    registry: { load(host: string): Promise<void> }
  }
  await inner.registry.load('local')

  const proto = Object.getPrototypeOf(inner.kernel)
  const allKernelMethodNames = Object.getOwnPropertyNames(proto).filter(
    (name) => typeof (inner.kernel as Record<string, unknown>)[name] === 'function' && name !== 'constructor'
  )

  // Runtime control methods that must not be invoked during read operations.
  // Note: disconnect, resetConnection, requireClient, isConnected are transport/lifecycle methods of client/kernel, not Run controls.
  const transportMethods = new Set(['disconnect', 'resetConnection', 'requireClient', 'isConnected'])
  const runtimeControlNames = allKernelMethodNames.filter((name) => !transportMethods.has(name))

  const controls = runtimeControlNames.map((name) => ({
    name,
    spy: vi.spyOn(inner.kernel as Record<string, (...args: unknown[]) => unknown>, name).mockImplementation(() => {
      throw new Error(`Forbidden Runtime control operation during read: ${name}`)
    })
  }))

  const verifyZeroControls = () => {
    expect(controls.length).toBeGreaterThanOrEqual(25)
    for (const c of controls) {
      expect(c.spy.mock.calls.length).toBe(0)
    }
  }

  clientRegistry.set(sessionId, client)

  const sessionSnap = {
    ...composerSession(sessionId, 'claude'),
    workspacePath: rootDir,
    control: { kind: 'agent' as const, hostId: 'local', agentSessionId: sessionId, run: { runId: `run-${sessionId}` } }
  }

  useAppStore.setState({
    sessions: [sessionSnap],
    timelines: { [sessionId]: { agentSessionId: sessionId, revision: 0, items: [] } },
    agentSteerQueues: {}
  })

  return { rootDir, transcriptPath, client, controls, verifyZeroControls, lines }
}

it('delivers terminal native user inputs, Message Tool confirmed, and unverified sending messages to Outbox with truthful labels and exact counts', async () => {
  const sessionId = 'agent-outbox-comprehensive'
  const spine = await setupProductionClaudeSpine(sessionId)

  // Configure timeline with:
  // - 1 complete MessageTool message
  // - 1 failed MessageTool message
  // - 1 incoming message from another agent (remote-agent-99)
  useAppStore.setState({
    timelines: {
      [sessionId]: {
        agentSessionId: sessionId,
        revision: 1,
        items: [
          {
            id: 'prompt:msg-tool-confirmed',
            agentSessionId: sessionId,
            kind: 'user_message',
            status: 'complete',
            source: 'user',
            createdAt: 1790900000000,
            updatedAt: 1790900000000,
            title: 'Message tool prompt',
            content: 'Message Tool confirmed delivery text'
          },
          {
            id: 'prompt:msg-tool-failed',
            agentSessionId: sessionId,
            kind: 'user_message',
            status: 'failed',
            source: 'user',
            createdAt: 1790900001000,
            updatedAt: 1790900001000,
            title: 'Failed prompt',
            content: 'Failed delivery text'
          },
          {
            id: 'prompt:incoming-peer',
            agentSessionId: sessionId,
            kind: 'user_message',
            status: 'complete',
            source: 'user',
            createdAt: 1790900002000,
            updatedAt: 1790900002000,
            title: 'Peer instruction',
            authorAgentSessionId: 'remote-agent-99',
            content: 'Incoming task from peer agent'
          }
        ]
      }
    },
    agentSteerQueues: {
      [sessionId]: [
        {
          operationId: 'op-sending',
          text: 'Sending in-flight prompt',
          status: 'queued',
          enqueuedAt: 1790900010000
        },
        {
          operationId: 'op-deferred',
          text: 'Deferred steer queue item',
          status: 'deferred',
          enqueuedAt: 1790900020000
        }
      ]
    },
    agentSteerInFlight: {
      [sessionId]: 'op-sending'
    }
  })

  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
  await act(async () => {
    await vi.waitFor(() => {
      expect(trigger()).toBeTruthy()
    })
  })

  await act(async () => {
    await toggle('open')
  })

  // 1. Inbox folder has incoming agent message
  await act(async () => {
    await folder('inbox')
  })
  await act(async () => {
    await vi.waitFor(() => {
      const inboxPanel = dom.container.querySelector('[id$="-inbox"]')!
      expect(inboxPanel.textContent).toContain('Incoming task from peer agent')
      expect(inboxPanel.textContent).toContain('Agent remote-a')
    })
  })

  // 2. Outbox folder
  await act(async () => {
    await folder('outbox')
  })
  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      expect(outboxPanel.textContent).toContain('Terminal input message alpha')
      expect(outboxPanel.textContent).toContain('Second terminal command bravo')
      expect(outboxPanel.textContent).toContain('Message Tool confirmed delivery text')
      expect(outboxPanel.textContent).toContain('Failed delivery text')
      expect(outboxPanel.textContent).toContain('Sending in-flight prompt')
      expect(outboxPanel.textContent).toContain('Deferred steer queue item')
    })
  })

  const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!

  // Check headers:
  // Native items: Recorded
  // Confirmed captured items: Sent
  // Failed captured items: Delivery not confirmed
  const messageItems = [...outboxPanel.querySelectorAll('.composer-mailbox__messages li')]
  expect(messageItems.length).toBeGreaterThanOrEqual(4)

  const headers = messageItems.map((li) => li.querySelector('header strong')?.textContent)
  expect(headers).toContain('Recorded')
  expect(headers).toContain('Sent')
  expect(headers).toContain('Delivery not confirmed')
  expect(headers).not.toContain('You')
  expect(headers).not.toContain('Human')

  // Sending status description in queue
  expect(outboxPanel.textContent).toContain('Sending. Waiting for delivery confirmation.')

  // Check outbox tab count
  // pending (2) + sent (2 native + 2 timelineSent = 4) = 6
  const outboxTab = dom.container.querySelector('[id$="-outbox-tab"]')!
  expect(outboxTab.textContent).toContain('Outbox (6)')

  spine.verifyZeroControls()
})

it('preserves distinct records in Outbox when identical prompt text is entered repeatedly across native and captured layers', async () => {
  const sessionId = 'agent-outbox-repeated'
  const rootDir = await mkdtemp(join(tmpdir(), 'mailbox-spine-pi-'))
  const transcriptPath = join(rootDir, 'pi.jsonl')
  const nativeSessionId = 'spine-pi-sess'
  const repeatedText = 'Repeated prompt message text'

  const lines = [
    { type: 'session', version: 3, id: nativeSessionId, cwd: rootDir, timestamp: '2026-10-03T01:00:00Z' },
    {
      type: 'message',
      id: 'pi-rec-001',
      parentId: null,
      timestamp: '2026-10-03T01:05:00Z',
      message: { role: 'user', content: repeatedText }
    },
    {
      type: 'message',
      id: 'pi-rec-002',
      parentId: 'pi-rec-001',
      timestamp: '2026-10-03T01:06:00Z',
      message: { role: 'user', content: repeatedText }
    }
  ]
  await writeFile(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const storePath = join(rootDir, 'sessions.json')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  await store.compareAndSwap(null, {
    kind: 'agent',
    agentSessionId: sessionId,
    providerId: 'pi',
    executorId: 'pi',
    hostId: 'local',
    workspacePath: rootDir,
    run: { runId: `run-${sessionId}` },
    retiredRuns: [],
    hookBindingId: 'spine-binding',
    hookToken: 'spine-token',
    createdAt: 1,
    updatedAt: 1,
    nativeHandle: {
      kind: 'provider',
      providerId: 'pi',
      sessionId: nativeSessionId,
      transcriptPath
    }
  })

  const client = new AgentMuxClient({ store })
  clients.push(client)
  const inner = client as unknown as { registry: { load(host: string): Promise<void> } }
  await inner.registry.load('local')

  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (_control, options) =>
    client.sessionHistoryPage(sessionId, options)
  )

  const sessionSnap = {
    ...composerSession(sessionId, 'pi'),
    workspacePath: rootDir,
    control: { kind: 'agent' as const, hostId: 'local', agentSessionId: sessionId, run: { runId: `run-${sessionId}` } }
  }

  // Also have a completed captured submission with the same exact text
  useAppStore.setState({
    sessions: [sessionSnap],
    timelines: {
      [sessionId]: {
        agentSessionId: sessionId,
        revision: 1,
        items: [
          {
            id: 'prompt:captured-same-text',
            agentSessionId: sessionId,
            kind: 'user_message',
            status: 'complete',
            source: 'user',
            createdAt: 1790900000000,
            updatedAt: 1790900000000,
            title: 'Submitted prompt',
            content: repeatedText
          }
        ]
      }
    },
    agentSteerQueues: {}
  })

  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
  await act(async () => {
    await vi.waitFor(() => {
      expect(trigger()).toBeTruthy()
    })
  })
  await act(async () => {
    await toggle('open')
    await folder('outbox')
  })

  // All 3 messages with the exact same text appear in Outbox distinctly
  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      const messages = [...outboxPanel.querySelectorAll('.composer-mailbox__messages li p')].map((p) => p.textContent)
      expect(messages.filter((m) => m === repeatedText)).toHaveLength(3)
    }, { timeout: 1000 })
  })

  const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
  const headers = [...outboxPanel.querySelectorAll('.composer-mailbox__messages li header strong')].map((h) => h.textContent)
  // 2 native recorded + 1 captured sent
  expect(headers.filter((h) => h === 'Recorded')).toHaveLength(2)
  expect(headers.filter((h) => h === 'Sent')).toHaveLength(1)
})

it('queue reconciliation does not eliminate queued messages by matching text, timestamps, or unverified native IDs', async () => {
  const sessionId = 'agent-outbox-collision'
  const rootDir = await mkdtemp(join(tmpdir(), 'mailbox-outbox-collision-'))
  const transcriptPath = join(rootDir, 'claude.jsonl')
  const nativeSessionId = 'spine-collision-sess'

  const lines = [
    {
      sessionId: nativeSessionId,
      uuid: 'unsubmitted-one',
      type: 'user',
      message: { role: 'user', content: 'Identical message text in queue and native' },
      timestamp: '2026-10-03T01:00:00.000Z'
    },
    {
      sessionId: nativeSessionId,
      uuid: 'prompt:unsubmitted-two',
      type: 'user',
      message: { role: 'user', content: 'Another native record' },
      timestamp: '2026-10-03T01:00:10.000Z'
    }
  ]
  await writeFile(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const storePath = join(rootDir, 'sessions.json')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  await store.compareAndSwap(null, {
    kind: 'agent',
    agentSessionId: sessionId,
    providerId: 'claude',
    executorId: 'claude',
    hostId: 'local',
    workspacePath: rootDir,
    run: { runId: `run-${sessionId}` },
    retiredRuns: [],
    hookBindingId: 'spine-binding',
    hookToken: 'spine-token',
    createdAt: 1,
    updatedAt: 1,
    nativeHandle: {
      kind: 'provider',
      providerId: 'claude',
      sessionId: nativeSessionId,
      transcriptPath
    }
  })

  const client = new AgentMuxClient({ store })
  clients.push(client)
  const inner = client as unknown as { registry: { load(host: string): Promise<void> } }
  await inner.registry.load('local')

  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (_control, options) =>
    client.sessionHistoryPage(sessionId, options)
  )

  const queue = [
    { operationId: 'unsubmitted-one', runId: `run-${sessionId}`, text: 'Identical message text in queue and native', status: 'deferred' as const },
    { operationId: 'unsubmitted-two', runId: `run-${sessionId}`, text: 'Keep unsent request two', status: 'deferred' as const }
  ]

  const sessionSnap = {
    ...composerSession(sessionId, 'claude'),
    workspacePath: rootDir,
    control: { kind: 'agent' as const, hostId: 'local', agentSessionId: sessionId, run: { runId: `run-${sessionId}` } }
  }

  useAppStore.setState({
    sessions: [sessionSnap],
    timelines: { [sessionId]: { agentSessionId: sessionId, revision: 0, items: [] } },
    agentSteerQueues: { [sessionId]: queue }
  })

  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
  await act(async () => {
    await vi.waitFor(() => {
      expect(trigger()).toBeTruthy()
    })
  })
  await act(async () => {
    await toggle('open')
    await folder('outbox')
  })

  // Wait for native items to arrive and appear below
  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      const messages = [...outboxPanel.querySelectorAll('.composer-mailbox__messages li p')].map((p) => p.textContent)
      expect(messages).toContain('Identical message text in queue and native')
      expect(messages).toContain('Another native record')
    })
  })

  // Queued operations must NOT be eliminated by rawId collision or identical text with native records
  const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
  const queuedTexts = [...outboxPanel.querySelectorAll('.composer-outbox li > span:first-child')].map((s) => s.textContent)
  expect(queuedTexts).toEqual(queue.map((q) => q.text))
})

it('queue actions (send queued, copy, remove, move) remain functional in Outbox alongside native records', async () => {
  const sessionId = 'agent-outbox-actions'
  await setupProductionClaudeSpine(sessionId)

  const queue = [
    { operationId: 'queued-act-1', runId: `run-${sessionId}`, text: 'First queued message', status: 'deferred' as const },
    { operationId: 'queued-act-2', runId: `run-${sessionId}`, text: 'Second queued message', status: 'queued' as const }
  ]
  useAppStore.setState({ agentSteerQueues: { [sessionId]: queue } })

  const send = vi.spyOn(useAppStore.getState(), 'sendQueuedAgentSteer').mockResolvedValue()
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  vi.spyOn(useAppStore.getState(), 'flushAgentSteerQueue').mockResolvedValue()

  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
  await act(async () => {
    await toggle('open')
    await folder('outbox')
  })

  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      expect(outboxPanel.textContent).toContain('First queued message')
      expect(outboxPanel.textContent).toContain('Terminal input message alpha')
    })
  })

  const action = async (text: string) => {
    const button = [...mailbox().querySelectorAll<HTMLButtonElement>('.composer-outbox button')].find(
      (item) => item.textContent?.trim() === text
    )
    expect(button).toBeDefined()
    await act(async () => button!.click())
  }

  await action('Send queued message')
  expect(send).toHaveBeenCalledExactlyOnceWith(sessionId, 'queued-act-1')

  await action('Copy all')
  expect(copy).toHaveBeenCalledExactlyOnceWith('First queued message\n\nSecond queued message')

  await action('Remove')
  expect(useAppStore.getState().agentSteerQueues[sessionId]).toEqual([queue[1]])

  // Native messages below remain intact
  const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
  expect(outboxPanel.textContent).toContain('Terminal input message alpha')
  expect(outboxPanel.textContent).toContain('Second terminal command bravo')
})

it('unrelated activity and context output do not recompute fingerprints or re-read native history, retaining folder, read receipts, and records', async () => {
  const sessionId = 'agent-outbox-activity-retention'
  const spine = await setupProductionClaudeSpine(sessionId)
  const historyPageSpy = vi.mocked(api.sessions.historyPage)

  useAppStore.setState({
    timelines: {
      [sessionId]: {
        agentSessionId: sessionId,
        revision: 1,
        items: [
          {
            id: 'prompt:inbox-1',
            agentSessionId: sessionId,
            kind: 'user_message',
            status: 'complete',
            source: 'user',
            createdAt: 1790900000000,
            updatedAt: 1790900000000,
            title: 'Agent incoming',
            authorAgentSessionId: 'remote-agent-1',
            content: 'Incoming message from remote'
          }
        ]
      }
    }
  })

  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
  await act(async () => {
    await toggle('open')
  })

  // In Inbox, wait for read receipts and fingerprints to settle
  await act(async () => {
    await settleFingerprints()
  })

  // Switch to Outbox
  await act(async () => {
    await folder('outbox')
  })
  expect(dom.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Outbox')

  // Wait for native items to appear in Outbox
  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      expect(outboxPanel.textContent).toContain('Terminal input message alpha')
    })
    await settleFingerprints()
  })

  // Record baseline counts
  const initialDigestCalls = digest.mock.calls.length
  expect(initialDigestCalls).toBeGreaterThan(0)
  const initialHistoryCalls = historyPageSpy.mock.calls.length
  expect(initialHistoryCalls).toBeGreaterThan(0)
  const initialReceipts = { ...useAppStore.getState().noticeReadReceipts[`mail:${sessionId}`] }

  // 1. Unrelated activity arrives on the SAME session's timeline
  await act(async () => {
    useAppStore.setState((state) => ({
      timelines: {
        ...state.timelines,
        [sessionId]: {
          ...state.timelines[sessionId]!,
          revision: 2,
          items: [
            ...state.timelines[sessionId]!.items,
            {
              id: 'tool-call-1',
              agentSessionId: sessionId,
              kind: 'tool_call',
              status: 'complete',
              source: 'native-hook',
              createdAt: 1790900001000,
              updatedAt: 1790900001000,
              title: 'Tool execution'
            }
          ]
        }
      }
    }))
  })

  // Settle any potential microtasks
  await act(async () => {
    await new Promise((res) => setTimeout(res, 30))
  })

  // Assert: ZERO new digest calls! ZERO new historyPage calls!
  expect(digest.mock.calls.length).toBe(initialDigestCalls)
  expect(historyPageSpy.mock.calls.length).toBe(initialHistoryCalls)
  // Read receipts preserved!
  expect(useAppStore.getState().noticeReadReceipts[`mail:${sessionId}`]).toEqual(initialReceipts)
  // Folder remains Outbox!
  expect(dom.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Outbox')
  // Native records still intact!
  const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
  expect(outboxPanel.textContent).toContain('Terminal input message alpha')

  // 2. Completely unrelated Context updates with normal output
  await act(async () => {
    useAppStore.setState((state) => ({
      timelines: {
        ...state.timelines,
        'unrelated-session-42': {
          agentSessionId: 'unrelated-session-42',
          revision: 5,
          items: [
            {
              id: 'unrelated-output-1',
              agentSessionId: 'unrelated-session-42',
              kind: 'tool_call',
              status: 'complete',
              source: 'native-hook',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              title: 'Unrelated work'
            }
          ]
        }
      }
    }))
  })

  await act(async () => {
    await new Promise((res) => setTimeout(res, 30))
  })

  // Assert: ZERO new digest calls! ZERO new historyPage calls!
  expect(digest.mock.calls.length).toBe(initialDigestCalls)
  expect(historyPageSpy.mock.calls.length).toBe(initialHistoryCalls)
  expect(useAppStore.getState().noticeReadReceipts[`mail:${sessionId}`]).toEqual(initialReceipts)
  expect(dom.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Outbox')

  // 3. Close mailbox: zero new reads
  await act(async () => {
    await toggle('closed')
  })
  expect(mailbox().getAttribute('data-state')).toBe('closed')
  expect(historyPageSpy.mock.calls.length).toBe(initialHistoryCalls)

  // 4. Cross-session fresh mount consumer reads its own source
  const session2Id = 'agent-second-isolated-session'
  const spine2 = await setupProductionClaudeSpine(session2Id)
  await dom.render(<AgentSessionComposer sessionId={session2Id} />)
  await act(async () => {
    await toggle('open')
    await folder('outbox')
  })
  await act(async () => {
    await vi.waitFor(() => {
      const p2 = dom.container.querySelector('[id$="-outbox"]')!
      expect(p2.textContent).toContain('Terminal input message alpha')
    })
  })
  // session 2 read its own historyPage
  expect(historyPageSpy.mock.calls.some((call) => call[0].agentSessionId === session2Id)).toBe(true)

  spine.verifyZeroControls()
  spine2.verifyZeroControls()
})

it('transport read failure preserves queued messages, drafts, and existing observed records with visible retry button without auto-resend', async () => {
  const sessionId = 'agent-outbox-error-handling'
  const spine = await setupProductionClaudeSpine(sessionId)

  const queue = [
    { operationId: 'queued-error-test', runId: `run-${sessionId}`, text: 'Queued item during error', status: 'queued' as const }
  ]
  useAppStore.setState({
    agentSteerQueues: { [sessionId]: queue },
    agentComposerDrafts: { [sessionId]: 'Unsent draft text' }
  })

  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
  await act(async () => {
    await toggle('open')
    await folder('outbox')
  })

  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      expect(outboxPanel.textContent).toContain('Terminal input message alpha')
      expect(outboxPanel.textContent).toContain('Queued item during error')
    })
  })

  // Mock transport error
  let failedCalls = 0
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async () => {
    failedCalls++
    throw new Error('Simulated network transport error')
  })

  // Trigger retry / refresh
  const snap = useAppStore.getState().sessions.find((s) => s.id === sessionId)!
  useAppStore.setState({
    sessions: [{ ...snap, updatedAt: 3, agentSessionUpdatedAt: 3 }]
  })

  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      expect(outboxPanel.textContent).toContain('Failed to read native conversation history')
      expect(outboxPanel.textContent).toContain('Simulated network transport error')
    })
  })

  // Existing observed messages and queued items remain visible
  const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
  expect(outboxPanel.textContent).toContain('Terminal input message alpha')
  expect(outboxPanel.textContent).toContain('Second terminal command bravo')
  expect(outboxPanel.textContent).toContain('Queued item during error')

  // Draft in composer was not cleared
  expect(useAppStore.getState().agentComposerDrafts[sessionId]).toBe('Unsent draft text')

  // Visible retry button exists
  const retryBtn = outboxPanel.querySelector('.composer-mailbox__error button')
  expect(retryBtn).not.toBeNull()
  expect(retryBtn?.textContent).toBe('Retry')

  // Zero runtime control operations
  spine.verifyZeroControls()
})

it('mixed mounted surface: timeline captured item and native item with legal identical ID do not collide React keys', async () => {
  const sessionId = 'agent-outbox-mixed-collision'
  const spine = await setupProductionClaudeSpine(sessionId)

  const collisionId = 'native:claude:spine-claude-sess:claude-u-102'

  // Timeline has a completed captured message whose ID equals the native item's stableId
  useAppStore.setState({
    timelines: {
      [sessionId]: {
        agentSessionId: sessionId,
        revision: 1,
        items: [
          {
            id: collisionId,
            agentSessionId: sessionId,
            kind: 'user_message',
            status: 'complete',
            source: 'user',
            createdAt: 1790900000000,
            updatedAt: 1790900000000,
            title: 'Captured message with colliding ID',
            content: 'Captured prompt text matching collision ID'
          }
        ]
      }
    }
  })

  const errorSpy = vi.spyOn(console, 'error')

  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
  await act(async () => {
    await toggle('open')
    await folder('outbox')
  })

  // All 3 messages rendered (2 native + 1 captured)
  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      const items = outboxPanel.querySelectorAll('.composer-mailbox__messages li')
      expect(items).toHaveLength(3)
      expect(outboxPanel.textContent).toContain('Terminal input message alpha')
      expect(outboxPanel.textContent).toContain('Second terminal command bravo')
      expect(outboxPanel.textContent).toContain('Captured prompt text matching collision ID')
    })
  })

  // No duplicate key warning logged to console.error
  const keyWarnings = errorSpy.mock.calls.filter((call) =>
    call.some((arg) => String(arg).includes('Encountered two children with the same key'))
  )
  expect(keyWarnings).toHaveLength(0)

  // Append 4th message and verify dynamic list update preserves unique keys and content
  const fourthLine = {
    sessionId: 'spine-claude-sess',
    uuid: 'claude-u-104',
    type: 'user',
    message: { role: 'user', content: 'Fourth appended dynamic message' },
    timestamp: '2026-10-03T01:12:00.000Z'
  }
  await appendFile(spine.transcriptPath, JSON.stringify(fourthLine) + '\n')
  const snap = useAppStore.getState().sessions.find((s) => s.id === sessionId)!
  useAppStore.setState({
    sessions: [{ ...snap, updatedAt: 3, agentSessionUpdatedAt: 3 }]
  })

  await act(async () => {
    await toggle('closed')
    await toggle('open')
  })

  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      expect(outboxPanel.querySelectorAll('.composer-mailbox__messages li')).toHaveLength(4)
      expect(outboxPanel.textContent).toContain('Fourth appended dynamic message')
    })
  })

  const postUpdateWarnings = errorSpy.mock.calls.filter((call) =>
    call.some((arg) => String(arg).includes('Encountered two children with the same key'))
  )
  expect(postUpdateWarnings).toHaveLength(0)
  errorSpy.mockRestore()
  spine.verifyZeroControls()
})

it('public captured unverified record without a queue entry remains visible in Outbox with Delivery not confirmed header and exact count', async () => {
  const sid = 'owner-unverified-without-queue'
  const spine = await setupProductionClaudeSpine(sid)

  useAppStore.setState({
    timelines: {
      [sid]: {
        agentSessionId: sid,
        revision: 1,
        items: [
          {
            id: 'prompt:accepted-unverified',
            agentSessionId: sid,
            kind: 'user_message',
            status: 'streaming',
            source: 'user',
            createdAt: 1790900000000,
            updatedAt: 1790900000000,
            title: 'Pending confirmation',
            content: 'Captured accepted input without delivery confirmation'
          }
        ]
      }
    }
  })

  await dom.render(<AgentSessionComposer sessionId={sid} />)
  await act(async () => {
    await toggle('open')
    await folder('outbox')
  })

  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      expect(outboxPanel.textContent).toContain('Terminal input message alpha')
    })
  })

  const panel = dom.container.querySelector('[id$="-outbox"]')!
  expect(panel.textContent).toContain('Captured accepted input without delivery confirmation')
  expect(dom.container.querySelector('[role="tab"][id$="-outbox-tab"]')?.textContent).toContain('Outbox (3)')

  // Verify honest labeling: header is 'Delivery not confirmed', NOT 'Sent', NOT 'Recorded'
  const unverifiedItem = Array.from(panel.querySelectorAll('.composer-mailbox__messages li')).find(
    (li) => li.textContent?.includes('Captured accepted input without delivery confirmation')
  )!
  expect(unverifiedItem).toBeDefined()
  expect(unverifiedItem.querySelector('header strong')?.textContent).toBe('Delivery not confirmed')

  // Unverified item is NOT failed: no retry hint, no copy button
  expect(unverifiedItem.textContent).not.toContain('Check the Agent’s response before sending again.')
  expect(unverifiedItem.querySelector('button.composer-tool')).toBeNull()

  spine.verifyZeroControls()
})

it('knownAgent incoming unverified stream enters Inbox with remote agent identity, while unverified submission ID never eliminates matching queued item', async () => {
  const sid = 'owner-known-agent-unverified-incoming'
  const spine = await setupProductionClaudeSpine(sid)

  // 1. Unverified incoming message from a remote agent
  // 2. Unverified outgoing submission matching an unsubmitted queued message ID
  const queue = [
    {
      operationId: 'steer-op-unverified-match',
      runId: `run-${sid}`,
      text: 'Queued user message awaiting confirmation',
      status: 'queued' as const
    }
  ]

  useAppStore.setState({
    timelines: {
      [sid]: {
        agentSessionId: sid,
        revision: 1,
        items: [
          {
            id: 'prompt:peer-stream-1',
            agentSessionId: sid,
            kind: 'user_message',
            status: 'streaming',
            source: 'user',
            createdAt: 1790900000000,
            updatedAt: 1790900000000,
            title: 'Peer incoming stream',
            authorAgentSessionId: 'remote-agent-collaborator',
            content: 'Incoming stream from peer agent'
          },
          {
            id: 'prompt:steer-op-unverified-match',
            agentSessionId: sid,
            kind: 'user_message',
            status: 'streaming',
            source: 'user',
            createdAt: 1790900001000,
            updatedAt: 1790900001000,
            title: 'Unverified outgoing submission',
            content: 'Queued user message awaiting confirmation'
          }
        ]
      }
    },
    agentSteerQueues: {
      [sid]: queue
    }
  })

  await dom.render(<AgentSessionComposer sessionId={sid} />)
  await act(async () => {
    await toggle('open')
  })

  // Inbox verification:
  await act(async () => {
    await folder('inbox')
  })
  expect(dom.container.querySelector('[role="tab"][id$="-inbox-tab"]')?.textContent).toContain('Inbox (1)')
  const inboxPanel = dom.container.querySelector('[id$="-inbox"]')!
  expect(inboxPanel.textContent).toContain('Incoming stream from peer agent')
  // Verify remote agent identity: labeled with agent prefix/name, never 'Human', never 'You'
  const incomingHeader = inboxPanel.querySelector('.composer-mailbox__messages li header strong')?.textContent
  expect(incomingHeader).toContain('Agent remote-a')
  expect(incomingHeader).not.toContain('Human')
  expect(incomingHeader).not.toContain('You')

  // Outbox verification:
  await act(async () => {
    await folder('outbox')
  })
  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      expect(outboxPanel.textContent).toContain('Terminal input message alpha')
    })
  })

  const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
  // Remote agent incoming does NOT leak into Outbox
  expect(outboxPanel.textContent).not.toContain('Incoming stream from peer agent')

  // Critical queue reconciliation proof:
  // Unverified streaming status DOES NOT eliminate the queued message!
  // Total Outbox count: 1 pending queued + 1 captured unverified sent + 2 native sent = 4
  expect(dom.container.querySelector('[role="tab"][id$="-outbox-tab"]')?.textContent).toContain('Outbox (4)')

  // Pending queue item remains visible in Outbox pending section
  const pendingSection = outboxPanel.querySelector('.composer-outbox')
  expect(pendingSection).not.toBeNull()
  expect(pendingSection?.textContent).toContain('Queued user message awaiting confirmation')

  spine.verifyZeroControls()
})
