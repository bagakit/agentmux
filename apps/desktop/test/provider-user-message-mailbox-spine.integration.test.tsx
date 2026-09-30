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
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
let disposeBootstrap: (() => void) | undefined
const clients: AgentMuxClient[] = []

beforeAll(async () => {
  disposeBootstrap = await useAppStore.getState().initialize()
})

afterAll(() => {
  disposeBootstrap?.()
})

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.dispose()
  }
  vi.restoreAllMocks()
})

const trigger = () => dom.container.querySelector<HTMLButtonElement>('.composer__mailbox')!
const mailbox = () => dom.container.querySelector<HTMLDivElement>('.composer-mailbox')!

let digest: { mock: { results: { value: unknown }[] } }
beforeEach(() => {
  digest = vi.spyOn(crypto.subtle, 'digest')
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

  const controlNames = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'] as const
  const controls = controlNames.map((name) => ({
    name,
    spy: vi.spyOn(inner.kernel as Record<string, (...args: unknown[]) => unknown>, name).mockImplementation(() => {
      throw new Error(`Forbidden Runtime control operation: ${name}`)
    })
  }))

  const verifyZeroControls = () => {
    expect(controls).toHaveLength(7)
    expect(controls.map((c) => c.name)).toEqual(['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'])
    expect(controls.map((c) => c.spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
  }

  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (_control, options) =>
    client.sessionHistoryPage(sessionId, options)
  )

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

it('delivers terminal native user inputs to mounted AgentSessionComposer and SessionMailbox Outbox with zero Runtime controls', async () => {
  const sessionId = 'agent-spine-1'
  const spine = await setupProductionClaudeSpine(sessionId)

  await dom.render(<AgentSessionComposer sessionId={sessionId} />)

  await act(async () => {
    await vi.waitFor(() => {
      const btn = trigger()
      expect(btn).toBeTruthy()
    })
  })

  await act(async () => {
    await toggle('open')
    await folder('outbox')
  })

  // Both native inputs must appear in Outbox
  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      expect(outboxPanel.textContent).toContain('Terminal input message alpha')
      expect(outboxPanel.textContent).toContain('Second terminal command bravo')
    }, { timeout: 1000 })
  })

  const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!

  // Native input is recorded in session history; must NOT claim 'Sent' or 'Delivery not confirmed'
  const headers = [...outboxPanel.querySelectorAll('.composer-mailbox__history .composer-mailbox__row > strong')].map((h) => h.textContent)
  expect(headers).toContain('Recorded')
  expect(headers).not.toContain('Sent')
  expect(headers).not.toContain('You')

  // Timestamps accurately formatted
  const times = [...outboxPanel.querySelectorAll('time')].map((t) => t.getAttribute('dateTime'))
  expect(times).toEqual(['2026-10-03T01:10:30.000Z', '2026-10-03T01:10:00.000Z'])

  spine.verifyZeroControls()
})

it('preserves distinct records in Outbox when identical prompt text is entered repeatedly', async () => {
  const sessionId = 'agent-spine-2'
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

  useAppStore.setState({
    sessions: [sessionSnap],
    timelines: { [sessionId]: { agentSessionId: sessionId, revision: 0, items: [] } },
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

  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      const messages = [...outboxPanel.querySelectorAll('.composer-mailbox__history .composer-mailbox__preview')].map((p) => p.textContent)
      expect(messages.filter((m) => m === repeatedText)).toHaveLength(2)
    }, { timeout: 1000 })
  })
})

it('unverified correlation: native raw IDs matching unsent operations do not hide queued messages', async () => {
  const sessionId = 'agent-spine-collision'
  const rootDir = await mkdtemp(join(tmpdir(), 'mailbox-spine-collision-'))
  const transcriptPath = join(rootDir, 'claude.jsonl')
  const nativeSessionId = 'spine-collision-sess'

  // Transcript contains records with IDs identical to queued operation IDs
  const lines = [
    {
      sessionId: nativeSessionId,
      uuid: 'unsubmitted-one',
      type: 'user',
      message: { role: 'user', content: 'Unrelated native message 0' },
      timestamp: '2026-10-03T01:00:00.000Z'
    },
    {
      sessionId: nativeSessionId,
      uuid: 'prompt:unsubmitted-two',
      type: 'user',
      message: { role: 'user', content: 'Unrelated native message 1' },
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
    { operationId: 'unsubmitted-one', runId: `run-${sessionId}`, text: 'Keep unsent request one', status: 'deferred' as const },
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

  // Queued operations must NOT be eliminated by rawId collision with native records
  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      const queuedTexts = [...outboxPanel.querySelectorAll('.composer-outbox .composer-mailbox__preview')].map((s) => s.textContent)
      expect(queuedTexts).toEqual(queue.map((q) => q.text))
    })
  })
})

