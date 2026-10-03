// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { NativeProcessObservation } from '@agentmux/client-ui/components/NativeProcessObservation'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import fixture from './fixtures/native-empty-reasoning-public-page.json'

// Exported from the public Codex reader and private FileStore over controlled
// readonly stdio by codex-native-history.test.ts, not a vendor Writer.
const page: AgentSessionHistoryPage = fixture as AgentSessionHistoryPage
let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

async function show() {
  await act(async () => root.render(<ConversationView page={page} sessionId={page.agentSessionId}
    renderProcess={props => <NativeProcessObservation {...props} compact />} />))
  for (const button of host.querySelectorAll<HTMLButtonElement>('.wf-head')) {
    if (button.getAttribute('aria-expanded') === 'false') await act(async () => button.click())
  }
}
async function open(id: string) {
  const record = host.querySelector<HTMLElement>(`[data-native-record-id="${id}"]`)!
  expect(record).not.toBeNull()
  await act(async () => record.querySelector<HTMLButtonElement>('[data-observation-step-id]')!.click())
  return record
}
async function disclose(record: HTMLElement) {
  const trace = record.querySelector<HTMLDetailsElement>('[data-trace-kind="reasoning"]')!
  expect(trace).not.toBeNull()
  await act(async () => { trace.open = true; trace.dispatchEvent(new Event('toggle')) })
  return trace
}

it('keeps empty reasoning as a lazy disclosure instead of protocol JSON prose', async () => {
  await show()
  expect([...host.querySelectorAll<HTMLElement>('[data-native-record-id]')].map(el => el.dataset.nativeRecordId))
    .toEqual(page.items.map(item => item.id))
  for (const id of ['empty-a', 'empty-b']) {
    const record = await open(id)
    expect(record.querySelector('.log-turn__trace-payload')).toBeNull()
    expect(record.querySelector('[aria-label="Copy message"]')).toBeNull()
    await disclose(record)
    expect(record.textContent).toContain('No reasoning text recorded.')
    expect(record.textContent).not.toMatch(/"type"|"summary"|"content"/)
    expect(record.querySelector('.log-turn__trace-body')).toBeNull()
  }
  expect(host.textContent).toContain('The answer remains readable.')
})

it('preserves recorded reasoning and its selected node across process disclosure', async () => {
  await show()
  const record = await open('content-r'), trace = await disclose(record)
  const prose = record.querySelector('.log-turn__trace-body')!
  expect(prose.textContent).toContain('Visible content 中')
  expect(record.textContent).not.toContain('Summary stays secondary')
  const text = prose.querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 3)
  const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  const selected = selection.toString()
  expect(selected.length).toBe(3)
  const button = record.querySelector<HTMLButtonElement>('[data-observation-step-id]')!
  await act(async () => button.click()); expect(text.isConnected).toBe(true)
  await act(async () => button.click())
  expect(record.querySelector('[data-trace-kind="reasoning"]')).toBe(trace)
  expect(record.querySelector('.log-turn__trace-body')).toBe(prose)
  expect(selection.toString()).toBe(selected)
  const summary = await open('summary-r'); await disclose(summary)
  expect(summary.textContent).toContain('Visible summary 中')
})

it('shows existing subagent operation, target result and complete original records', async () => {
  await show()
  const spawn = await open('spawn')
  const operation = spawn.querySelector('[data-observation-step-id]')!
  expect(operation.textContent).toContain('Start agent')
  expect(operation.getAttribute('data-status')).toBe('running')
  expect(spawn.querySelector('.wf-native-process__prompt pre')?.textContent).toBe('\n  Review the input.\n')
  await act(async () => spawn.querySelector<HTMLButtonElement>('.wf-agent__button')!.click())
  expect(spawn.querySelector('[data-for-recorded-agent]')?.textContent).toContain('Recorded review result.')
  expect(operation.getAttribute('data-status')).toBe('running')
  const original = spawn.querySelector<HTMLDetailsElement>('.wf-native-process__raw')!
  await act(async () => { original.open = true })
  const part = page.items.find(item => item.id === 'spawn')!.contentParts[0]!
  expect(part.kind).toBe('text')
  expect(spawn.querySelector('.log-turn__text')?.textContent).toBe(part.kind === 'text' ? part.text : '')
  expect(spawn.querySelector('a')).toBeNull()
  expect((await open('send')).textContent).toContain('Send message')
  const wait = await open('wait')
  expect(wait.textContent).toContain('Wait for agents')
  const states = [...wait.querySelectorAll<HTMLButtonElement>('.wf-agent__button')]
  expect(states).toHaveLength(2)
  await act(async () => states[1]!.click())
  expect(wait.textContent).toContain('Recorded failure.')
  expect((await open('activity')).textContent).toContain('root/reviewer')
  for (const id of ['extended-r', 'unknown-r', 'incomplete-r']) {
    const raw = await open(id), item = page.items.find(item => item.id === id)!.contentParts[0]!
    expect(item.kind).toBe('text')
    expect(raw.querySelector('.log-turn__text')?.textContent).toBe(item.kind === 'text' ? item.text : '')
  }
})
