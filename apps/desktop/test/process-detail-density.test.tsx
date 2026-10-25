// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { StaticActivityView } from './helpers/conversation-static-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { NativeProcessStep } from '@agentmux/client-ui/components/NativeProcessObservation'
import { api } from '../src/renderer/src/lib/api'

let host: HTMLDivElement, root: Root
const page: AgentSessionHistoryPage = { agentSessionId: 'density-agent', sourceHostId: 'local',
  source: { providerId: 'example-provider', nativeSessionId: 'density-original-thread' }, nextCursor: null,
  items: [
    { id: 'call', kind: 'assistant-message', contentParts: [{ kind: 'tool-call', callId: 'exact-call', name: 'inspect', input: '{"original":"parameter"}' }] },
    { id: 'result', kind: 'activity', contentParts: [{ kind: 'tool-result', callId: 'exact-call', name: 'inspect', failed: true, output: 'Exact original failed result.\nKeep the complete content.' }] },
    { id: 'answer', kind: 'assistant-message', messagePhase: 'final', contentParts: [{ kind: 'text', text: 'Recorded activity is part of this public answer.' }] }
  ] }
const render = async (node: ReactNode) => { await act(async () => root.render(node)) }
const click = async (element: HTMLElement) => { await act(async () => element.click()) }
const scene = (source = page) => <StaticActivityView capability="complete-events" items={[]} sessionId="density-agent" nativeHistoryPage={source} />
const step = (id: string) => host.querySelector<HTMLElement>(`[data-native-step-id="${id}"]`)!
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('uses the actual Activity process heading once and preserves the original result, Copy and public answer', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await render(scene())
  const answer = host.querySelector('[data-native-record-id="answer"]')!
  const answerBody = answer.querySelector('.log-turn__body')!
  expect(answer.textContent).toContain('Recorded activity is part of this public answer.')
  expect(answer.querySelector('[data-process-content]')).toBeNull()
  expect(host.querySelector('.native-process-observation__issue')?.closest('[hidden]')).toBeNull()
  await click(host.querySelector('.wf-head')!)
  expect(step('result').querySelector('.log-row__title')?.textContent).toBe('inspect result')
  expect(step('result').querySelector('.wf-tool-row--observation')?.textContent).not.toContain('Status not recorded')
  await click(step('result').querySelector('.wf-tool-row--observation')!)
  const result = step('result').querySelector('[data-process-content]')!
  expect(result).not.toBeNull()
  expect(result.querySelector('.log-turn__who')).toBeNull()
  expect(result.textContent).not.toContain('Recorded activity')
  await click(result.querySelector('.conversation-tool-trace__row')!)
  expect(result.textContent).toContain('Exact original failed result.')
  expect(result.textContent).toContain('exact-call')
  await click(result.querySelector('[aria-label="Copy tool output"]')!)
  expect(copy).toHaveBeenCalledWith('Exact original failed result.\nKeep the complete content.')
  const summary = [...step('result').querySelectorAll('summary')].find(n => n.textContent === 'Recorded source')!
  expect(summary).toBeDefined()
  await click(summary)
  expect(step('result').querySelector('[aria-label="Recorded step source"]')?.textContent).toContain('Status not recorded')
  expect(step('result').querySelector('[aria-label="Recorded step source"]')?.textContent).toContain('原生对话')
  expect(step('result').querySelector('[aria-label="Recorded step source"]')?.textContent).toContain('density-original-thread')
  expect(step('result').querySelector('[aria-label="Recorded step source"]')?.textContent).toContain('example-provider')
  expect(answer.querySelector('.log-turn__body')).toBe(answerBody)
})

it('keeps history status readable in the step itself with an opaque body and preserves original titles', async () => {
  await render(<NativeProcessStep item={{ id: 'opaque', kind: 'activity', title: 'Original named result', contentParts: [{kind:'tool-result',name:'inspect',output:'Original opaque payload'}] }}><p>Opaque original body</p></NativeProcessStep>)
  expect(step('opaque').querySelector('.log-row__title')?.textContent).toBe('Original named result')
  expect(step('opaque').querySelector('.wf-tool-row--observation')?.textContent).not.toContain('Status not recorded')
  await click(step('opaque').querySelector('.wf-tool-row--observation')!)
  await click([...step('opaque').querySelectorAll('summary')].find(n => n.textContent === 'Recorded source')!)
  expect(step('opaque').querySelector('[aria-label="Recorded step source"]')?.textContent).toContain('Status not recorded')
  expect(step('opaque').textContent).toContain('Opaque original body')
})

it('keeps the original nodes, expanded body and selection when an unrelated source update arrives', async () => {
  await render(scene())
  const head = host.querySelector<HTMLButtonElement>('.wf-head')!
  await click(head); await click(step('result').querySelector('.wf-tool-row--observation')!)
  const result = step('result'), row = result.querySelector('.wf-tool-row--observation')!
  await click(result.querySelector('.conversation-tool-trace__row')!)
  const pre = result.querySelector('pre')!, text = pre.firstChild!
  const selection = window.getSelection()!, range = document.createRange()
  range.setStart(text, 0); range.setEnd(text, 5); selection.addRange(range)
  expect(selection.toString()).toBe('Exact')
  await render(scene({ ...page, items: [...page.items, { id: 'next-public', kind: 'assistant-message', messagePhase: 'final', contentParts: [{kind:'text',text:'A different public record.'}] }] }))
  expect(step('result')).toBe(result); expect(result.querySelector('pre')).toBe(pre)
  expect(result.querySelector('.wf-tool-row--observation')).toBe(row)
  expect(row.getAttribute('aria-expanded')).toBe('true'); expect(selection.toString()).toBe('Exact')
  await click(head)
  expect(host.querySelector('.native-process-observation__issue')?.closest('[hidden]')).toBeNull()
  await click(head)
  expect(result.querySelector('pre')).toBe(pre)
})
