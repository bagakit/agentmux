// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { composerDOM } from './helpers/composer-dom-fixture'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

const dom = composerDOM()
const queue = (id: string, text: string) => ({ operationId: id, runId: 'run-agent-1', text, status: 'queued' as const, promptCondition: null, enqueuedAt: 123 })
const strip = () => document.querySelector<HTMLElement>('.composer-pending:not([hidden])')!
const card = (id: string) => strip().querySelector<HTMLElement>(`[data-operation-id="${id}"].composer-pending__card`)!
beforeEach(() => {
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  useAppStore.setState({ agentSteerInFlight: {}, agentSteerInFlightPhase: {}, timelines: {}, noticeReadReceipts: {} })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} })
})
async function mount() {
  useAppStore.setState({ agentSteerQueues: { 'agent-1': [queue('head', 'Head exact body'), queue('tail', 'Tail original\nSecond exact line')] } })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
}
it('hover preserves compact cards without a separate heading or large body/state disclosure', async () => {
  await mount()
  expect(strip().querySelectorAll('.composer-pending__card')).toHaveLength(2)
  const originalDraft = dom.container.querySelector('[role="textbox"]')
  await act(async () => card('tail').dispatchEvent(new PointerEvent('pointermove', { bubbles: true })))
  expect(strip().dataset.operationId).toBe('tail')
  expect(strip().querySelector('.composer-pending__heading')).toBeNull()
  expect(strip().querySelector('.composer-pending__reading')).toBeNull()
  expect(strip().querySelector('svg.lucide-circle-help')).toBeNull()
  expect(strip().querySelector('svg.lucide-pencil')).toBeNull()
  expect(dom.container.querySelector('[role="textbox"]')).toBe(originalDraft)
  expect(dom.draft()).toBe('Keep my draft')
})
it('the original body is an inline edit entry and saves the exact nonhead operation without submitting', async () => {
  await mount()
  const original = useAppStore.getState().agentSteerQueues['agent-1']!.map(entry => ({ ...entry }))
  const save = vi.spyOn(useAppStore.getState(), 'editQueuedAgentSteer')
  const send = vi.spyOn(useAppStore.getState(), 'sendQueuedAgentSteer').mockResolvedValue('submitted')
  const body = card('tail').querySelector<HTMLButtonElement>('button.composer-pending__preview')
  expect(body).not.toBeNull()
  expect(body!.disabled).toBe(false)
  await act(async () => body!.click())
  const textarea = card('tail').querySelector<HTMLTextAreaElement>('textarea')!
  expect(textarea.value).toBe(original[1]!.text)
  expect(strip().querySelector('.composer-pending__reading')).toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Edited exact tail\nFull line')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => card('tail').querySelector<HTMLButtonElement>('[aria-label="保存待发消息"]')!.click())
  expect(save).toHaveBeenLastCalledWith('agent-1', 'tail', original[1]!.text, 'Edited exact tail\nFull line')
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([original[0], { ...original[1], text: 'Edited exact tail\nFull line' }])
  expect(send).not.toHaveBeenCalled()
  expect(dom.draft()).toBe('Keep my draft')
})
it('editing owns textarea navigation and does not move queue focus from its still available Copy action', async () => {
  await mount()
  await act(async () => card('tail').querySelector<HTMLButtonElement>('.composer-pending__preview')!.click())
  const textarea = card('tail').querySelector<HTMLTextAreaElement>('textarea')!
  const originalText = textarea.value
  const originalQueue = useAppStore.getState().agentSteerQueues['agent-1']
  textarea.focus(); textarea.setSelectionRange(2, 6)
  for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    await act(async () => textarea.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(textarea)
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 6])
    expect(strip().dataset.operationId).toBe('tail')
  }
  const copy = card('tail').querySelector<HTMLButtonElement>('.composer-pending__copy')!
  expect(copy.disabled).toBe(false)
  copy.focus()
  for (const key of ['Home', 'ArrowUp', 'ArrowDown', 'End']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    await act(async () => copy.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(copy)
    expect(strip().dataset.operationId).toBe('tail')
  }
  expect(textarea.isConnected).toBe(true)
  expect(textarea.value).toBe(originalText)
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toBe(originalQueue)
  expect(dom.draft()).toBe('Keep my draft')
})
it('the rendered editor and public RPC/compiled CLI consume the same original Store queue', async () => {
  const seeded = useAppStore.getState()
  const dispose = await useAppStore.getState().initialize()
  dispose()
  useAppStore.setState(seeded, true)
  await mount()
  const before = useAppStore.getState().agentSteerQueues['agent-1']!
  const target = before[1]!
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(useAppStore.getState().sessions[0]!)
  const root = await mkdtemp(join(tmpdir(), 'pending-ui-'))
  const server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'), execute: request => useAppStore.getState().executeControl(request) })
  await server.start()
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const cli = async (args: string[]) => {
    const result = await runCompiledObjectCli(['--endpoint', `unix://${server.path}`, 'message', 'pending', ...args], objectCliEnvironment(root))
    expect(result.stderr).toBe(''); expect(result.code).toBe(0)
    return JSON.parse(result.stdout).result
  }
  try {
    await act(async () => card('tail').querySelector<HTMLButtonElement>('.composer-pending__preview')!.click())
    const textarea = card('tail').querySelector<HTMLTextAreaElement>('textarea')!
    const text = 'UI revised tail\nFull original identity'
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => card('tail').querySelector<HTMLButtonElement>('[aria-label="保存待发消息"]')!.click())
    const listed = await cli(['ls', '--session', 'agent-1'])
    expect(listed.messages.map((item: { pendingId: string }) => item.pendingId)).toEqual(['head', 'tail'])
    expect(listed.messages[1]).toMatchObject({ pendingId: target.operationId, text, runId: target.runId, enqueuedAt: target.enqueuedAt })
    await expect(client.call('message.pending.edit', { agentSessionId: 'agent-1', pendingId: target.operationId, expectedText: target.text, text: 'stale overwrite' })).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
    expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([before[0], { ...target, text }])
    expect(submit).not.toHaveBeenCalled(); expect(dom.draft()).toBe('Keep my draft')
    await act(async () => cli(['send', '--session', 'agent-1', '--pending-id', target.operationId]))
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]!.slice(1, 3)).toEqual([text, target.operationId])
    expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([before[0]])
    expect(dom.draft()).toBe('Keep my draft')
  } finally { await client.dispose(); await server.stop(); await rm(root, { recursive: true }) }
}, 20000)
