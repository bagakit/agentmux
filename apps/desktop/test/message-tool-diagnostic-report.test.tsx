// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import { act, useLayoutEffect } from 'react'
import { ComposerFeedback } from '../src/renderer/src/components/ComposerFeedback'
import { messageDeliveryDiagnostics } from '../src/renderer/src/lib/message-delivery-diagnostics'
import { startDeliveryAttempt } from '@agentmux/client-ui/delivery-diagnostics'
const dom = composerDOM()

it('the real Message Tool keeps a complete local failure copy and unchanged draft instead of a raw JSON banner', async () => {
  const raw = 'Error invoking remote method \'files:choose\': Error: {"code":"NATIVE_FAILURE","detail":"' + 'unabridged'.repeat(1800) + 'final-marker"}'
  const error = Object.assign(new Error(raw), { code: 'NATIVE_FAILURE', detail: 'original machine detail' })
  const choose = vi.spyOn(api.ui, 'chooseFiles').mockRejectedValueOnce(error).mockResolvedValueOnce(null)
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-tool--mode')
  await dom.click('[aria-label="Reference files for the Agent to read"]')
  expect(document.querySelector('.composer-feedback [role="alert"]')!.textContent).not.toContain('NATIVE_FAILURE')
  expect(document.querySelector('.composer-feedback details')!.hasAttribute('open')).toBe(false)
  await act(async () => document.querySelector<HTMLButtonElement>('.composer-feedback [aria-label="复制完整资料"]')!.click())
  expect(JSON.parse(copy.mock.calls[0]![0]).error).toMatchObject({ message: raw, detail: error.detail, stack: error.stack })
  expect(document.querySelector('.composer-feedback [role="status"]')!.textContent).toBe('完整资料已复制')
  expect(dom.draft()).toBe('Keep my draft')
  await act(async () => document.querySelector<HTMLButtonElement>('.composer-feedback .message-delivery-failure__actions button:first-child')!.click())
  expect(choose).toHaveBeenCalledTimes(2)
  expect(document.querySelector('.composer-feedback')).toBeNull()
})

it('a different failure cannot borrow the previous log during the render before diagnostic subscription updates', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  const failures: Array<{ generation: number; message: string; error: Error & { logId: string; code: string;
    controlFailure: { disposition: string; confirmedInputBytes: number } } }> = []
  for (const label of ['A', 'B']) {
    const seed = startDeliveryAttempt({ hostId: `host-${label}`, agentSessionId: `session-${label}`, operationId: `operation-${label}` })
    const error = Object.assign(new Error(`Original ${label} error`), { logId: seed.logId,
      code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: label === 'A' ? 'unknown' : 'not_applied', confirmedInputBytes: 0 } })
    await messageDeliveryDiagnostics.failed(seed, error, 'core-submit', `owner-${label}`)
    failures.push({ generation: 0, message: error.message, error })
  }
  let duringLayout = ''
  function Scene({ index }: { index: number }) {
    useLayoutEffect(() => {
      if (index === 1) {
        duringLayout = dom.container.querySelector('.message-delivery-failure__heading')!.textContent!
        dom.container.querySelector<HTMLButtonElement>('[aria-label="复制诊断摘要"]')!.click()
      }
    }, [index])
    return <ComposerFeedback failure={failures[index]!} onDismiss={() => {}} />
  }
  await dom.render(<Scene index={0} />)
  expect(dom.container.querySelector('.message-delivery-failure__heading')!.textContent).toBe('发送结果待核实')
  await dom.render(<Scene index={1} />)
  expect(duringLayout).toBe('本次准备未完成')
  expect(copy.mock.calls[0]![0]).toContain(failures[1]!.error.logId)
  expect(copy.mock.calls[0]![0]).toContain('Original B error')
  expect(copy.mock.calls[0]![0]).not.toContain(failures[0]!.error.logId)
  expect(copy.mock.calls[0]![0]).not.toContain('operation-A')
})
