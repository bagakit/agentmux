// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { composerDOM } from './helpers/composer-dom-fixture'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore, type AgentSteerQueueEntry } from '../src/renderer/src/store'
const dom = composerDOM()
it('original archive fact exits actual active cards and count while queue, draft and healthy session remain intact', async () => {
  const archived:AgentSteerQueueEntry={operationId:'archived-original',text:'Original archived body and receipt',status:'deferred',runId:'run-agent-1',archived:true,error:'Original unknown cause'}
  const active:AgentSteerQueueEntry={operationId:'active-original',text:'Keep active exact original',status:'queued',promptCondition:null,runId:'run-agent-1'}
  useAppStore.setState({agentSteerQueues:{'agent-1':[archived,active]}})
  const before=useAppStore.getState(),queue=before.agentSteerQueues['agent-1']
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  const card=document.querySelector<HTMLElement>('.composer-pending')!
  expect(card).not.toBeNull();expect(card.dataset.count).toBe('1')
  expect([...card.querySelectorAll<HTMLElement>('.composer-pending__card')].map(node=>node.dataset.operationId)).toEqual(['active-original'])
  expect(card.textContent).not.toContain(archived.text)
  expect(dom.container.querySelector('.composer__mailbox')!.getAttribute('aria-label')).toContain('Outbox 1 pending')
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toBe(queue)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
})
