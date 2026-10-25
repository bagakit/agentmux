// @vitest-environment happy-dom
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { openDemandStore } from '@agentmux/demand'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { projectHostGoal } from '../../host/src/goal-projection'
import { GoalDetail } from '../src/renderer/src/components/GoalDetail'
import { NotebookCreateDialog } from '../src/renderer/src/components/NotebookNavigation'
import { api } from '../src/renderer/src/lib/api'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { useAppStore } from '../src/renderer/src/store'
import type { DemandProjection } from '../src/renderer/src/lib/global-demand-board'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const initialLibrary = useNotebookLibrary.getState()
const directories: string[] = []
afterEach(async () => {
  useNotebookLibrary.setState(initialLibrary, true)
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function directory() { const path = await mkdtemp(join(tmpdir(), 'amx-button-consumer-')); directories.push(path); return path }
function button(label: string, scope: ParentNode = document) {
  const node = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)
  expect(node, label).toBeDefined(); return node!
}
async function click(label: string, scope: ParentNode = document) { await act(async () => button(label, scope).click()) }
async function fillName(value: string) {
  const input = document.querySelector<HTMLInputElement>('[aria-label="New notebook name"]')
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('uses the real GoalDetail menu: Cancel and Escape preserve the Goal, explicit danger deletes only its original ID once', async () => {
  const owner = openDemandStore({ root: await directory() })
  await owner.create({ id: 'original-goal', title: 'Keep the original work recoverable', description: 'Keep linked Sessions running.' })
  await owner.create({ id: 'other-goal', title: 'Other original goal' })
  const original = (await owner.get('original-goal'))!, other = (await owner.get('other-goal'))!
  const demand: DemandProjection = { ...original, source: 'default-topic', sessions: [], workspacePath: null }
  useAppStore.setState({ demands: { [original.id]: demand, [other.id]: { ...other, source: 'default-topic' } }, selectedDemandId: original.id })
  const sessions = useAppStore.getState().sessions, drafts = useAppStore.getState().agentComposerDrafts
  const close = vi.fn()
  const execute = vi.spyOn(api.goals, 'execute').mockImplementation(async request => {
    if (request.operation === 'demand.show') {
      const target = await owner.get(request.demandId)
      return { operation: 'demand.show', demand: target ? projectHostGoal(target) : null, goalContinuations: [] }
    }
    if (request.operation !== 'demand.delete') throw new Error('Only the original delete is expected.')
    const target = await owner.get(request.demandId)
    expect(target).not.toBeNull()
    await owner.remove(request.demandId)
    return { operation: 'demand.delete', demand: projectHostGoal(target!), receipt: { demandId: request.demandId, deletedAt: original.updatedAt + 1 } }
  })
  const deletes = () => execute.mock.calls.flatMap(([request], index) => request.operation === 'demand.delete' ? [{ request, result: execute.mock.results[index]!.value }] : [])
  await dom.render(<GoalDetail demand={demand} onClose={close} onOpenMote={vi.fn()} onGrill={vi.fn()} onGrounding={vi.fn()}
    acknowledgementFeedback={{ pending: false, failure: null, reloadError: null }} onAcknowledgementFeedbackChange={vi.fn()} moteError={null} onRetryMote={vi.fn()} />)
  const actions = button('Goal actions', dom.container)
  async function requestDelete() {
    await act(async () => { actions.focus(); actions.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)) })
    const item = document.querySelector<HTMLElement>('[role="menuitem"].goals-delete-action')
    expect(item?.textContent).toBe('Delete goal')
    await act(async () => item!.click())
    expect(document.querySelector('.confirmation-dialog__subject')?.textContent).toBe(original.title)
    expect(document.activeElement).toBe(button('Cancel'))
  }
  await requestDelete(); await click('Cancel')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await vi.waitFor(() => expect(document.activeElement).toBe(actions))
  expect(deletes()).toHaveLength(0); expect(close).not.toHaveBeenCalled()
  await requestDelete()
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await vi.waitFor(() => expect(document.activeElement).toBe(actions))
  expect(deletes()).toHaveLength(0); expect(await owner.get(original.id)).not.toBeNull()
  await requestDelete()
  const confirm = button('Delete goal', document.querySelector('[role="dialog"]')!)
  expect(confirm.className).toBe('danger-button'); expect(confirm.type).toBe('button')
  await act(async () => confirm.click())
  expect(deletes()).toHaveLength(1)
  expect(deletes()[0]!.request).toMatchObject({ operation: 'demand.delete', demandId: original.id, confirmation: 'delete' })
  await deletes()[0]!.result
  expect(await owner.get(original.id)).toBeNull(); expect(await owner.get(other.id)).not.toBeNull()
  expect(close).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().sessions).toBe(sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
})

