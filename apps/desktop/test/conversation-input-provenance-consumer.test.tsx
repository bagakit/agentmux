// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHistoryQueryFixture } from '../../../packages/core/test/helpers/session-history-query'
import { inputCorrelationCore } from '../../../packages/core/test/helpers/input-correlation'
import { agentPromptCondition } from '../../../packages/core/src/agent-prompt-condition'
import { composeAgentPrompt } from '../../../packages/core/src/agent-outbound-message'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { fixtureEpoch as _historyTailFixtureEpoch } from '../../../test/fixture-values.mjs'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { activityReadingProps } from './helpers/activity-reading-props'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const state = useAppStore.getState(); useAppStore.setState({ sessions: [], timelines: {}, agentNames: {} })
  closes.push(async () => useAppStore.setState(state, true))
  const container = document.createElement('div'); document.body.append(container)
  const root = createClientUiRoot(container)
  closes.push(async () => { await act(async () => root.unmount()); container.remove() })
  return { container, root }
}

it('the mounted original Activity retains full native text and Copy while showing author and content boundary separately', async () => {
  const f = await createHistoryQueryFixture(closes, 'claude', 1)
  const body = composeAgentPrompt('Original public request 中文🙂', 'internal generated context sentinel').text
  await writeFile(f.transcript, JSON.stringify({ type: 'user', uuid: 'native-input', sessionId: 'original-native', message: { role: 'user',
    content: [{ type: 'text', text: body }, { type: 'tool_result', tool_use_id: 'original-tool', content: 'Original tool output' }] } })+'\n')
  const read = await f.client.readAgentSessionHistory({ ...f.reference, source: 'native', kind: 'user-message' })
  expect(read.userMessages).toHaveLength(1)
  expect(read.userMessages![0]).toMatchObject({ publicContent: 'unknown', author: { kind: 'unknown' } })
  await desktopConversationReadBridge({ root: f.root, client: f.client }, closes)
  const inspect = vi.spyOn(f.client, 'readAgentConversation')
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  const { container, root } = await mount()
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control: { ...f.reference, run: f.session.run } })} />))
  await vi.waitFor(async () => { await act(async () => {}); expect(container.querySelector('[data-native-record-id="native-input"]')).not.toBeNull() }, { timeout: 10_000 })
  expect(inspect).toHaveBeenCalled()
  const record = container.querySelector('[data-native-record-id="native-input"]')!
  expect(record).not.toBeNull()
  expect(record.textContent).toContain('Original public request')
  const details = record.querySelector<HTMLButtonElement>('[aria-label="Message details"]')!
  expect(details).not.toBeNull(); await act(async () => details.click())
  expect(record.querySelector('[aria-label="Message details"]')?.getAttribute('aria-expanded')).toBe('true')
  expect(record.textContent).toContain('User content boundary')
  expect(record.textContent).toContain('Unconfirmed · original text retained')
  expect(record.textContent).toContain('Recorded author')
  expect(record.textContent).toContain('Not recorded')
  expect(record.textContent).not.toContain('Recorded separately from generated context')
  await act(async () => record.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
  expect(copy.mock.calls[0]![0]).toContain(body)
  expect(copy.mock.calls[0]![0]).toContain('Original tool output')
  expect(f.forbidden.flatMap(spy => spy.mock.calls)).toEqual([])
})

it('the mounted original Activity consumes exact writer facts and keeps a known-human legacy record unconfirmed', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'amux-content-consumer-')); closes.push(() => rm(folder, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(folder, 'queue.ndjson'))
  const f = await inputCorrelationCore('traex'); closes.push(f.dispose)
  const body = 'Same complete original input 中文🙂'
  await f.hosted.submitAgentPrompt({ ...agentPromptCondition(f.core.agentSession('private-agent')), agentSessionId: 'private-agent', operationId: 'owned-content-operation',
    prompt: body, agentMuxNote: 'Internal context stays in its original system record', authorHuman: true })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: 'private-agent', item: { id: 'legacy-input', agentSessionId: 'private-agent', kind: 'user_message',
    source: 'user', status: 'complete', title: 'Legacy original input', content: body, authorHuman: true, createdAt: _historyTailFixtureEpoch(0, 0, 1), updatedAt: _historyTailFixtureEpoch(0, 0, 1) } })
  const read = await f.hosted.readAgentSessionHistory({ hostId: 'local', agentSessionId: 'private-agent', source: 'captured', kind: 'user-message' })
  expect(read.userMessages).toHaveLength(2)
  expect(read.userMessages!.map(message => message.publicContent).sort()).toEqual(['confirmed', 'unknown'])
  expect(read.userMessages!.every(message => message.author.kind === 'human')).toBe(true)
  await desktopConversationReadBridge({ root: folder, client: f.core }, closes)
  const inspect = vi.spyOn(f.core, 'readAgentConversation')
  const { container, root } = await mount()
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control: { hostId: 'local', agentSessionId: 'private-agent', run: { runId: 'original' } } })} />))
  await vi.waitFor(async () => { await act(async () => {}); expect([...container.querySelectorAll<HTMLElement>('.log-turn')].filter(record => record.textContent?.includes(body))).toHaveLength(2) }, { timeout: 10_000 })
  expect(inspect).toHaveBeenCalled()
  const records = [...container.querySelectorAll<HTMLElement>('.log-turn')].filter(record => record.textContent?.includes(body))
  expect(records).toHaveLength(2)
  for (const record of records) await act(async () => record.querySelector<HTMLButtonElement>('[aria-label="Message details"]')!.click())
  expect(records.filter(record => record.textContent?.includes('Recorded separately from generated context'))).toHaveLength(1)
  expect(records.filter(record => record.textContent?.includes('Unconfirmed · original text retained'))).toHaveLength(1)
  expect(records.every(record => record.textContent?.includes('Requires the original audience and sharing authorization'))).toBe(true)
  expect(f.input).toHaveBeenCalledTimes(1)
  expect(f.core.agentSession('private-agent').run).toEqual({ runId: 'original' })
})
