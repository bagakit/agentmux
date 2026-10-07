// @vitest-environment happy-dom
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { workspaceProjectId } from '../src/renderer/src/lib/workspace-projects'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { GoalCommonProperties, GoalProperties } from '../src/renderer/src/components/GoalProperties'
import { SelectionField } from '../src/renderer/src/components/SelectionField'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'
import type { DemandProjection } from '../src/renderer/src/lib/global-demand-board'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const dom = composerDOM()
const projectId = (index: number) => workspaceProjectId(workspaces[index]!)
const goal = (id = 'source-a'): DemandProjection => ({ id, title: 'Original Goal', description: '', priority: 'normal', status: 'todo', projectId: projectId(3), projectName: 'Project 3', sessionIds: [], createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 2), source: 'default-topic' })
const workspaces = Array.from({ length: 14 }, (_, index) => ({ id: `project-${index}`, name: index === 11 ? '研究计划' : `Project ${index}`, hostId: 'local', path: fixturePath(`choice-workspace-${index}`), kind: 'folder' as const }))
const options = workspaces.map(item => ({ value: item.id, label: item.name, description: item.id === 'project-7' ? 'Distinct original description' : 'Local choice', disabled: item.id === 'project-5' }))
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 35)) })
const key = async (node: HTMLElement, value: string, extra: KeyboardEventInit = {}) => { await act(async () => node.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra }))); await settle() }
const field = (label = 'Goal project') => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"].selection-field`)!
const input = () => document.querySelector<HTMLInputElement>('.selection-field__search input')!
const items = () => [...document.querySelectorAll<HTMLElement>('[role=menuitemradio][data-value]')]
async function fill(value: string) { const node = input(); expect(node, 'original menu has a query input').not.toBeNull(); await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })) }); await settle() }
async function mountGoal(demand = goal()) { const onUpdate = vi.fn(); useAppStore.setState({ config: { ...composerConfig, workspaces } }); await dom.render(<GoalCommonProperties demand={demand} onUpdate={onUpdate} />); await key(field(), 'ArrowDown'); return onUpdate }

