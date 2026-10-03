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

it('actual compact X archives the exact selected original instead of hiding the queue, and Restore remains explicitly paused', async () => {
  const first:AgentSteerQueueEntry={operationId:'first',text:'Keep first',status:'queued',promptCondition:null,runId:'run-agent-1'}
  const second:AgentSteerQueueEntry={operationId:'second',text:'Original second\nFull retained tail',status:'deferred',runId:'run-agent-1',error:'Original unknown cause'}
  useAppStore.setState({agentSteerQueues:{'agent-1':[first,second]}})
  const before=useAppStore.getState()
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  const card=document.querySelector<HTMLElement>('.composer-pending__card[data-operation-id="second"]')!
  const {act}=await import('react')
  await act(async()=>card.focus())
  expect(card.dataset.selected).toBe('true')
  await act(async()=>card.querySelector<HTMLButtonElement>('[aria-label="归档这条待发消息"]')!.click())
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([first,{...second,archived:true}])
  expect(document.querySelectorAll('.composer-pending__card')).toHaveLength(1)
  expect(document.querySelector('.composer-pending__restore')).toBeNull()
  const panel=dom.container.querySelector<HTMLElement>('.composer-mailbox')!
  const event=new Event('toggle');Object.defineProperty(event,'newState',{value:'open'})
  await act(async()=>panel.dispatchEvent(event))
  await act(async()=>panel.querySelector<HTMLButtonElement>('[id$="-outbox-tab"]')!.click())
  const archived=panel.querySelector<HTMLElement>('li[data-operation-id="second"]')!
  expect(archived.textContent).toContain('已归档')
  await act(async()=>archived.querySelector<HTMLButtonElement>('[aria-label="恢复为待发"]')!.click())
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([first,{...second,awaitingExplicitSend:true}])
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
})


it('distinguishes the two original left entry icons by their existing Activity and tool row meanings', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(dom.container.querySelector('[aria-label="Show Activity"] .lucide-messages-square')).not.toBeNull()
  expect(dom.container.querySelector('[aria-label="Show the message tool row"] .lucide-wrench')).not.toBeNull()
  expect(dom.container.querySelector('[aria-label="Show the message tool row"] .lucide-messages-square')).toBeNull()
})
