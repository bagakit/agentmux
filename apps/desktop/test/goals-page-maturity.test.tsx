// @vitest-environment happy-dom
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
async function click(label: string) { await act(async () => button(label).click()) }
async function fill(node: HTMLInputElement | HTMLTextAreaElement, value: string) { expect(node).toBeTruthy(); await act(async () => { Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function select(id = 'one') { await dom.click(`[data-demand-id="${id}"]`) }

describe('Goals whole-page current facts, reading and return through mounted owners', () => {
  it('states current facts in nonempty rows, then only navigates to corresponding target/result content', async () => {
    const entries = [goal('outline'), goal('decision', { alignment: { ...alignment, openQuestions: ['Should resume happen automatically?'] } }), goal('confirm', { alignment }), goal('agreed', { alignment: { ...alignment, confirmedAt: 3 } }), goal('results', { alignment: { ...alignment, confirmedAt: 3 }, grounding }), goal('unknown', { alignment: { ...alignment, confirmedAt: 3 }, grounding: { ...grounding, checks: [{ ...grounding.checks[0]!, outcome: 'unknown', evidence: [] }] } }), goal('stale', { alignment: { ...alignment, revision: 2, confirmedAt: 3 }, grounding })]
    useAppStore.setState({ demands: Object.fromEntries(entries.map(entry => [entry.id, entry])) }); await mount()
    expect([...dom.container.querySelectorAll('.goals-row__next')].map(node => node.textContent)).toEqual(['Goal needs an outline', 'Decision needed', 'Goal ready for confirmation', 'Goal agreed · No result report', 'Results ready for review', 'Results need checking', 'Results need updating'])
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