it('page 30 boundary: non-null native continuation remains honestly visible with on-demand load earlier', async () => {
  const sessionId = 'agent-spine-boundary'
  const rootDir = await mkdtemp(join(tmpdir(), 'mailbox-spine-boundary-'))
  const transcriptPath = join(rootDir, 'claude.jsonl')
  const nativeSessionId = 'spine-boundary-sess'

  // Generate 31 native records: newest page of limit 30 leaves 1 older record
  const lines = Array.from({ length: 31 }, (_, i) => ({
    sessionId: nativeSessionId,
    uuid: `boundary-item-${String(i).padStart(3, '0')}`,
    type: 'user',
    message: { role: 'user', content: `Message item index ${i}` },
    timestamp: new Date(1790900000000 + i * 1000).toISOString()
  }))
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

  // Boundary notice must be honestly visible matching pattern
  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      const boundaryVisible = /earlier|older|more records|partial history|30 of 31|latest 30/i.test(
        outboxPanel.textContent ?? ''
      )
      expect(boundaryVisible).toBe(true)
    })
  })

  // Click Load earlier messages button
  await dom.click('.composer-mailbox__boundary button')

  // Verify all 31 source records survive paging and the reading list shows their original timestamps newest first.
  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      const items = outboxPanel.querySelectorAll('.composer-mailbox__history .composer-mailbox__messages li')
      expect(items).toHaveLength(31)
    }, { timeout: 1000 })
  })

  const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
  const bodies = [...outboxPanel.querySelectorAll('.composer-mailbox__history .composer-mailbox__preview')].map((p) => p.textContent)
  expect(bodies).toEqual(Array.from({ length: 31 }, (_, i) => `Message item index ${30 - i}`))
})

it('mounting Composer with closed Mailbox must not read native history', async () => {
  const sessionId = 'agent-spine-closed'
  const spine = await setupProductionClaudeSpine(sessionId)
  const historyPageSpy = vi.spyOn(api.sessions, 'historyPage')

  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
  expect(mailbox().getAttribute('data-state')).toBe('closed')
  expect(historyPageSpy).not.toHaveBeenCalled()
  spine.verifyZeroControls()
})

it('equal control facts: read failure preserves already observed native messages through fresh projection objects', async () => {
  const sessionId = 'agent-spine-error-preserve'
  const spine = await setupProductionClaudeSpine(sessionId)
  const session = useAppStore.getState().sessions[0]!

  function ReaderWithError({ control }: { control: typeof session.control }) {
    const reading = useSessionUserMessages(control, { enabled: true })
    return (
      <section data-reader="error-test" data-error={reading.error?.message}>
        <button data-retry={true} onClick={() => void reading.refresh()}>
          Retry
        </button>
        {reading.messages.map((m) => (
          <p key={m.id} data-raw-id={m.rawId}>
            {m.content}
          </p>
        ))}
      </section>
    )
  }

  await dom.render(<ReaderWithError control={session.control} />)

  await act(async () => {
    await vi.waitFor(() => {
      const ids = [...dom.container.querySelectorAll('[data-reader="error-test"] p')].map((el) => el.getAttribute('data-raw-id'))
      expect(ids).toEqual(['claude-u-101', 'claude-u-102'])
    }, { timeout: 1000 })
  })

  // Simulate transport failure and count calls
  let failedCalls = 0
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async () => {
    failedCalls++
    throw new Error('Simulated transport failure')
  })

  // Trigger explicit refresh to encounter the transport error
  await dom.click('[data-retry]')
  await act(async () => {
    await vi.waitFor(() => {
      expect(dom.container.querySelector('[data-reader="error-test"]')?.getAttribute('data-error')).toBe(
        'Simulated transport failure'
      )
    })
  })

  expect(failedCalls).toBe(1)

  // Observed messages must be preserved across transport failure
  let renderedRawIds = [...dom.container.querySelectorAll('[data-reader="error-test"] p')].map(
    (el) => el.getAttribute('data-raw-id')
  )
  expect(renderedRawIds).toEqual(['claude-u-101', 'claude-u-102'])

  // NOW parent re-renders with fresh equal DTO after error was caught and settled
  const sameFacts = { ...session.control, run: { ...session.control.run } }
  const updatedSession = { ...session, control: sameFacts }
  useAppStore.setState({ sessions: [updatedSession] })

  await dom.render(<ReaderWithError control={sameFacts} />)

  // Assert old records and error are still preserved, and no re-fetch occurred
  expect(failedCalls).toBe(1)
  expect(dom.container.querySelector('[data-reader="error-test"]')?.getAttribute('data-error')).toBe(
    'Simulated transport failure'
  )
  renderedRawIds = [...dom.container.querySelectorAll('[data-reader="error-test"] p')].map(
    (el) => el.getAttribute('data-raw-id')
  )
  expect(renderedRawIds).toEqual(['claude-u-101', 'claude-u-102'])
  spine.verifyZeroControls()
})

