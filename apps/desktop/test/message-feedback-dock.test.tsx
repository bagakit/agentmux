// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const dock = () => document.querySelector<HTMLElement>('.composer-pending__notice')!
async function click(selector: string) {
  const node = dock().querySelector<HTMLElement>(selector)
  expect(node).not.toBeNull(); await act(async () => node!.click())
}

it('the original tool failure lives in the existing right dock, preserves the current draft and retries the original action', async () => {
  const choose = vi.spyOn(api.ui, 'chooseFiles').mockRejectedValueOnce(new Error('Picker unavailable')).mockResolvedValueOnce([])
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-tool--mode')
  await dom.click('[aria-label="Reference files for the Agent to read"]')
  expect(dock().textContent).toContain('Picker unavailable')
  expect(dom.container.querySelector('.composer > .composer-feedback')).toBeNull()
  expect(dom.container.querySelector('.composer [data-compact="true"]')).toBeNull()
  expect(dock().querySelector('details')!.open).toBe(false)
  expect(useAppStore.getState().error).toBeNull()
  await act(async () => useAppStore.getState().setAgentComposerDraft('agent-1', 'Edited after failure'))
  await click('.message-delivery-failure__actions button')
  expect(choose).toHaveBeenCalledTimes(2)
  expect(dom.draft()).toBe('Edited after failure')
  expect(document.querySelector('.composer-pending__notice')).toBeNull()
})

it('folded full diagnostics and real copy failure preserve every original byte and identity without retrying input', async () => {
  const tail = 'original-tail-完整'
  const raw = 'Original unavailable\n' + '原始诊断'.repeat(18_000) + tail
  const error = Object.assign(new Error(raw), { detail: JSON.stringify({ hostId: 'original-host', agentSessionId: 'agent-1',
    runId: 'run-agent-1', operationId: 'original-operation', messageId: 'original-message', logId: 'original-log' }) })
  const choose = vi.spyOn(api.ui, 'chooseFiles').mockRejectedValueOnce(error)
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockRejectedValueOnce(new Error('Clipboard denied')).mockResolvedValueOnce(undefined)
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-tool--mode'); await dom.click('[aria-label="Reference files for the Agent to read"]')
  const complete = dock().querySelector('pre')!.textContent!
  expect(complete.includes(raw)).toBe(true); expect(complete.includes(JSON.stringify(error.stack).slice(1, -1))).toBe(true)
  for (const value of ['original-host', 'agent-1', 'run-agent-1', 'original-operation', 'original-message', 'original-log', tail]) expect(complete).toContain(value)
  await click('[aria-label="复制完整诊断"]')
  expect(dock().querySelector('[data-copy-state]')!.getAttribute('data-copy-state')).toBe('failed')
  expect(dock().querySelector('pre')!.textContent).toBe(complete)
  await click('[aria-label="复制完整诊断"]')
  expect(dock().querySelector('[data-copy-state]')!.getAttribute('data-copy-state')).toBe('copied')
  expect(copy.mock.calls).toEqual([[complete], [complete]])
  expect(choose).toHaveBeenCalledTimes(1)
  expect(dom.draft()).toBe('Keep my draft')
})
