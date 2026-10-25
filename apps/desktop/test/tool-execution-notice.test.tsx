// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { AgentExecutionInspection } from '@agentmux/core'
import { AgentToolExecutionNotice } from '../src/renderer/src/components/AgentToolExecutionNotice'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
const dom = composerDOM()
const session = { ...composerSession(), toolExecution: { bindingId: 'binding', resourceHostId: 'A', workspacePath: '/project' } }
const fact: AgentExecutionInspection = { bindingId: 'binding', resourceHostId: 'A', resourceWorkspacePath: '/project', agentHostId: 'local', agentSessionId: session.id, state: 'connected',
  notices: [{ providerId: 'codex', role: 'executor', capability: 'agent-control', state: 'unconfigured', code: 'CONTROL_NOT_CONFIGURED', message: 'Tool-side Agent control is not configured.', action: 'Use the original Agent Host control endpoint.' }] }
it('connected bindings keep typed capability notices, preserve healthy state/draft and release only the reader when hidden', async () => {
  let emit!: (value: AgentExecutionInspection | null) => void, fail!: (error: string) => void
  const stop = vi.fn(), controlStop = vi.spyOn(api.sessions, 'stop')
  vi.spyOn(api.sessions, 'observeExecutionBinding').mockImplementation((_id, listener, error) => { emit = listener; fail = error; return stop })
  const before = useAppStore.getState()
  await dom.render(<AgentToolExecutionNotice session={session} visible />)
  await act(async () => emit(fact))
  expect(dom.container.textContent).toContain('Agent control · unconfigured')
  expect(dom.container.textContent).not.toContain('observation is unconfirmed')
  await act(async () => fail('Observation channel unavailable'))
  expect(dom.container.textContent).toContain('Observation channel unavailable')
  expect(dom.container.textContent).toContain(fact.notices![0]!.message)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  await act(async () => emit({ ...fact, notices: [] }))
  expect(dom.container.querySelector('.service-disclosure')).toBeNull()
  await dom.render(<AgentToolExecutionNotice session={session} visible={false} />)
  expect(stop).toHaveBeenCalledTimes(1); expect(controlStop).not.toHaveBeenCalled()
})
it('rejects another original binding and never lets late refresh overwrite a newer observation', async () => {
  let emit!: (value: AgentExecutionInspection | null) => void, resolve!: (value: AgentExecutionInspection | null) => void
  vi.spyOn(api.sessions, 'observeExecutionBinding').mockImplementation((_id, listener) => { emit = listener; return vi.fn() })
  vi.spyOn(api.sessions, 'executionBinding').mockImplementation(() => new Promise(done => { resolve = done }))
  await dom.render(<AgentToolExecutionNotice session={session} visible />)
  await act(async () => emit(fact))
  await dom.click('.service-disclosure__actions button')
  await act(async () => emit({ ...fact, state: 'unavailable', diagnostic: { code: 'NEW_UNAVAILABLE', message: 'New observation unavailable' } }))
  await act(async () => resolve({ ...fact, notices: [] }))
  expect(dom.container.textContent).toContain('New observation unavailable')
  await act(async () => emit({ ...fact, agentSessionId: 'wrong-original', notices: [] }))
  expect(dom.container.textContent).toContain('did not identify this original execution binding')
  expect(dom.container.textContent).toContain(fact.notices![0]!.message)
})