it('reopening Mailbox after session facts update reads new appended native input', async () => {
  const sessionId = 'agent-spine-live-append'
  const spine = await setupProductionClaudeSpine(sessionId)

  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
  await act(async () => {
    await toggle('open')
    await folder('outbox')
  })

  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      expect(outboxPanel.textContent).toContain('Terminal input message alpha')
    }, { timeout: 1000 })
  })

  // Append 3rd message to native transcript
  const thirdLine = {
    sessionId: 'spine-claude-sess',
    uuid: 'claude-u-103',
    type: 'user',
    message: { role: 'user', content: 'New appended third input' },
    timestamp: '2026-10-03T01:11:00.000Z'
  }
  await appendFile(spine.transcriptPath, JSON.stringify(thirdLine) + '\n')

  // Session facts update in store
  const currentSnap = useAppStore.getState().sessions.find((s) => s.id === sessionId)!
  await act(async () => useAppStore.setState({
    sessions: [{ ...currentSnap, updatedAt: 2, agentSessionUpdatedAt: 2 }]
  }))

  // Reopening / toggling mailbox refreshes and displays third message
  await act(async () => {
    await toggle('closed')
    await toggle('open')
    await folder('outbox')
  })

  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      expect(outboxPanel.textContent).toContain('New appended third input')
    })
  })
})

it('routes incoming Agent messages to Inbox and keeps pending queued messages alongside native Outbox', async () => {
  const sessionId = 'agent-spine-3'
  await setupProductionClaudeSpine(sessionId)

  useAppStore.setState({
    timelines: {
      [sessionId]: {
        agentSessionId: sessionId,
        revision: 1,
        items: [
          {
            id: 'prompt:incoming-agent-msg',
            agentSessionId: sessionId,
            kind: 'user_message',
            status: 'complete',
            source: 'user',
            createdAt: 1790900000000,
            updatedAt: 1790900000000,
            title: 'Agent instruction',
            authorAgentSessionId: 'remote-agent-42',
            content: 'Task dispatched from remote peer'
          }
        ]
      }
    },
    agentSteerQueues: {
      [sessionId]: [
        {
          operationId: 'op-pending-1',
          text: 'Queued draft not yet sent',
          status: 'queued',
          enqueuedAt: 1790900010000
        }
      ]
    }
  })

  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
  await act(async () => {
    await vi.waitFor(() => {
      expect(trigger()).toBeTruthy()
    })
  })
  await toggle('open')

  // Inbox contains the message from the other Agent
  await folder('inbox')
  await act(async () => {
    await vi.waitFor(() => {
      const inboxPanel = dom.container.querySelector('[id$="-inbox"]')!
      expect(inboxPanel.textContent).toContain('Task dispatched from remote peer')
    })
  })

  // Outbox contains both the pending queued message and the native recorded messages
  await folder('outbox')
  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      expect(outboxPanel.textContent).toContain('Queued draft not yet sent')
      expect(outboxPanel.textContent).toContain('Terminal input message alpha')
    }, { timeout: 1000 })
  })
})