it('filters the original Goal project locally without changing saved value until explicit selection', async () => {
  const changed = await mountGoal()
  expect(input()).not.toBeNull(); expect(document.activeElement).toBe(input())
  expect(document.querySelector('[aria-checked=true]')?.textContent).toContain('Project 3')
  await fill('Project 12')
  expect(items().map(item => item.dataset.value)).toEqual([projectId(12)])
  expect(field().dataset.value).toBe(projectId(3)); expect(changed).not.toHaveBeenCalled()
  await key(input(), 'Enter'); expect(changed).not.toHaveBeenCalled()
  await key(input(), 'ArrowDown', { ctrlKey: true }); expect(document.activeElement).toBe(input()); expect(changed).not.toHaveBeenCalled()
  await key(input(), 'ArrowDown'); expect(document.activeElement).toBe(items()[0]); expect(items()[0]!.getAttribute('aria-checked')).toBe('false'); expect(changed).not.toHaveBeenCalled()
  await key(items()[0]!, 'Enter'); expect(changed).toHaveBeenCalledExactlyOnceWith({ projectId: projectId(12), projectName: 'Project 12' }); expect(document.querySelector('[role=menu]')).toBeNull(); expect(document.activeElement).toBe(field())
})
it('keeps no-match, clear and IME local, then returns focus through the original Radix menu', async () => {
  const changed = await mountGoal()
  await fill('not observed')
  expect(items()).toHaveLength(0); expect(document.querySelector('[role=status]')?.textContent).toBe('No matching options.'); expect(changed).not.toHaveBeenCalled()
  await key(input(), 'Tab'); const clear = document.querySelector<HTMLButtonElement>('[aria-label="Clear option search"]')!; expect(document.activeElement).toBe(clear)
  await act(async () => clear.click()); expect(input().value).toBe(''); expect(document.activeElement).toBe(input())
  await fill('研究'); await key(input(), 'ArrowDown', { isComposing: true }); expect(document.activeElement).toBe(input()); await key(input(), 'Enter', { keyCode: 229 }); expect(changed).not.toHaveBeenCalled()
  await key(input(), 'Escape', { isComposing: true }); expect(document.querySelector('[role=menu]')).not.toBeNull()
  await key(input(), 'ArrowDown'); expect(document.activeElement?.textContent).toContain('研究计划'); expect(changed).not.toHaveBeenCalled()
  await key(document.activeElement as HTMLElement, 'Escape'); expect(document.querySelector('[role=menu]')).toBeNull(); expect(document.activeElement).toBe(field()); expect(changed).not.toHaveBeenCalled()
  await key(field(), 'ArrowDown'); expect(input().value).toBe('')
})
it('preserves unknown and disabled original choices and searches descriptions without granting eligibility', async () => {
  const changed = vi.fn()
  await dom.render(<SelectionField label="Original choices" value="original-unknown" options={options} onValueChange={changed} />)
  await key(field('Original choices'), 'ArrowDown'); expect(document.querySelector('[aria-checked=true]')?.textContent).toContain('Saved selection')
  await fill('Distinct original'); expect(items().map(item => item.dataset.value)).toEqual(['project-7']); expect(field('Original choices').dataset.value).toBe('original-unknown')
  await fill('Project 5'); expect(items()).toHaveLength(1); expect(items()[0]!.getAttribute('aria-disabled')).toBe('true'); await act(async () => items()[0]!.click()); expect(changed).not.toHaveBeenCalled()
  await key(input(), 'ArrowDown'); expect(document.activeElement).toBe(input()); expect(changed).not.toHaveBeenCalled()
})
it('retains an unavailable Goal project as original saved identity while filtering other current projects', async () => {
  const changed = await mountGoal({ ...goal(), projectId: 'unavailable-project', projectName: 'Original project' })
  expect(document.querySelector('[aria-checked=true]')?.textContent).toContain('Original project · Unavailable')
  await fill('Original project'); expect(items()).toHaveLength(1); expect(items()[0]!.getAttribute('aria-disabled')).toBe('true'); await act(async () => items()[0]!.click()); expect(changed).not.toHaveBeenCalled()
  expect(field().dataset.value).toBe('unavailable-project')
})
it('preserves a same-source query through option refresh, but closes it across original Goal A-B-A', async () => {
  const changed = await mountGoal(); await fill('Project 12'); const original = input()
  useAppStore.setState({ config: { ...composerConfig, workspaces: workspaces.map(item => ({ ...item, name: item.id === 'project-12' ? 'Project 12 refreshed' : item.name })) } }); await settle()
  expect(input()).toBe(original); expect(input().value).toBe('Project 12'); expect(items()[0]!.textContent).toContain('refreshed')
  original.setSelectionRange(2, 6)
  await act(async () => useAppStore.setState({ config: { ...composerConfig, workspaces: workspaces.slice(0, 4) } })); await settle()
  expect(input()).toBe(original); expect(document.activeElement).toBe(original); expect(input().value).toBe('Project 12'); expect(items()).toHaveLength(0); expect(input().selectionStart).toBe(2); expect(input().selectionEnd).toBe(6)
  await act(async () => useAppStore.setState({ config: { ...composerConfig, workspaces } })); await settle()
  expect(input()).toBe(original); expect(document.activeElement).toBe(original); expect(input().value).toBe('Project 12'); expect(items().map(item => item.dataset.value)).toEqual([projectId(12)])
  await dom.render(<GoalCommonProperties demand={goal('source-b')} onUpdate={changed} />); await settle(); expect(document.querySelector('[role=menu]')).toBeNull(); expect(changed).not.toHaveBeenCalled()
  await key(field(), 'ArrowDown'); expect(input().value).toBe(''); await fill('Project 1')
  await dom.render(<GoalCommonProperties demand={goal()} onUpdate={changed} />); await settle(); expect(document.querySelector('[role=menu]')).toBeNull(); await key(field(), 'ArrowDown'); expect(input().value).toBe('')
})
it('uses the original Parent goal consumer while short and remote-owned choices retain their simple menu', async () => {
  const changed = vi.fn(), demand = goal()
  useAppStore.setState({ demands: Object.fromEntries(workspaces.map(item => [item.id, { ...goal(item.id), title: item.name }])) })
  await dom.render(<GoalProperties demand={demand} onUpdate={changed} />)
  await act(async () => { const details = dom.container.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')) }); await settle()
  await key(field('Parent goal'), 'ArrowDown'); await fill('Project 8'); await key(input(), 'ArrowDown'); await key(document.activeElement as HTMLElement, 'Enter'); expect(changed).toHaveBeenCalledExactlyOnceWith({ parentDemandId: 'project-8' })
  await dom.render(<SelectionField label="Remote results" value="project-3" options={options} onValueChange={changed} searchable={false} />); await key(field('Remote results'), 'ArrowDown'); expect(input()).toBeNull(); await key(document.activeElement as HTMLElement, 'Escape')
  await dom.render(<GoalCommonProperties demand={demand} onUpdate={changed} />); await key(field('Goal priority'), 'ArrowDown'); expect(input()).toBeNull(); await key(document.querySelector('[role=menu]')!, 'u'); expect(document.activeElement?.textContent).toContain('Urgent')
})
it('filters original Agent creation directories by description without creating a Session or saving relationships', async () => {
  const { GoalAgentPicker } = await import('../src/renderer/src/components/GoalAgentPicker')
  const save = vi.fn(), execute = vi.fn()
  useAppStore.setState({ config: { ...composerConfig, workspaces }, executeControl: execute, goalAgentSelectionDrafts: {}, goalAgentCreationDrafts: {} })
  await dom.render(<GoalAgentPicker demand={goal()} role="assignees" onSave={save} onClose={() => {}} />); await settle()
  const createMode = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'New Agent')!
  await act(async () => createMode.click()); await settle()
  const label = 'New Agent execution directory'
  await key(field(label), 'ArrowDown'); await fill('choice-workspace-12')
  expect(items().map(item => item.dataset.value)).toEqual(['project-12']); expect(field(label).dataset.value).toBe('project-3')
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) { const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...modifier }); await act(async () => input().dispatchEvent(event)); expect(event.defaultPrevented).toBe(true); expect(save).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled() }
  await key(input(), 'ArrowDown'); expect(save).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled()
  await key(document.activeElement as HTMLElement, 'Enter'); expect(field(label).dataset.value).toBe('project-12'); expect(save).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(document.querySelector('[role=dialog]')).not.toBeNull(); expect(document.activeElement).toBe(field(label))
})
it('keeps the actual remote room page and explicit server search outside local option filtering', async () => {
  const { ConnectorRoomSelection } = await import('../src/renderer/src/components/ConnectorRoomSelection')
  const { api } = await import('../src/renderer/src/lib/api')
  const config = { connectionId: 'original-connection', label: 'Original application', adapterId: 'controlled', enabled: true, credentialRef: 'original-secret', application: { domain: 'controlled', appId: 'original-app' } }
  const page = { connectionId: config.connectionId, connectionRevision: 1, application: config.application, observation: { state: 'ready' as const }, rooms: Array.from({ length: 20 }, (_, index) => ({ externalConversationId: `room-${index}`, name: `Original room ${index}`, state: 'active' as const })), next: 'original-cursor' }
  const calls = vi.spyOn(api.connections, 'call').mockResolvedValue(page), changed = vi.fn()
  await dom.render(<ConnectorRoomSelection connection={{ revision: 1, config }} value="room-3" onChange={changed} disabled={false} />); await settle()
  expect(calls).toHaveBeenCalledExactlyOnceWith('connection.room.ls', { connectionId: config.connectionId, expectedConnectionRevision: 1, limit: 20 })
  await key(field('Existing group'), 'ArrowDown'); expect(input()).toBeNull(); expect(items()).toHaveLength(21); await key(document.activeElement as HTMLElement, 'Escape')
  const remote = document.querySelector<HTMLInputElement>('[aria-label="Search groups"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(remote, 'Original query'); remote.dispatchEvent(new Event('input', { bubbles: true })) }); await key(remote, 'Enter')
  expect(calls).toHaveBeenLastCalledWith('connection.room.search', { connectionId: config.connectionId, expectedConnectionRevision: 1, limit: 20, query: 'Original query' }); expect(changed).not.toHaveBeenCalled()
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'More groups')!.click()); await settle()
  expect(calls).toHaveBeenLastCalledWith('connection.room.search', { connectionId: config.connectionId, expectedConnectionRevision: 1, limit: 20, query: 'Original query', cursor: 'original-cursor' })
})
