// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { ComposerOutbox } from '../src/renderer/src/components/ComposerOutbox'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const unknownError = () => new Error('The previous turn has not been confirmed complete. Diagnostic: code=AGENT_TURN_END_UNCONFIRMED')

it('the existing Send grants its exact head message without an additional continuation action', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValueOnce(unknownError()).mockResolvedValue(undefined)
  const state = useAppStore.getState()
  state.enqueueAgentSteer('agent-1', 'first')
  state.enqueueAgentSteer('agent-1', 'second')
  await state.flushAgentSteerQueue('agent-1')
  const pending = useAppStore.getState().agentSteerQueues['agent-1']!
  expect(pending).toHaveLength(2)
  expect(pending[0]).toMatchObject({ text: 'first', status: 'deferred', errorCode: 'AGENT_TURN_END_UNCONFIRMED' })
  const firstId = pending[0]!.operationId
  await dom.render(<ComposerOutbox queued={pending.map((entry) => ({ id: entry.operationId,
    text: entry.text, status: entry.status, deliverable: true
  }))} onSend={(id) => { void useAppStore.getState().sendQueuedAgentSteer('agent-1', id) }} />)
  expect(dom.container.textContent).toContain('Send explicitly steers this message')
  expect(dom.container.textContent).not.toContain('Send now — turn may still be running')
  const button = Array.from(dom.container.querySelectorAll('button')).find((item) =>
    item.textContent === 'Send queued message')
  expect(button).toBeDefined()
  await act(async () => { button!.click() })
  expect(submit.mock.calls).toEqual([
    [composerSession().control, 'first', firstId, undefined, undefined],
    [composerSession().control, 'first', firstId, undefined, { allowUncertainTurn: true }]
  ])
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([pending[1]])
})

it('waits for a fresh accepted native completion, without output or working retry storms', async () => {
  const session = composerSession()
  useAppStore.setState({ sessions: [session] })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValueOnce(unknownError()).mockResolvedValue(undefined)
  useAppStore.getState().enqueueAgentSteer('agent-1', 'kept message')
  await useAppStore.getState().flushAgentSteerQueue('agent-1')
  const id = useAppStore.getState().agentSteerQueues['agent-1']![0]!.operationId
  const status = (state: 'working' | 'done', observedAt: number, runId = 'run-agent-1') =>
    useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
      type: 'agent-status', agentSessionId: 'agent-1', state,
      evidence: { source: 'native-hook', observedAt, run: { runId } }
    } })
  status('working', 2)
  status('working', 3)
  status('done', 4, 'retired-run')
  await Promise.resolve()
  expect(submit).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toHaveLength(1)
  status('done', 5)
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2))
  expect(submit.mock.calls[1]).toEqual([session.control, 'kept message', id, undefined, undefined])
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toBeUndefined()
})