it('remount after consumer unmount discards late result from departed lifetime and reads fresh source', async () => {
  const sessionId = 'agent-spine-departed-remount'
  const spine = await setupProductionClaudeSpine(sessionId)

  let resolveFirstCall: ((page: any) => void) | undefined
  let firstCallArrived: (() => void) | undefined
  const firstCallArrivedPromise = new Promise<void>((res) => {
    firstCallArrived = res
  })
  const firstCallPromise = new Promise((res) => {
    resolveFirstCall = res
  })

  let callCount = 0
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (_control, options) => {
    callCount++
    if (callCount === 1) {
      const page = await spine.client.sessionHistoryPage(sessionId, options)
      expect(page.items.map((i: any) => i.id)).toEqual(['claude-u-101', 'claude-u-102'])
      expect(page.source.nativeSessionId).toBe('spine-claude-sess')
      firstCallArrived?.()
      await firstCallPromise
      return page
    }
    return spine.client.sessionHistoryPage(sessionId, options)
  })

  // Mount consumer and open mailbox to start first read
  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
  await act(async () => {
    await toggle('open')
  })

  // Pin that initial read was dispatched, real public read completed, and entered delay gate before unmount!
  await act(async () => {
    await firstCallArrivedPromise
  })
  expect(callCount).toBe(1)

  // Unmount consumer
  await dom.render(null)

  // Append 3rd message to native transcript
  const thirdLine = {
    sessionId: 'spine-claude-sess',
    uuid: 'claude-u-103',
    type: 'user',
    message: { role: 'user', content: 'Fresh third input from new lifetime' },
    timestamp: '2026-10-03T01:11:00.000Z'
  }
  await appendFile(spine.transcriptPath, JSON.stringify(thirdLine) + '\n')

  // Remount consumer
  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
  await act(async () => {
    await toggle('open')
    await folder('outbox')
  })

  // Remounted consumer must display all 3 items from fresh read before old gate is released
  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      expect(outboxPanel.textContent).toContain('Fresh third input from new lifetime')
      expect(outboxPanel.textContent).toContain('Terminal input message alpha')
      expect(outboxPanel.textContent).toContain('Second terminal command bravo')
    })
  })
  expect(callCount).toBe(2)

  // Now release first call (from departed lifetime)
  resolveFirstCall!(null)

  // Old result must NOT overwrite the new entry (all 3 items still visible)
  const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
  expect(outboxPanel.textContent).toContain('Fresh third input from new lifetime')
  expect(outboxPanel.textContent).toContain('Terminal input message alpha')
  expect(outboxPanel.textContent).toContain('Second terminal command bravo')
  expect(callCount).toBe(2)

  spine.verifyZeroControls()
})

it('finite zero-consumer registry: production entry and native body are released after the last departure', async () => {
  const sessionId = 'agent-spine-finite-registry'
  const spine = await setupProductionClaudeSpine(sessionId)

  const setSpy = vi.spyOn(Map.prototype, 'set')
  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
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

  const observed = setSpy.mock.calls
    .map((call, index) => ({ key: call[0], entry: call[1], registry: setSpy.mock.contexts[index] }))
    .filter(
      (value) =>
        value.entry?.agentSessionId === sessionId &&
        value.entry?.subscribers instanceof Set &&
        value.registry instanceof Map
    )
  expect(observed.length).toBeGreaterThan(0)
  const [{ key, entry, registry }] = observed
  expect(registry!.get(key)).toBe(entry)
  expect(entry.subscribers.size).toBe(1)
  expect(entry.historyPage.items.map((item: any) => item.id)).toEqual(['claude-u-101', 'claude-u-102'])
  setSpy.mockRestore()

  // Unmount consumer
  await dom.render(null)
  expect(entry.subscribers.size).toBe(0)
  expect(registry!.has(key)).toBe(false)
  expect(entry.historyPage).toBeNull()
  expect(entry.items).toEqual([])

  spine.verifyZeroControls()
})

