// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { SessionHistoryView } from '../src/renderer/src/components/SessionHistoryView'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { parseTraceDisclosureKey } from '../src/renderer/src/components/ConversationMessage'
import { api } from '../src/renderer/src/lib/api'

let host: HTMLDivElement
let root: Root
const clients: AgentMuxClient[] = []
const controls: { name: string; spy: ReturnType<typeof vi.spyOn> }[] = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  expect(controls.length).toBeGreaterThan(0)
  expect(controls.map(({ name, spy }) => [name, spy.mock.calls.length])).toEqual(controls.map(({ name }) => [name, 0]))
  console.log('SHARED_READING_ACTUAL_KERNEL_CONTROLS', JSON.stringify(controls.map(({ name, spy }) => [name, spy.mock.calls.length])))
  controls.splice(0).forEach(({ spy }) => spy.mockRestore())
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  for (const client of clients.splice(0)) await client.dispose()
})

async function fixture() {
  const workspacePath = await mkdtemp(join(tmpdir(), 'shared-reading-public-'))
  const transcriptPath = join(workspacePath, 'native.jsonl')
  const storePath = join(workspacePath, 'sessions.json')
  const control = { kind: 'agent' as const, hostId: 'local', agentSessionId: 'shared-reading-recipient', run: { runId: 'private-fixture-without-pid' } }
  const nativeSessionId = 'shared-reading-native'
  const rawId = 'native:input:tool-result:opaque'
  async function writeInput(text: string): Promise<void> {
    await writeFile(transcriptPath, JSON.stringify({ sessionId: nativeSessionId, uuid: rawId, type: 'user',
      timestamp: '1970-01-01T00:00:03.000Z', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'opaque:call:0', content: 'Private native tool result' },
        { type: 'text', text }
      ] } }) + '\n')
  }
  await writeInput('Native tail initial')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: control.agentSessionId, providerId: 'claude', executorId: 'claude',
    hostId: control.hostId, workspacePath, run: control.run, retiredRuns: [], createdAt: 1, updatedAt: 1,
    hookBindingId: 'private-shared-reading', hookToken: 'private-token',
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: nativeSessionId, transcriptPath } })
  const persisted = await readFile(storePath)
  const client = new AgentMuxClient({ store }); clients.push(client)
  const kernel = Reflect.get(client, 'kernel')
  const methods = new Set<string>()
  for (let current = kernel; current && current !== Object.prototype; current = Object.getPrototypeOf(current)) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name !== 'constructor' && typeof kernel[name] === 'function') methods.add(name)
    }
  }
  expect(methods.size).toBeGreaterThan(0)
  for (const name of [...methods].sort()) controls.push({ name, spy: vi.spyOn(kernel, name).mockImplementation(() => { throw new Error('No Run control: ' + name) }) })
  async function page(): Promise<AgentSessionHistoryPage> {
    const result = await client.sessionHistoryPage(control.agentSessionId)
    expect(result.items.map(item => [item.id, item.kind])).toEqual([[rawId, 'user-message']])
    expect(result.items[0]!.contentParts.map(part => part.kind)).toEqual(['tool-result', 'text'])
    expect(await readFile(storePath)).toEqual(persisted)
    return result
  }
  return { control, client, rawId, workspacePath, writeInput, page }
}

