// @vitest-environment happy-dom
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { openDemandStore } from '@agentmux/demand'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { WorkspaceRecord } from '../src/shared/contracts'
import * as projectProjection from '../src/renderer/src/lib/workspace-projects'
import { projectWorkspaces } from '../src/renderer/src/lib/workspace-projects'
import { documentKey, fileTabId } from '../src/renderer/src/lib/workbench-tabs'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { EMPTY_AGENT_FOCUS } from '../src/renderer/src/lib/agent-focus'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { configOwnerFixture } from './helpers/config-owner-fixture'

const dom = composerDOM()
const alignment = { summary: 'Keep the original work recoverable.', criteria: [{ id: 'tabs', text: 'The original tabs and splits remain.' }], openQuestions: [], revision: 1, confirmedAt: null }
const grounding = { summary: 'The original tab identities match the saved log.', alignmentRevision: 1, submissionId: 'report:current', acceptedAt: null, checks: [{ criterionId: 'tabs', outcome: 'met' as const, note: 'Saved and restored identities agree.', evidence: ['artifacts/recovery.log:18'] }] }
function goal(id = 'one', patch: Partial<DemandRecord> = {}): DemandRecord { return { id, title: `Recover the work ${id}`, description: 'Keep healthy Agents and existing work.', priority: 'normal', status: 'in_progress', projectId: null, projectName: null, sessionIds: [], createdAt: 1, updatedAt: 2, source: 'default-topic', ...patch } }
let f: Awaited<ReturnType<typeof configOwnerFixture>>
const pendingDemand = new Set<Promise<unknown>>()
function demandTransport<T>(value: Promise<T>) { pendingDemand.add(value); void value.finally(() => pendingDemand.delete(value)).catch(() => {}); return value }
async function settleDemand() { for (let i = 0; i < 4; i++) { await Promise.resolve(); await Promise.allSettled([...pendingDemand]) } }
const createTopic = vi.fn(async () => 'original-topic')
const request = vi.fn(async () => 'original-goal-tab')
const open = vi.fn(async () => 'original-goal-tab')
beforeEach(async () => {
  f = await configOwnerFixture({ workspaces: [], composerShortcuts: [] })
  const publish = f.publish.getMockImplementation()!
  f.publish.mockImplementation(saved => { publish(saved); useAppStore.setState({ config: saved }) })
  vi.spyOn(api.config, 'save').mockImplementation((next, expected) => f.owner.edit(expected, next))
  createTopic.mockReset().mockResolvedValue('original-topic'); request.mockReset().mockResolvedValue('original-goal-tab'); open.mockReset().mockResolvedValue('original-goal-tab')
  useAppStore.setState({ config: f.owner.current, demands: { one: goal() }, selectedDemandId: null, agentFocus: EMPTY_AGENT_FOCUS, activeWorkspaceId: null, mainSurface: 'board', sessions: [composerSession('healthy')], createScratchTopic: createTopic, requestDemandPmoTask: request, openDemandPmo: open })
})
async function mount() { await dom.render(<GlobalBoardSurface />) }
function button(label: string) { const node = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label); expect(node, label).toBeDefined(); return node! }
async function click(label: string) { await act(async () => { button(label).click(); await settleDemand() }) }
async function fill(node: HTMLInputElement | HTMLTextAreaElement, value: string) { expect(node).toBeTruthy(); await act(async () => { Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function select(id = 'one') { await dom.click(`[data-demand-id="${id}"]`) }

describe('Goals whole-page current facts, reading and return through mounted owners', () => {
  it('states current facts in nonempty rows, then only navigates to corresponding target/result content', async () => {
    const entries = [goal('outline'), goal('decision', { alignment: { ...alignment, openQuestions: ['Should resume happen automatically?'] } }), goal('confirm', { alignment }), goal('agreed', { alignment: { ...alignment, confirmedAt: 3 } }), goal('results', { alignment: { ...alignment, confirmedAt: 3 }, grounding }), goal('unknown', { alignment: { ...alignment, confirmedAt: 3 }, grounding: { ...grounding, checks: [{ ...grounding.checks[0]!, outcome: 'unknown', evidence: [] }] } }), goal('stale', { alignment: { ...alignment, revision: 2, confirmedAt: 3 }, grounding })]
    useAppStore.setState({ demands: Object.fromEntries(entries.map(entry => [entry.id, entry])) }); await mount()
    expect([...dom.container.querySelectorAll('.goals-row__next')].map(node => node.textContent), 'Goal rows describe actual current target/result facts').toEqual(['Goal needs an outline', 'Decision needed', 'Goal ready for confirmation', 'Goal agreed · No result report', 'Results ready for review', 'Results need checking', 'Results need updating'])
    const row = dom.container.querySelector<HTMLElement>('[data-demand-id="confirm"]')!
    expect(row.querySelector('.goals-row__open')).not.toBeNull()
    await act(async () => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(useAppStore.getState().selectedDemandId).toBe('confirm')
    expect(dom.container.querySelector('.goals-alignment h2')!.textContent).toBe('Goal definition')
    expect([...dom.container.querySelectorAll('[data-goal-success-criterion]')].map(node => node.textContent)).toEqual(['The original tabs and splits remain.'])
    expect(dom.container.querySelector('[data-goal-confirm]')).not.toBeNull()
    expect(request).not.toHaveBeenCalled(); expect(createTopic).not.toHaveBeenCalled()
    await select('decision')
    expect(dom.container.querySelector('.goals-open-questions')!.textContent).toContain('Should resume happen automatically?')
    expect(dom.container.querySelector('.goals-open-questions')!.closest('details')).toBeNull()
    expect(dom.container.querySelector('[data-goal-confirm]')).toBeNull()
    await select('results')
    expect(dom.container.querySelector('.goals-grounding h2')!.textContent).toBe('Results review')
    expect([...dom.container.querySelectorAll('[data-goal-criterion-id]')].map(node => [node.getAttribute('data-goal-criterion-id'), node.getAttribute('data-goal-outcome')])).toEqual([['tabs', 'met']])
  })

  it('temporarily compacts the same common instance, preserves authored body and preference, and returns focus to its editor', async () => {
    await mount(); await click('管理'); await click('新增操作')
    const editor = dom.container.querySelector<HTMLTextAreaElement>('[data-common-editor] textarea')!
    await fill(editor, 'A real unsaved instruction.'); editor.focus()
    const originalDirectory = f.owner.current.goalsCommonActions
    await select()
    const content = dom.container.querySelector<HTMLElement>('.goals-common__content')!
    expect(content.hidden, 'Selected Goal compacts entry without replacing its draft owner').toBe(true)
    expect(dom.container.querySelector('[data-common-editor] textarea')).toBe(editor)
    expect(dom.container.querySelector('.goals-common__context-feedback')!.textContent).toContain('尚未保存')
    await click('回到常用操作')
    expect(content.hidden).toBe(false)
    expect(dom.container.querySelector('[data-common-editor] textarea')).toBe(editor)
    expect(editor.value).toBe('A real unsaved instruction.')
    expect(document.activeElement).toBe(editor)
    expect(f.owner.current.goalsCommonActions).toEqual(originalDirectory)
    expect(api.config.save).not.toHaveBeenCalled(); expect(createTopic).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions.map(session => session.control)).toEqual([composerSession('healthy').control])
  })

  it('shows newly arriving save failure in compact context and returns to the same editable draft', async () => {
    await mount(); await click('管理'); await click('新增操作')
    const editor = dom.container.querySelector<HTMLTextAreaElement>('[data-common-editor] textarea')!
    await fill(editor, 'Keep the failed body.'); editor.focus()
    let reject!: (reason: Error) => void
    f.save.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    await click('保存操作'); await select()
    expect(dom.container.querySelector('.goals-common__context-feedback')!.textContent).toContain('正在保存')
    await act(async () => reject(new Error('save receipt unconfirmed')))
    await vi.waitFor(() => expect(dom.container.querySelector('.goals-common__context-feedback')!.textContent).toContain('保存未完成'))
    expect(dom.container.querySelector('.goals-common__content')!.hasAttribute('hidden')).toBe(true)
    await click('回到常用操作')
    expect(dom.container.querySelector('[data-common-editor] textarea')).toBe(editor)
    expect(editor.value).toBe('Keep the failed body.')
    expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('save receipt unconfirmed')
    expect((await f.disk()).composerShortcuts).toEqual([])
  })

  it('returns to a live focus target when the previously focused save and editor are still disabled', async () => {
    await mount(); await click('管理'); await click('新增操作')
    const editor = dom.container.querySelector<HTMLTextAreaElement>('[data-common-editor] textarea')!
    await fill(editor, 'An instruction whose save is still pending.')
    let reject!: (reason: Error) => void
    f.save.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    button('保存操作').focus(); await click('保存操作'); await select()
    expect(editor.disabled).toBe(true)
    await click('回到常用操作')
    expect(document.activeElement, 'Pending return uses a currently enabled control').toBe(button('完成'))
    expect(editor.value).toBe('An instruction whose save is still pending.')
    await act(async () => reject(new Error('still unconfirmed')))
    await vi.waitFor(() => expect(editor.disabled).toBe(false))
    expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('still unconfirmed')
  })

  it('projects a new preparation failure from the original launch owner while a Goal remains selected', async () => {
    let reject!: (reason: Error) => void
    createTopic.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    await mount(); await dom.click('[data-common-action="builtin:ideas"]'); await select()
    expect(dom.container.querySelector('.goals-common__context-feedback')!.textContent).toContain('正在准备对话')
    await act(async () => reject(new Error('launch receipt unconfirmed')))
    await vi.waitFor(() => expect(dom.container.querySelector('.goals-common__context-feedback')!.textContent).toContain('对话准备未确认'))
    expect(useAppStore.getState().selectedDemandId).toBe('one')
    expect(useAppStore.getState().sessions.map(session => session.control)).toEqual([composerSession('healthy').control])
    await click('回到常用操作')
    expect(dom.container.querySelector('.goals-common__content')!.hasAttribute('hidden')).toBe(false)
    expect(dom.container.querySelector('.goals-service')!.textContent).toContain('launch receipt unconfirmed')
  })

  it('recovers zero matches in place and retains query and Goal draft across detail navigation', async () => {
    useAppStore.setState({ demands: { one: goal(), two: goal('two') } }); await mount()
    const search = dom.container.querySelector<HTMLInputElement>('[aria-label="Search goals"]')!
    await fill(search, 'no such outcome')
    expect([...dom.container.querySelectorAll('[data-demand-id]')]).toEqual([])
    expect(dom.container.querySelector('.goals-empty')!.textContent).toContain('no such outcome')
    await click('Clear search & filters')
    expect(search.value).toBe('')
    expect(document.activeElement, 'Clearing zero matches returns focus to the live search').toBe(search)
    expect([...dom.container.querySelectorAll('[data-demand-id]')].map(node => node.getAttribute('data-demand-id'))).toEqual(['one', 'two'])
    await fill(search, 'one'); await select()
    const title = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal title"]')!
    await fill(title, 'Unsaved clearer title')
    await click('Back to goals'); expect(search.value).toBe('one')
    await select()
    expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal title"]')!.value).toBe('Unsaved clearer title')
    expect(request).not.toHaveBeenCalled(); expect(createTopic).not.toHaveBeenCalled()
  })

  it('places the original open discussion action by no-report facts, without sending a verification request', async () => {
    useAppStore.setState({ demands: { one: goal('one', { alignment: { ...alignment, confirmedAt: 3 } }) }, selectedDemandId: 'one' }); await mount()
    const section = dom.container.querySelector('[data-goal-result-state="missing"]')!
    expect(section.querySelector('h2')!.textContent).toBe('Results review')
    expect(section.querySelector('.goals-button--primary')!.textContent).toContain('Open discussion')
    expect([...dom.container.querySelectorAll('[aria-label="Open discussion for Recover the work one"]')]).toHaveLength(1)
    await click('Open discussion for Recover the work one')
    expect(open).toHaveBeenCalledExactlyOnceWith('one'); expect(request).not.toHaveBeenCalled()
    await dom.click('[data-goal-grounding]')
    expect(request).toHaveBeenCalledExactlyOnceWith('one', 'grounding')
    expect(open).toHaveBeenCalledTimes(1)
  })
})


function projectFixture(path = '/repo') {
  const workspaces: WorkspaceRecord[] = [
    { id: 'uuid:worktree', name: 'feature', path: `${path}/.worktrees/feature`, repoPath: path, hostId: 'local', kind: 'worktree' },
    { id: 'uuid:root', name: 'Repo', path, hostId: 'local', kind: 'folder' },
    { id: 'uuid:other-host', name: 'Other host Repo', path, hostId: 'other-host', kind: 'folder' }
  ]
  const projects = projectWorkspaces(workspaces)
  expect(projects.map(project => project.workspaces.map(workspace => workspace.id))).toEqual([['uuid:worktree', 'uuid:root'], ['uuid:other-host']])
  expect(projects.map(project => project.preferredWorkspaceId)).toEqual(['uuid:root', 'uuid:other-host'])
  expect(projects[0]!.id).not.toBe(workspaces[1]!.id)
  useAppStore.setState({ config: { ...f.owner.current, workspaces } })
  return { workspaces, projects }
}
async function choose(node: HTMLSelectElement, value: string) { await act(async () => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); await settleDemand() }) }
function durableOwner() {
  const owner = openDemandStore({ root: join(dirname(f.store.filePath), 'demands') })
  vi.spyOn(api.demands, 'create').mockImplementation(input => demandTransport(owner.create({ ...input, id: 'authored-project-goal' })))
  vi.spyOn(api.demands, 'update').mockImplementation((id, patch) => demandTransport(owner.update(id, patch)))
  return owner
}

describe('Goals consume opaque Project identities through original mounted product owners', () => {
  it('groups root/worktree once without mixing hosts, filters opaque IDs and writes only explicit Project choices to the durable Demand owner', async () => {
    const { projects } = projectFixture(), owner = durableOwner()
    useAppStore.setState({ demands: { one: goal('one', { projectId: projects[0]!.id, projectName: 'Repo' }), remote: goal('remote', { projectId: projects[1]!.id, projectName: projects[1]!.name }) } })
    await mount(); await click('Goal filters')
    const filter = dom.container.querySelector<HTMLSelectElement>('[aria-label="Filter project"]')!
    expect([...filter.options].map(option => [option.value, option.textContent])).toEqual([['all', 'All projects'], [projects[0]!.id, 'Repo'], [projects[1]!.id, 'Other host Repo']])
    await choose(filter, projects[0]!.id)
    expect([...dom.container.querySelectorAll('[data-demand-id]')].map(node => node.getAttribute('data-demand-id'))).toEqual(['one'])
    await click('New Goal'); await fill(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal intent"]')!, 'Create a real goal in this Project.'); await click('Save & discuss')
    await vi.waitFor(async () => expect((await owner.get('authored-project-goal'))!.projectId).toBe(projects[0]!.id))
    expect((await owner.get('authored-project-goal'))!).toMatchObject({ projectId: projects[0]!.id, projectName: 'Repo', description: 'Create a real goal in this Project.' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledExactlyOnceWith('authored-project-goal', 'grill'))
    const property = dom.container.querySelector<HTMLSelectElement>('[aria-label="Goal project"]')!
    expect(property.value).toBe(projects[0]!.id)
    expect([...property.options].map(option => option.value)).toEqual(['', projects[0]!.id, projects[1]!.id])
    await choose(property, projects[1]!.id)
    await vi.waitFor(async () => expect((await owner.get('authored-project-goal'))!).toMatchObject({ projectId: projects[1]!.id, projectName: 'Other host Repo' }))
    await choose(property, '')
    await vi.waitFor(async () => expect((await owner.get('authored-project-goal'))!).toMatchObject({ projectId: null, projectName: null }))
    expect(createTopic).not.toHaveBeenCalled()
  })

  it('opens opaque Project evidence through its preferred Workspace and exact original file path/line/column without accepting the report', async () => {
    const directory = dirname(f.store.filePath), { projects } = projectFixture(directory), owner = durableOwner()
    await owner.create({ id: 'one', title: 'Real evidence', projectId: projects[0]!.id, projectName: projects[0]!.name, sessionIds: ['healthy'], status: 'in_progress' })
    const recordId = 'one'
    await owner.update(recordId, { alignment: { summary: alignment.summary, criteria: alignment.criteria, openQuestions: alignment.openQuestions } }); await owner.confirmAlignment(recordId, 1)
    await owner.update(recordId, { grounding: { alignmentRevision: 1, summary: grounding.summary, checks: [{ ...grounding.checks[0]!, evidence: ['artifacts/recovery.log:18:7', '../outside.log:2'] }] } })
    const before = await owner.get(recordId)
    await mkdir(join(directory, 'artifacts')); await writeFile(join(directory, 'artifacts/recovery.log'), 'Original evidence bytes.\n')
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    const read = vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, path) => ({ status: 'read', document: { path, content: await readFile(join(directory, path), 'utf8'), revision: 'project-evidence-r1' } }))
    useAppStore.setState({ demands: { one: before! }, selectedDemandId: 'one', layouts: { 'uuid:root': createWorkspaceLayout('uuid:root') }, tabs: {}, documents: {}, documentRevealTargets: {} })
    await mount(); await click('recovery.log:18:7')
    await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); expect(read, 'Opaque Project resolves the preferred Workspace in the actual file pipeline').toHaveBeenCalledExactlyOnceWith('uuid:root', 'artifacts/recovery.log'); expect(useAppStore.getState().documents[documentKey('uuid:root', 'artifacts/recovery.log')]).toBeDefined() })
    expect(useAppStore.getState().documents[documentKey('uuid:root', 'artifacts/recovery.log')]).toEqual({ path: 'artifacts/recovery.log', content: 'Original evidence bytes.\n', revision: 'project-evidence-r1' })
    expect(useAppStore.getState().documentRevealTargets[documentKey('uuid:root', 'artifacts/recovery.log')]).toEqual({ line: 18, column: 7 })
    expect(useAppStore.getState().tabs[fileTabId('uuid:root', 'artifacts/recovery.log')]?.workspaceId).toBe('uuid:root')
    await click('outside.log:2'); expect(dom.container.textContent).toContain('outside the goal’s Project')
    expect(read).toHaveBeenCalledTimes(1)
    expect(await owner.get(recordId)).toEqual(before)
    expect(useAppStore.getState().sessions.map(session => session.control)).toEqual([composerSession('healthy').control])
    expect(request).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
  })

  it('retains unknown bindings and names through registry changes; Workspace UUIDs remain unavailable rather than a guessed Project', async () => {
    const { projects, workspaces } = projectFixture()
    const original = goal('one', { projectId: projects[0]!.id, projectName: 'Original bound Project', alignment: { ...alignment, confirmedAt: 3 }, grounding })
    const update = vi.spyOn(api.demands, 'update')
    useAppStore.setState({ demands: { one: original }, selectedDemandId: 'one' }); await mount()
    const property = dom.container.querySelector<HTMLSelectElement>('[aria-label="Goal project"]')!
    expect(property.value).toBe(projects[0]!.id)
    await act(async () => useAppStore.setState({ config: { ...f.owner.current, workspaces: [] } }))
    expect(property.value).toBe(projects[0]!.id)
    expect([...property.options].map(option => [option.value, option.textContent, option.disabled])).toEqual([['', 'Unassigned', false], [projects[0]!.id, 'Original bound Project · Unavailable', true]])
    await click('recovery.log:18'); expect(dom.container.textContent).toContain('bound Project is unavailable')
    const read = vi.spyOn(api.files, 'read')
    await act(async () => useAppStore.setState({ config: { ...f.owner.current, workspaces }, demands: { one: { ...original, projectId: 'uuid:root' } } }))
    expect(property.value).toBe('uuid:root')
    expect(property.selectedOptions[0]!.textContent).toBe('Original bound Project · Unavailable')
    await click('recovery.log:18'); expect(dom.container.textContent).toContain('bound Project is unavailable')
    expect(read).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled()
    expect(useAppStore.getState().demands.one!).toMatchObject({ projectId: 'uuid:root', projectName: 'Original bound Project', grounding })
  })

  it('reuses each existing Project projection across unrelated store publications and shares one bound Workspace across real checks', async () => {
    const { projects, workspaces } = projectFixture()
    const group = vi.spyOn(projectProjection, 'projectWorkspaces')
    const twoCriteria = [{ id: 'tabs', text: 'Original tabs remain.' }, { id: 'draft', text: 'Original draft remains.' }]
    useAppStore.setState({ demands: { one: goal('one', { projectId: projects[0]!.id, alignment: { ...alignment, criteria: twoCriteria, confirmedAt: 3 }, grounding: { ...grounding, checks: twoCriteria.map(criterion => ({ criterionId: criterion.id, outcome: 'met', note: 'Observed.', evidence: ['artifacts/recovery.log:18'] })) } }) }, selectedDemandId: 'one' })
    await mount()
    expect([...dom.container.querySelectorAll('[data-goal-criterion-id]')].map(node => node.getAttribute('data-goal-criterion-id'))).toEqual(['tabs', 'draft'])
    const initialCalls = group.mock.calls.length
    expect(initialCalls, 'Three existing consumers actually project a nonempty Workspace registry').toBe(3)
    await act(async () => { for (let i = 0; i < 20; i++) useAppStore.setState({ agentComposerDrafts: { unrelated: `Draft ${i}` } }) })
    expect(group.mock.calls.length, 'Unrelated store publications do not regroup Projects per evidence criterion').toBe(initialCalls)
    await act(async () => useAppStore.setState({ config: { ...f.owner.current, workspaces: [...workspaces] } }))
    expect(group.mock.calls.length).toBe(initialCalls + 3)
  })

})