it('revalidation shared by two consumers: one fresh public read satisfies one related native change', async () => {
  const sessionId = 'agent-spine-revalidation-two'
  const spine = await setupProductionClaudeSpine(sessionId)

  // Mount consumer 1 and read 2 items
  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
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

  // Unmount consumer 1
  await dom.render(null)

  // Append 3rd message
  const thirdLine = {
    sessionId: 'spine-claude-sess',
    uuid: 'claude-u-103',
    type: 'user',
    message: { role: 'user', content: 'Revalidation third native record' },
    timestamp: '2026-10-03T01:11:00.000Z'
  }
  await appendFile(spine.transcriptPath, JSON.stringify(thirdLine) + '\n')

  let bridgeCalls = 0
  let resolveDelayedRequest: (() => void) | undefined
  const delayedPromise = new Promise<void>((res) => {
    resolveDelayedRequest = res
  })

  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (_control, options) => {
    bridgeCalls++
    const page = await spine.client.sessionHistoryPage(sessionId, options)
    await delayedPromise
    return page
  })

  // Mount two consumers simultaneously
  function TwoMailboxConsumers() {
    const session = useAppStore.getState().sessions.find((s) => s.id === sessionId)!
    const { messages: msgs1 } = useSessionUserMessages(session.control, { enabled: true })
    const { messages: msgs2 } = useSessionUserMessages(session.control, { enabled: true })
    return (
      <div>
        <div data-consumer="1">{msgs1.map((m) => m.content).join(' ')}</div>
        <div data-consumer="2">{msgs2.map((m) => m.content).join(' ')}</div>
      </div>
    )
  }

  await dom.render(<TwoMailboxConsumers />)

  // Verify only 1 bridge call was initiated
  expect(bridgeCalls).toBe(1)

  // Release the delayed request
  await act(async () => {
    resolveDelayedRequest!()
  })

  // Both consumers receive all 3 messages
  await act(async () => {
    await vi.waitFor(() => {
      const c1 = dom.container.querySelector('[data-consumer="1"]')!
      const c2 = dom.container.querySelector('[data-consumer="2"]')!
      expect(c1.textContent).toContain('Revalidation third native record')
      expect(c2.textContent).toContain('Revalidation third native record')
    })
  })

  // Still exactly 1 bridge call
  expect(bridgeCalls).toBe(1)
  spine.verifyZeroControls()
})

it('aborted client render does not create speculative registry entry, then committed consumer registers and deletes on departure', async () => {
  const sessionId = 'agent-spine-aborted-render'
  const spine = await setupProductionClaudeSpine(sessionId)

  const setSpy = vi.spyOn(Map.prototype, 'set')
  const session = useAppStore.getState().sessions.find((s) => s.id === sessionId)!

  function ThrowingConsumer() {
    useSessionUserMessages(session.control, { enabled: true })
    throw new Error('Simulated aborted render')
  }

  class Boundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
    state = { hasError: false }
    static getDerivedStateFromError() {
      return { hasError: true }
    }
    render() {
      return this.state.hasError ? <div>Aborted</div> : this.props.children
    }
  }

  await dom.render(
    <Boundary>
      <ThrowingConsumer />
    </Boundary>
  )

  // Verify 0 speculative registrations occurred in the Map for this session
  const speculative = setSpy.mock.calls
    .map((c) => ({ key: c[0], entry: c[1] }))
    .filter((v) => v.entry?.agentSessionId === sessionId)
  expect(speculative).toHaveLength(0)

  // Now render a committed consumer
  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
  await act(async () => {
    await toggle('open')
  })
  await vi.waitFor(() => {
    const committed = setSpy.mock.calls
      .map((c) => ({ key: c[0], entry: c[1] }))
      .filter((v) => v.entry?.agentSessionId === sessionId)
    expect(committed.length).toBeGreaterThan(0)
  })

  // Unmount committed consumer
  await dom.render(null)
  setSpy.mockRestore()
  spine.verifyZeroControls()
})