function NotebookEntry({ created, closed }: { created: (id: string) => void; closed: () => void }) {
  const [open, setOpen] = useState(true)
  return <><button type="button" onClick={() => setOpen(true)}>New notebook entry</button>
    <NotebookCreateDialog open={open} active onClose={() => { closed(); setOpen(false) }} onCreated={created} /></>
}
async function notebookFixture() {
  const owner = new AgentMuxNotebookStore(join(await directory(), 'notebooks.json'))
  const read = vi.spyOn(api.notebooks, 'read').mockImplementation(() => owner.read())
  const apply = vi.spyOn(api.notebooks, 'apply').mockImplementation(input => owner.apply(input, { kind: 'user', id: 'original-user' }))
  return { owner, read, apply }
}
it('the real Notebook form close icon, Cancel and Escape dismiss without submitting a name', async () => {
  const f = await notebookFixture(), created = vi.fn(), closed = vi.fn()
  await dom.render(<NotebookEntry created={created} closed={closed} />)
  await fillName('Name that must not be submitted')
  const close = button('Close notebook creation')
  expect(close.className).toBe('icon-button'); expect(close.type).toBe('button')
  await act(async () => close.click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await click('New notebook entry'); await fillName('Another unsubmitted name')
  const cancel = button('Cancel')
  expect(cancel.className).toBe('small-button'); expect(cancel.type).toBe('button')
  await act(async () => cancel.click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await click('New notebook entry'); await fillName('Escape keeps this unsubmitted')
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(closed).toHaveBeenCalledTimes(3)
  expect(f.apply).not.toHaveBeenCalled(); expect(created).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
})

it('the original Notebook submit retains a lost-reply name and explicitly retries the same operation against its real durable owner', async () => {
  const f = await notebookFixture(), created = vi.fn(), closed = vi.fn()
  let written!: () => void, releaseReply!: (error: Error) => void
  const wrote = new Promise<void>(resolve => { written = resolve })
  const reply = new Promise<Error>(resolve => { releaseReply = resolve })
  f.apply.mockImplementationOnce(async input => {
    await f.owner.apply(input, { kind: 'user', id: 'original-user' })
    written(); throw await reply
  })
  await dom.render(<NotebookEntry created={created} closed={closed} />)
  const submit = button('Create notebook')
  expect(submit.className).toBe('primary-button'); expect(submit.type).toBe('submit'); expect(submit.disabled).toBe(true)
  await fillName('Original research notebook')
  await act(async () => submit.click())
  await vi.waitFor(() => expect(f.apply).toHaveBeenCalledTimes(1))
  await act(async () => { await wrote })
  expect(f.apply).toHaveBeenCalledTimes(1); expect(submit.disabled).toBe(true)
  expect(button('Cancel').disabled).toBe(true); expect(button('Close notebook creation').disabled).toBe(true)
  await act(async () => { submit.click(); button('Cancel').click(); button('Close notebook creation').click(); document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(f.apply).toHaveBeenCalledTimes(1); expect(closed).not.toHaveBeenCalled()
  await act(async () => { releaseReply(new Error('Original creation reply was lost')); await f.apply.mock.results[0]!.value.catch(() => {}) })
  expect(document.querySelector('.notebook-create-issue')?.textContent).toBe('Original creation reply was lost')
  expect(document.querySelector<HTMLInputElement>('[aria-label="New notebook name"]')?.value).toBe('Original research notebook')
  expect(created).not.toHaveBeenCalled(); expect(f.apply).toHaveBeenCalledTimes(1)
  const retry = button('Retry creation')
  expect(retry).toBe(submit); expect(retry.disabled).toBe(false); expect(retry.type).toBe('submit')
  await act(async () => retry.click())
  await vi.waitFor(() => expect(f.apply).toHaveBeenCalledTimes(2))
  await act(async () => { await f.apply.mock.results[1]!.value })
  expect(f.apply).toHaveBeenCalledTimes(2)
  const first = f.apply.mock.calls[0]![0], second = f.apply.mock.calls[1]![0]
  expect(second.operationId).toBe(first.operationId); expect(second.change).toEqual(first.change)
  expect(first.change).toMatchObject({ kind: 'create', name: 'Original research notebook' })
  const state = await f.owner.read()
  expect(Object.values(state.notebooks).filter(book => book.name === 'Original research notebook')).toHaveLength(1)
  expect(state.revision).toBe(1); expect(Object.keys(state.operations)).toEqual([first.operationId])
  expect(created).toHaveBeenCalledTimes(1)
  expect(created).toHaveBeenCalledWith('notebookId' in first.change ? first.change.notebookId : null)
  expect(closed).not.toHaveBeenCalled(); expect(document.querySelector('.notebook-create-issue')).toBeNull()
})