async function settledHistory(): Promise<void> {
  for (let i = 0; i < 80 && host.querySelectorAll('[data-history-item-id]').length !== 1; i += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
  expect(host.querySelectorAll('[data-history-item-id]')).toHaveLength(1)
}

describe('shared native presentation preserves the existing reading owner', () => {
  it('a real public native user trace keeps the raw History record identity when opened and refreshed', async () => {
    const f = await fixture(); const pages: AgentSessionHistoryPage[] = []; const pending: Promise<AgentSessionHistoryPage>[] = []
    const history = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => {
      expect(control).toEqual(f.control); const read = f.page(); pending.push(read); const result = await read; pages.push(result); return result
    })
    await act(async () => root.render(<SessionHistoryView control={f.control} label="Recipient" visible={true}
      themeId="graphite" fontSize={12} workspaceRoot={f.workspacePath} openWorkspaceFile={vi.fn()} openHttpLink={vi.fn()} />))
    await act(async () => { await Promise.all(pending) })
    await settledHistory()
    expect(pages.map(page => page.items.map(item => item.id))).toEqual([[f.rawId]])
    const row = host.querySelector<HTMLElement>('[data-history-item-id]')!
    expect(row.dataset.historyItemId).toBe(f.rawId)
    expect(row.querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBe('unknown')
    const trace = row.querySelector<HTMLButtonElement>('button.conversation-tool-trace__row')!
    expect(trace).not.toBeNull(); expect(trace.getAttribute('aria-expanded')).toBe('false')
    await act(async () => trace.click())
    console.log('SHARED_READING_USER_TRACE_IDENTITY', JSON.stringify({ rawId: f.rawId, traceId: trace.dataset.traceId, expanded: trace.getAttribute('aria-expanded') }))
    expect(trace.getAttribute('aria-expanded')).toBe('true')
    expect(parseTraceDisclosureKey(trace.dataset.traceId!)).toEqual([f.rawId, JSON.stringify(['tool-result', 'opaque:call:0', 0])])
    const latest = [...host.querySelectorAll<HTMLButtonElement>('.session-history__toolbar button')].find(button => button.textContent?.includes('Latest'))!
    await act(async () => latest.click())
    expect(history).toHaveBeenCalledTimes(2)
    await act(async () => { await Promise.all(pending) })
    await settledHistory()
    expect(host.querySelector<HTMLButtonElement>('button.conversation-tool-trace__row')!.getAttribute('aria-expanded')).toBe('true')
    expect(pages.map(page => page.items.map(item => item.id))).toEqual([[f.rawId], [f.rawId]])
  })

  it('a public native tail growing at the same ID follows the real feed and respects an upward reading gesture', async () => {
    const f = await fixture(); const first = await f.page()
    const messages = projectSessionUserMessages({ agentSessionId: f.control.agentSessionId, historyPage: first })
    expect(messages).toHaveLength(1); expect(messages[0]!.rawId).toBe(f.rawId)
    const timeline: AgentTimelineItem[] = [{ id: 'captured-timeline-before-native', agentSessionId: f.control.agentSessionId,
      kind: 'assistant_message', source: 'native-hook', status: 'complete', createdAt: 1000, updatedAt: 1000,
      title: 'Assistant', content: 'Earlier timeline turn' }]
    const render = async (native = messages) => act(async () => root.render(<ActivityView sessionId={f.control.agentSessionId}
      items={timeline} userMessages={native} capability="complete-events" displayState="done" />))
    await render([])
    const feed = host.querySelector<HTMLDivElement>('.activity-feed')!
    let height = 1000; let top = 600; const clientHeight = 400
    Object.defineProperties(feed, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, get: () => clientHeight },
      scrollTop: { configurable: true, get: () => top, set: value => { top = Math.max(0, Math.min(Number(value), height - clientHeight)) } }
    })
    await act(async () => feed.dispatchEvent(new Event('scroll')))
    height = 1200
    await render(messages)
    expect(feed.scrollTop).toBe(800)
    expect([...host.querySelectorAll('.log-turn__body p')].map(body => body.textContent)).toEqual(['Earlier timeline turn', 'Native tail initial'])
    const id = messages[0]!.id
    const longerText = 'Native tail initial with more actual producer text'
    await f.writeInput(longerText)
    const grown = projectSessionUserMessages({ agentSessionId: f.control.agentSessionId, historyPage: await f.page() })
    expect(grown.map(message => [message.id, message.rawId])).toEqual([[id, f.rawId]])
    expect(grown[0]!.content.length).toBeGreaterThan(messages[0]!.content.length)
    height = 1600
    await render(grown)
    console.log('SHARED_READING_NATIVE_TAIL_GROWTH', JSON.stringify({ actualBodies: [...host.querySelectorAll('.log-turn__body p')].map(body => body.textContent), sameNativeId: id, scrollTop: feed.scrollTop, scrollHeight: feed.scrollHeight, clientHeight: feed.clientHeight }))
    expect([...host.querySelectorAll('.log-turn__body p')].map(body => body.textContent)).toEqual(['Earlier timeline turn', longerText])
    expect(feed.scrollTop).toBe(1200)
    feed.scrollTop = 100
    await act(async () => feed.dispatchEvent(new Event('scroll')))
    expect(host.querySelector('.activity-feed__jump')).not.toBeNull()
    await f.writeInput(longerText + ' while reading earlier')
    const detached = projectSessionUserMessages({ agentSessionId: f.control.agentSessionId, historyPage: await f.page() })
    expect(detached.map(message => message.id)).toEqual([id])
    height = 2000
    await render(detached)
    expect(feed.scrollTop).toBe(100)
    expect(host.querySelector('.activity-feed__jump')).not.toBeNull()
  })
  for (const collision of [false, true]) {
    it(`the actual Continue action includes its selected public native input without ${collision ? 'rawId source collision' : 'a missing timeline cutoff'}`, async () => {
      const f = await fixture(); const page = await f.page()
      const messages = projectSessionUserMessages({ agentSessionId: f.control.agentSessionId, historyPage: page })
      expect(messages.map(message => [message.rawId, message.author.kind])).toEqual([[f.rawId, 'unknown']])
      const timeline: AgentTimelineItem[] = [
        { id: collision ? f.rawId : 'before-native', agentSessionId: f.control.agentSessionId,
          kind: collision ? 'user_message' : 'assistant_message', source: collision ? 'user' : 'native-hook', status: 'complete',
          createdAt: 1000, updatedAt: 1000, title: 'Earlier', content: collision ? 'Earlier captured input' : 'Earlier agent answer' },
        { id: 'future-after-native', agentSessionId: f.control.agentSessionId, kind: 'assistant_message', source: 'native-hook',
          status: 'complete', createdAt: 5000, updatedAt: 5000, title: 'Future', content: 'Do not leak this future answer' }
      ]
      const onContinue = vi.fn<(prompt: string) => void>()
      const errors: string[] = []
      const capture = (event: ErrorEvent): void => { errors.push(String(event.error?.message ?? event.message)); event.preventDefault() }
      window.addEventListener('error', capture)
      try {
        await act(async () => root.render(<ActivityView sessionId={f.control.agentSessionId} items={timeline} userMessages={messages}
          capability="complete-events" displayState="done" onContinue={onContinue} />))
        const turns = [...host.querySelectorAll<HTMLElement>('.log-turn')]
        expect(turns.map(turn => turn.querySelector('.log-turn__body p')?.textContent)).toEqual([
          collision ? 'Earlier captured input' : 'Earlier agent answer', 'Native tail initial', 'Do not leak this future answer'
        ])
        const selected = turns[1]!
        expect(selected.dataset.speakerRole).toBe('unknown')
        const button = selected.querySelector<HTMLButtonElement>('.log-turn__continue')!
        expect(button.textContent).toBe('Continue from here')
        await act(async () => button.click())
        console.log('SHARED_READING_CONTINUE_NATIVE_ACTUAL', JSON.stringify({ collision, nativeStableId: messages[0]!.id,
          nativeRawId: f.rawId, timelineIds: timeline.map(item => item.id), prompts: onContinue.mock.calls, errors }))
        expect(onContinue).toHaveBeenCalledExactlyOnceWith(
          `Continue this conversation from the selected point.\n\n${collision ? 'Input: Earlier captured input' : 'Agent: Earlier agent answer'}\n\nInput: ${messages[0]!.content}`
        )
        expect(errors).toEqual([])
        expect(onContinue.mock.calls[0]![0]).not.toContain('Do not leak this future answer')
        expect(onContinue.mock.calls[0]![0]).not.toContain('User:')
      } finally {
        window.removeEventListener('error', capture)
      }
    })
  }

})