it('an explicit refresh queues once behind a real earlier-page read in the same scope', async () => {
  const sessionId = 'agent-spine-older-refresh-queue'
  const rootDir = await mkdtemp(join(tmpdir(), 'spine-older-queue-'))
  const transcriptPath = join(rootDir, 'claude.jsonl')
  const nativeSessionId = 'spine-older-queue-sess'

  // Generate 31 native records: newest page of limit 30 leaves 1 older record
  const lines = Array.from({ length: 31 }, (_, i) => ({
    sessionId: nativeSessionId,
    uuid: `older-queue-item-${String(i).padStart(3, '0')}`,
    type: 'user',
    message: { role: 'user', content: `Message item index ${i}` },
    timestamp: new Date(1790900000000 + i * 1000).toISOString()
  }))
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

  function PagingReader() {
    const session = useAppStore.getState().sessions.find((s) => s.id === sessionId)!
    const reading = useSessionUserMessages(session.control, { enabled: true })
    return (
      <section data-reader="one" data-loading={reading.loading} data-more={reading.hasMore}>
        <button data-earlier={true} onClick={() => void reading.loadEarlier()}>
          Earlier
        </button>
        <button data-refresh={true} onClick={() => void reading.refresh()}>
          Refresh
        </button>
        {reading.messages.map((m) => (
          <p key={m.id} data-raw-id={m.rawId}>
            {m.content}
          </p>
        ))}
      </section>
    )
  }

  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (_control, options) =>
    client.sessionHistoryPage(sessionId, options)
  )

  await dom.render(<PagingReader />)
  const firstIds = Array.from({ length: 30 }, (_, index) => `older-queue-item-${String(index + 1).padStart(3, '0')}`)
  await act(async () => {
    await vi.waitFor(() => {
      const ids = [...dom.container.querySelectorAll('[data-reader="one"] p')].map((el) => el.getAttribute('data-raw-id'))
      expect(ids).toEqual(firstIds)
    })
  })
  expect(dom.container.querySelector('[data-reader="one"]')?.getAttribute('data-more')).toBe('true')

  // Setup delayed bridge calls
  const requests: Array<{ page: any; release(): void }> = []
  const bridgeSpy = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (_control, options) => {
    const page = await client.sessionHistoryPage(sessionId, options)
    await new Promise<void>((resolve) => {
      requests.push({ page, release: resolve })
    })
    return page
  })

  // Click earlier
  await dom.click('[data-earlier]')
  await act(async () => {
    await vi.waitFor(() => expect(requests).toHaveLength(1))
  })
  expect(requests[0]!.page.items.map((item: any) => item.id)).toEqual(['older-queue-item-000'])

  // Append 32nd record to native transcript
  const newLine = {
    sessionId: nativeSessionId,
    uuid: 'older-queue-new-32',
    type: 'user',
    message: { role: 'user', content: 'Message item index 32' },
    timestamp: new Date(1790900032000).toISOString()
  }
  await appendFile(transcriptPath, JSON.stringify(newLine) + '\n')
  expect((await client.sessionHistoryPage(sessionId, { limit: 100 })).items).toHaveLength(32)

  // Click refresh while earlier is still pending
  await dom.click('[data-refresh]')

  // Verify that bridge was NOT called a second time yet (queued once behind earlier!)
  if (bridgeSpy.mock.calls.length > 1) {
    await act(async () => {
      await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 1000 })
    })
  }
  expect(bridgeSpy).toHaveBeenCalledOnce()

  // Release the earlier page read
  await act(async () => {
    requests[0]!.release()
  })

  // Now the queued refresh fires!
  await act(async () => {
    await vi.waitFor(() => expect(requests).toHaveLength(2))
  })
  expect(requests[1]!.page.items.map((item: any) => item.id)).toEqual([...firstIds.slice(1), 'older-queue-new-32'])

  // Release the refresh request
  await act(async () => {
    requests[1]!.release()
  })

  // UI updates with newest items
  await act(async () => {
    await vi.waitFor(() => {
      const ids = [...dom.container.querySelectorAll('[data-reader="one"] p')].map((el) => el.getAttribute('data-raw-id'))
      expect(ids).toEqual([...firstIds.slice(1), 'older-queue-new-32'])
    })
  })
})

