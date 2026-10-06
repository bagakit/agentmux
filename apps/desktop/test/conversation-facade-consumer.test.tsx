// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { useAppStore } from '../src/renderer/src/store'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllGlobals() })

it('the actual Desktop Activity reads original Provider records through the common Core projection', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const folder = await mkdtemp(join(tmpdir(), 'conversation-consumer-')); cleanups.push(() => rm(folder, { recursive: true, force: true }))
  const transcript = join(folder, 'conversation.jsonl')
  const rows = ['first', 'second'].map(uuid => ({ uuid, type: 'assistant', sessionId: 'native', message: { role: 'assistant',
    content: [{ type: 'text', text: 'Original repeated reply' }, { type: 'thinking', thinking: 'Recorded reasoning' }] } }))
  await writeFile(transcript, rows.map(row => JSON.stringify(row)).join('\n')+'\n')
  const store = new AgentMuxFileAgentSessionStore(join(folder, 'sessions.json'))
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'session', hostId: 'local', providerId: 'claude', executorId: 'claude',
    workspacePath: folder, run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'binding', hookToken: 'token', createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native', transcriptPath: transcript } })
  const client = new AgentMuxClient({ store }); cleanups.push(() => client.dispose())
  const page = await client.sessionHistoryPage('session')
  const initial = useAppStore.getState(); useAppStore.setState({ sessions: [], timelines: {}, agentNames: {} });
  cleanups.push(async () => { useAppStore.setState(initial, true) })
  const container = document.createElement('div'); document.body.append(container)
  const root = createClientUiRoot(container); cleanups.push(async () => { await act(async () => root.unmount()); container.remove() })
  await act(async () => root.render(<ActivityView sessionId="session" executionHostId="local" items={[]} capability="complete-events" nativeHistoryPage={page} />))
  const records = [...container.querySelectorAll<HTMLElement>('[data-native-record-id]')]
  expect(records.map(record => record.dataset.nativeRecordId)).toEqual(['first', 'second'])
  expect(records.map(record => record.textContent)).toEqual([expect.stringContaining('Original repeated reply'), expect.stringContaining('Original repeated reply')])
  const original = records[0]!
  const textNode = [...original.querySelectorAll<HTMLElement>('p')].find(node => node.textContent?.includes('Original repeated reply'))!
  expect(textNode).toBeDefined()
  const range = document.createRange(); range.selectNodeContents(textNode)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  await act(async () => root.render(<ActivityView sessionId="session" executionHostId="local" items={[]} capability="complete-events" nativeHistoryPage={{ ...page }} />))
  expect(container.querySelector('[data-native-record-id="first"]')).toBe(original)
  expect(selection.toString()).toBe('Original repeated reply')
})