it('an earlier-page finalizer cannot clear loading owned by a newer still-pending refresh', async () => {
  const sessionId = 'agent-spine-older-finally-loading'
  const rootDir = await mkdtemp(join(tmpdir(), 'spine-older-finally-'))
  const transcriptPath = join(rootDir, 'claude.jsonl')
  const nativeSessionId = 'spine-older-finally-sess'

  // Generate 31 native records
  const lines = Array.from({ length: 31 }, (_, i) => ({
    sessionId: nativeSessionId,
    uuid: `older-fin-item-${String(i).padStart(3, '0')}`,
    type: 'user',
    message: { role: 'user', content: `Message item index ${i}` },
    timestamp: new Date(1790900000000 + i * 1000).toISOString()
  }))
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

  function PagingReader() {
    const session = useAppStore.getState().sessions.find((s) => s.id === sessionId)!
    const reading = useSessionUserMessages(session.control, { enabled: true })
    return (
      <section data-reader="one" data-loading={reading.loading} data-more={reading.hasMore}>
        <button data-earlier={true} onClick={() => void reading.loadEarlier()}>
          Earlier
        </button>
        <button data-refresh={true} onClick={() => void reading.refresh()}>
          Refresh
        </button>
        {reading.messages.map((m) => (
          <p key={m.id} data-raw-id={m.rawId}>
            {m.content}
          </p>
        ))}
      </section>
    )
  }

  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (_control, options) =>
    client.sessionHistoryPage(sessionId, options)
  )

  await dom.render(<PagingReader />)
  const firstIds = Array.from({ length: 30 }, (_, index) => `older-fin-item-${String(index + 1).padStart(3, '0')}`)
  await act(async () => {
    await vi.waitFor(() => {
      const ids = [...dom.container.querySelectorAll('[data-reader="one"] p')].map((el) => el.getAttribute('data-raw-id'))
      expect(ids).toEqual(firstIds)
    })
  })

  // Setup delayed requests
  const requests: Array<{ page: any; release(): void }> = []
  const bridgeSpy = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (_control, options) => {
    const page = await client.sessionHistoryPage(sessionId, options)
    await new Promise<void>((resolve) => {
      requests.push({ page, release: resolve })
    })
    return page
  })

  // Click earlier
  await dom.click('[data-earlier]')
  await act(async () => {
    await vi.waitFor(() => expect(requests).toHaveLength(1))
  })
  expect(requests[0]!.page.items.map((item: any) => item.id)).toEqual(['older-fin-item-000'])

  // Append new item
  const newLine = {
    sessionId: nativeSessionId,
    uuid: 'older-fin-new',
    type: 'user',
    message: { role: 'user', content: 'New item' },
    timestamp: new Date(1790900035000).toISOString()
  }
  await appendFile(transcriptPath, JSON.stringify(newLine) + '\n')

  // Click refresh
  await dom.click('[data-refresh]')

  if (bridgeSpy.mock.calls.length > 1) {
    await act(async () => {
      await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 1000 })
    })
  }
  expect(bridgeSpy).toHaveBeenCalledOnce()

  // Before releasing earlier: loading is true
  expect(dom.container.querySelector('[data-reader="one"]')?.getAttribute('data-loading')).toBe('true')

  // Release earlier page
  await act(async () => requests[0]!.release())
  await vi.waitFor(() => expect(requests).toHaveLength(2))

  // Loading must STILL be 'true' while newer refresh is in flight! (Earlier finalizer didn't clear it)
  expect(dom.container.querySelector('[data-reader="one"]')?.getAttribute('data-loading')).toBe('true')

  // Release refresh
  await act(async () => {
    requests[1]!.release()
  })

  // Loading becomes 'false' after refresh finishes
  await act(async () => {
    await vi.waitFor(() => {
      expect(dom.container.querySelector('[data-reader="one"]')?.getAttribute('data-loading')).toBe('false')
    })
  })
})

it('mixed mounted surface: timeline captured item and native item with legal identical ID do not collide React keys', async () => {
  const sessionId = 'agent-spine-mixed-collision'
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
      const items = outboxPanel.querySelectorAll('.composer-mailbox__history .composer-mailbox__messages li')
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
  await act(async () => useAppStore.setState({
    sessions: [{ ...snap, updatedAt: 3, agentSessionUpdatedAt: 3 }]
  }))

  await act(async () => {
    await toggle('closed')
    await toggle('open')
    await folder('outbox')
  })

  await act(async () => {
    await vi.waitFor(() => {
      const outboxPanel = dom.container.querySelector('[id$="-outbox"]')!
      expect(outboxPanel.querySelectorAll('.composer-mailbox__history .composer-mailbox__messages li')).toHaveLength(4)
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
