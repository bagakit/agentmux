import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createWorkspaceLayout } from '@agentmux/layout'
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("tmp") } }))
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { SettingsNavigation, type SettingsNavigationRequest } from '../src/renderer/src/components/SettingsNavigation'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { EMPTY_AGENT_FOCUS } from '../src/renderer/src/lib/agent-focus'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { resolveComposerShortcuts } from '../src/shared/composer-shortcut-library'
import { authoredConfigCarryOver } from '../src/main/config-store'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'

import { configureGoalsCommonActions } from '../src/main/settings-preferences-control'

const dom = composerDOM()
const prompts = [
  { id: 'review', keyword: 'review', label: '检查改动', body: '  检查实际改动，指出具体风险。\n保留原话与证据。  ', providerId: 'claude', states: ['done' as const] },
  { id: 'notes', keyword: 'notes', label: '整理笔记', body: '读我的笔记，建议一个可验证的下一步。' }
]
let f: Awaited<ReturnType<typeof configOwnerFixture>>
const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', path: _hygiene_fixturePath("topics"), hostId: 'local', kind: 'folder' as const }
const createTopic = vi.fn(async () => 'owned-topic')
const openTopic = vi.fn(async () => 'owned-topic')
function primaryClaude() {
  const session = { ...composerSession('primary', 'claude'), executorId: 'otherClaude', workspacePath: _hygiene_fixturePath("topics/topic--launcher--leader") }
  const tab = { ...createWorkbenchTab('primary-tab', { kind: 'agent', phase: 'attached', regionId: 'primary-region', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: session.id }), topicId: PMO_TEAMS_TOPIC_ID }
  useAppStore.setState({ sessions: [session], tabs: { [tab.id]: tab }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('primary-group', [tab.id]) } })
  return session
}
beforeEach(async () => {
  f = await configOwnerFixture({ composerShortcuts: prompts, workspaces: [scratch], executors: {
    codex: composerConfig.executors.codex!,
    claude: { ...composerConfig.executors.codex!, providerId: 'claude', label: 'Claude Local', command: 'claude' },
    otherClaude: { ...composerConfig.executors.codex!, providerId: 'claude', label: 'Other Claude', command: 'claude' }
  } })
  const publish = f.publish.getMockImplementation()!
  f.publish.mockImplementation(saved => { publish(saved); useAppStore.setState({ config: saved }) })
  useAppStore.setState({ config: f.owner.current, demands: {}, selectedDemandId: null, agentFocus: EMPTY_AGENT_FOCUS, activeWorkspaceId: null,
    mainSurface: 'board', createScratchTopic: createTopic, openScratchTopic: openTopic, sessions: [], tabs: {}, layouts: {}, executorDetections: {}, loading: false })
  createTopic.mockClear(); openTopic.mockReset().mockResolvedValue('owned-topic')
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => f.owner.edit(expected, next))
  vi.spyOn(api.config, 'configureGoalsCommonActions').mockImplementation(input => configureGoalsCommonActions(f.owner, input))
})
function CommonActionSurface({ onNavigate }: { onNavigate: ReturnType<typeof vi.fn> }) {
  const [route, setRoute] = useState<SettingsNavigationRequest | null>(null), [visible, setVisible] = useState(false)
  return <SettingsNavigation.Provider value={{ open: (section, executorId, field) => { onNavigate(section, executorId, field); setRoute({ section, executorId, field }); setVisible(true) },
    openToolkit: () => {}, openHost: () => {}, openChannel: () => {}, channelEntries: [], channelPresentation: () => null, openMoteConnection: () => {}, chooseAgent: () => {} }}>
    <GlobalBoardSurface />
    {route ? <SettingsPanel visible={visible} initialSection={route.section} navigationRequest={route} onClose={() => setVisible(false)} /> : null}
  </SettingsNavigation.Provider>
}
async function mount(open = vi.fn()) { await dom.render(<CommonActionSurface onNavigate={open} />); return open }
async function closeSettings() { await dom.click('[aria-label="Close settings"]') }
function button(text: string) {
  const buttons = [...dom.container.querySelectorAll<HTMLButtonElement>('button')]
  const found = buttons.find(button => button.textContent?.trim() === text)
  expect(found, `Actual product button ${text}`).not.toBeUndefined()
  return found!
}
async function click(text: string) { await act(async () => button(text).click()) }
const action = (key: string) => dom.container.querySelector<HTMLButtonElement>(`[data-common-action="${key}"]`)
const body = () => dom.container.querySelector<HTMLTextAreaElement>('[data-prompt-editor] textarea')!
async function fill(value: string) {
  const node = body(); expect(node).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function settled() {
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    if (dom.container.querySelector('.goals-common')?.getAttribute('aria-busy') !== 'true' && !dom.container.querySelector('[data-settings-save-bar] [aria-busy="true"]')) return
  }
  throw new Error('Common action save did not settle')
}
async function manage() {
  await dom.click('[aria-label="Configure common actions"]')
  expect(dom.container.querySelector('[data-settings-page]')!.getAttribute('data-settings-page')).toBe('goals')
  expect(dom.container.querySelector<HTMLDetailsElement>('[data-settings-field="goals-common-actions"]')!.open).toBe(true)
  expect(dom.container.querySelector('[aria-label="管理常用操作"]')).toBeNull()
}
async function openDirectory() {
  if (dom.container.querySelector('[data-settings-page]')?.getAttribute('data-settings-page') === 'prompts') await click('Goals common actions')
  const directory = dom.container.querySelector<HTMLDetailsElement>('[data-settings-field="goals-common-actions"]')!
  if (!directory.open) await act(async () => directory.querySelector('summary')!.click())
  expect(directory.open).toBe(true)
  return directory
}
async function reference(label = '检查改动') {
  await openDirectory()
  const toggle = button('Reference a prompt')
  if (toggle.getAttribute('aria-expanded') !== 'true') await act(async () => toggle.click())
  await act(async () => {
    const entry = [...dom.container.querySelectorAll<HTMLButtonElement>('[data-common-add]')].find(node => node.textContent === label)
    expect(entry).not.toBeUndefined(); entry!.click()
  })
  await save()
}
async function save() { const page = dom.container.querySelector('[data-settings-page]')!.getAttribute('data-settings-page'); await click(page === 'goals' ? 'Save common actions' : 'Save prompts'); await settled() }
async function external(patch: Partial<typeof f.owner.current>) {
  const current = f.owner.current
  await act(async () => { await f.owner.edit(current, { ...current, ...patch }) })
}

describe('Goals common actions through the mounted product and durable config owner', () => {
  it('orders, removes and discloses through distinct themeable meanings in the actual directory', async () => {
    await mount(); await manage()
    const up = dom.container.querySelector('[aria-label="Move up 了解我并给我建议"]')!
    const down = dom.container.querySelector('[aria-label="Move down 了解我并给我建议"]')!
    const remove = dom.container.querySelector('[aria-label="Remove from Goals 了解我并给我建议"]')!
    expect(up.querySelector('svg')?.getAttribute('data-semantic-icon')).toBe('action.move-up')
    expect(down.querySelector('svg')?.getAttribute('data-semantic-icon')).toBe('action.move-down')
    expect(remove.querySelector('svg')?.getAttribute('data-semantic-icon')).toBe('action.remove')
    expect((up as HTMLButtonElement).disabled).toBe(true)
    expect((down as HTMLButtonElement).disabled).toBe(false)
    const collapse = dom.container.querySelector('[aria-label="Collapse common actions"]')!
    expect(collapse.querySelector('svg')?.getAttribute('data-semantic-icon')).toBe('navigation.up')
    expect(openTopic).not.toHaveBeenCalled(); expect(createTopic).not.toHaveBeenCalled()
    await dom.click('[aria-label="Move down 了解我并给我建议"]'); await save()
    expect(f.owner.current.goalsCommonActions?.items[1]).toEqual({ kind: 'builtin', id: 'understand' })
  })

  it('shows two complete default requests with semantic art and retains the original action when art fails', async () => {
    await mount()
    const requests = [...dom.container.querySelectorAll('.goals-entry__request')].map(node => node.textContent)
    expect(requests).toEqual(['我还不知道能做什么，可以了解我并给我建议吗？', '我有一些点子，我们开始尝试一个项目'])
    expect(dom.container.querySelectorAll('.goals-common__heading img')).toHaveLength(0)
    const images = [...dom.container.querySelectorAll<HTMLImageElement>('.goals-common__art')]
    expect(images, 'The real product consumes semantic artwork for each visible CTA').toHaveLength(2)
    expect(images[0]!.src).toContain('goal-understand.png')
    expect(images[1]!.src).toContain('goal-ideas.png')
    for (const image of images) {
      expect(image.alt).toBe('')
      expect(image.getAttribute('aria-hidden')).toBe('true')
      expect(image.hasAttribute('tabindex')).toBe(false)
    }
    await act(async () => images[1]!.dispatchEvent(new Event('error')))
    expect(images[1]!.hidden).toBe(true)
    expect(action('builtin:ideas')!.querySelector('.goals-entry__request')!.textContent).toBe(requests[1])
    expect(dom.container.querySelector('.goals-common__heading')!.textContent).toContain('Common actions')
    expect(dom.container.querySelector('.goals-collection')).not.toBeNull()
    expect(action('builtin:next')).toBeNull()
    await act(async () => action('builtin:ideas')!.click())
    expect(openTopic).toHaveBeenCalledExactlyOnceWith(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { newTab: true, reveal: false, initialRequest: { prompt: '我有一些点子，我们开始尝试一个项目', executorId: 'codex' } })
    expect(createTopic).not.toHaveBeenCalled()
  })

  it('uses the three builtin images and one neutral image for any authored prompt without changing its body or target', async () => {
    await external({ workspaces: [scratch, { id: 'art-project', name: '真实项目', hostId: 'local', path: _hygiene_fixturePath("repo/art-project"), kind: 'folder' }],
      goalsCommonActions: { items: [{ kind: 'builtin', id: 'understand' }, { kind: 'builtin', id: 'ideas' }, { kind: 'builtin', id: 'next' }, { kind: 'prompt', id: 'notes' }], collapsed: false } })
    useAppStore.setState({ activeWorkspaceId: 'art-project' })
    await mount(); await click('All actions (4)')
    for (const [key, asset] of [['builtin:understand', 'goal-understand'], ['builtin:ideas', 'goal-ideas'], ['builtin:next', 'goal-next'], ['prompt:notes', 'goal-custom']] as const) {
      expect(action(key)!.querySelector<HTMLImageElement>('.goals-common__art')!.src).toContain(`${asset}.png`)
    }
    expect(action('builtin:next')!.querySelector('.goals-common__facts')!.textContent).toContain('真实项目')
    expect(action('prompt:notes')!.querySelector('.goals-entry__request')!.textContent).toBe(prompts[1]!.body)
    await act(async () => action('prompt:notes')!.click())
    expect(openTopic).toHaveBeenCalledExactlyOnceWith(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { newTab: true, reveal: false, initialRequest: { prompt: prompts[1]!.body, executorId: 'codex' } })
    expect(createTopic).not.toHaveBeenCalled()
  })

  it('references the original full body and uses the actual primary bot even when terminal states exclude running', async () => {
    const original = primaryClaude()
    await mount(); await manage(); await reference(); await closeSettings()
    const node = action('prompt:review')!
    expect(node.querySelector('.goals-entry__request')!.textContent, 'Live prompt body is the complete request').toBe(prompts[0]!.body)
    expect(node.querySelector('.goals-common__facts')!.textContent, 'The visible target comes from the actual primary Session and configured provider').toBe('Primary Mote · Other Claude')
    expect(node.disabled).toBe(false)
    await act(async () => node.click())
    expect(openTopic, 'Visible body and the actual primary executor reach the original Mote owner').toHaveBeenCalledExactlyOnceWith(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { newTab: true, reveal: false, initialRequest: { prompt: prompts[0]!.body, executorId: 'otherClaude' } })
    expect(createTopic).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions[0]!.control).toEqual(original.control)
    expect((await f.disk()).composerShortcuts).toEqual(prompts)
  })

  it('creates one authored body and its reference atomically, generating helper fields and preserving foreign config', async () => {
    await mount(); await manage(); await click('Add common action')
    expect(dom.container.querySelector<HTMLElement>('[data-settings-pane="goals"]')!.hidden).toBe(true)
    const text = '  帮我检查今天的笔记。\n指出一个值得尝试的方向。  '
    await fill(text)
    await external({ appearance: { terminalTheme: 'graphite', appAppearance: 'light' } })
    await save()
    const saved = await f.disk(), created = saved.composerShortcuts!.find(prompt => !prompts.some(original => original.id === prompt.id))!
    expect(created.body, 'One-body creation retains exact authored bytes').toBe(text)
    expect(created.label).toBe('帮我检查今天的笔记。')
    expect(created.keyword).toMatch(/^action-/)
    expect(new Set(saved.composerShortcuts!.map(prompt => prompt.keyword)).size).toBe(3)
    expect(saved.goalsCommonActions?.items.at(-1)).toEqual({ kind: 'prompt', id: created.id })
    expect(saved.appearance.appAppearance).toBe('light')
    expect(vi.mocked(api.config.save)).toHaveBeenCalledTimes(1)
    expect(createTopic, 'Management and save never start an Agent').not.toHaveBeenCalled()
    await closeSettings()
    expect(action(`prompt:${created.id}`)!.querySelector('.goals-entry__request')!.textContent).toBe(text)
  })

  it('updates the same original library body, merging unrelated external fields and exposing that body in Settings', async () => {
    await mount(); await manage(); await reference()
    await dom.click('[data-common-select="prompt:review"]')
    const text = '先核对目标，再只检查确实相关的改动。'
    await fill(text)
    await external({ composerShortcuts: [{ ...prompts[0]!, label: '外部名称' }, prompts[1]!] })
    await save()
    expect((await f.disk()).composerShortcuts, 'Shared library edit updates the original authored body').toEqual([{ ...prompts[0], label: '外部名称', body: text }, prompts[1]])
    expect(resolveComposerShortcuts(useAppStore.getState().config).find(prompt => prompt.id === 'review')!.body).toBe(text)
    await closeSettings(); await manage(); await dom.click('[data-common-select="prompt:review"]')
    expect(dom.container.querySelector<HTMLTextAreaElement>('[data-prompt-editor="review"] textarea')!.value).toBe(text)
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })

  it('opens exact original instructions in Prompts while Goals keeps the directory and both pages retain drafts', async () => {
    await mount(); await manage(); await reference()
    const directory = await openDirectory()
    await dom.click('[data-common-select="prompt:review"]')
    const editor = body()
    expect(dom.container.querySelector('[data-settings-page]')!.getAttribute('data-settings-page')).toBe('prompts')
    expect(directory.closest<HTMLElement>('[data-settings-pane]')!.hidden).toBe(true)
    expect(editor.closest('[data-prompt-editor]')!.getAttribute('data-prompt-editor')).toBe('review')
    await fill('One retained original body draft')
    await openDirectory(); await dom.click('[data-common-select="prompt:review"]')
    expect(body()).toBe(editor); expect(body().value).toBe('One retained original body draft')
    await openDirectory(); await click('Add common action')
    const added = dom.container.querySelector<HTMLElement>('[data-prompt-editor]')!.dataset.promptEditor!
    expect(directory.querySelector(`[data-common-ref="prompt:${added}"]`)).not.toBeNull()
    await dom.click('[data-prompt-id="review"]')
    expect(body().value).toBe('One retained original body draft')
    expect(api.config.configureGoalsCommonActions).toHaveBeenCalledTimes(1)
    expect(openTopic).not.toHaveBeenCalled(); expect(createTopic).not.toHaveBeenCalled()
  })

  it('keeps an explicit common-action name even when it equals the former generated placeholder', async () => {
    await mount(); await manage(); await click('Add common action'); await fill('Body that could otherwise generate a name')
    const name = dom.container.querySelector<HTMLInputElement>('[data-prompt-editor] .prompt-editor__name input')!
    const typeName = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, value)
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await typeName('Explicit intermediate name'); await typeName('新操作'); await save()
    const added = (await f.disk()).composerShortcuts!.find(prompt => !prompts.some(original => original.id === prompt.id))!
    expect(added.label).toBe('新操作')
    expect(added.body).toBe('Body that could otherwise generate a name')
    expect((await f.disk()).goalsCommonActions!.items.at(-1)).toEqual({ kind: 'prompt', id: added.id })
    expect(openTopic).not.toHaveBeenCalled()
  })

  it('retains a name authored after automatic metadata submission even when it equals the old placeholder', async () => {
    await mount(); await manage(); await click('Add common action'); await fill('Original helper body')
    const id = dom.container.querySelector<HTMLElement>('[data-prompt-editor]')!.dataset.promptEditor!
    const pending = deferred<void>(), published = deferred<void>(), original = vi.mocked(api.config.save).getMockImplementation()!
    vi.mocked(api.config.save).mockImplementationOnce(async (next, expected) => { const result = await original(next, expected); published.resolve(); await pending.promise; return result })
    await dom.click('[data-settings-pane="prompts"] [data-settings-save-bar] button')
    await act(async () => { await published.promise })
    const name = dom.container.querySelector<HTMLInputElement>('[data-prompt-editor] .prompt-editor__name input')!
    expect(name.value).toBe('Original helper body')
    for (const value of ['A later explicit name', '新操作']) await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, value)
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => pending.resolve()); await settled()
    expect(name.value).toBe('新操作')
    expect((await f.disk()).composerShortcuts!.find(prompt => prompt.id === id)!.label).toBe('Original helper body')
    expect(dom.container.querySelector('[data-settings-save-bar]')!.textContent).toContain('Unsaved changes')
    await save()
    expect((await f.disk()).composerShortcuts!.find(prompt => prompt.id === id)!.label).toBe('新操作')
    expect((await f.disk()).composerShortcuts!.filter(prompt => prompt.id === id)).toHaveLength(1)
    expect((await f.disk()).goalsCommonActions!.items.filter(ref => ref.kind === 'prompt' && ref.id === id)).toHaveLength(1)
    expect(openTopic).not.toHaveBeenCalled()
  })

  it('keeps the current exact Project note and original primary bot frozen while navigating Settings during a request', async () => {
    const path = _hygiene_fixturePath('repo/migration-project')
    await external({ workspaces: [scratch, { id: 'migration-project', hostId: 'local', name: 'Migration Project', path, kind: 'folder' }] })
    const original = primaryClaude(); useAppStore.setState({ activeWorkspaceId: 'migration-project' })
    const request = deferred<string>(); openTopic.mockReturnValueOnce(request.promise)
    await mount()
    const next = action('builtin:next')!
    expect(next.querySelector('.goals-entry__request')!.textContent).toBe('根据当前项目的情况，建议我下一步应该做什么')
    expect(next.textContent).toContain('Migration Project'); expect(next.textContent).toContain('Other Claude')
    await act(async () => next.click()); await manage()
    expect(openTopic).toHaveBeenCalledExactlyOnceWith(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, {
      newTab: true, reveal: false, initialRequest: { prompt: '根据当前项目的情况，建议我下一步应该做什么', executorId: 'otherClaude',
        agentMuxNote: `Project: Migration Project\nProject ID: ${JSON.stringify(['local', path])}\nHost: local\nRepository root: ${path}\nWorkspace ID: migration-project\nWorkspace path: ${path}\nThese are the project paths for this request. The PMO working directory is separate; do not substitute it or assume a host home.` }
    })
    expect(useAppStore.getState().sessions[0]!.control).toEqual(original.control)
    await act(async () => request.resolve('original-request-tab')); await closeSettings()
    expect(openTopic).toHaveBeenCalledTimes(1); expect(createTopic).not.toHaveBeenCalled()
  })

  it('retains the same one-body Settings draft across section navigation and close, and cancels only explicitly', async () => {
    const navigate = await mount(); await manage(); await click('Add common action'); await fill('尚未保存的点子')
    const draftId = dom.container.querySelector<HTMLElement>('[data-prompt-editor]')!.dataset.promptEditor!, editor = body()
    await closeSettings(); await manage()
    expect(body()).toBe(editor); expect(editor.value).toBe('尚未保存的点子')
    await dom.click('[data-settings-target="goals"]')
    await dom.click('[data-settings-target="prompts"]')
    expect(body()).toBe(editor); expect(editor.value).toBe('尚未保存的点子')
    expect(navigate).toHaveBeenCalledWith('goals', undefined, 'goals-common-actions')
    await dom.click('.prompt-editor__remove button')
    expect(dom.container.querySelector(`[data-prompt-id="${draftId}"]`)).toBeNull()
    expect(dom.container.querySelector(`[data-common-ref="prompt:${draftId}"]`)).toBeNull()
    expect(dom.container.querySelector<HTMLButtonElement>('[data-settings-pane="prompts"] [data-settings-save-bar] button')!.disabled).toBe(true)
    expect((await f.disk()).composerShortcuts).toEqual(prompts)
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })

  it('removes only a saved common reference while the original authored library object remains available', async () => {
    await mount(); await manage(); await reference()
    await dom.click('[aria-label="Remove from Goals 检查改动"]'); await save()
    expect((await f.disk()).composerShortcuts).toEqual(prompts)
    expect((await f.disk()).goalsCommonActions!.items.some(ref => ref.kind === 'prompt' && ref.id === 'review')).toBe(false)
    await dom.click('nav [data-settings-target="prompts"]')
    expect(dom.container.querySelector('[data-prompt-id="review"]')).not.toBeNull()
    await closeSettings(); expect(action('prompt:review')).toBeNull()
    expect(openTopic).not.toHaveBeenCalled(); expect(createTopic).not.toHaveBeenCalled()
  })

  it('keeps a failed or conflicted body draft and the original expectation without creating a half-saved reference', async () => {
    await mount(); await manage(); await click('Add common action'); await fill('一个新的真实指令')
    f.save.mockRejectedValueOnce(new Error('disk unavailable'))
    await save()
    expect(body().value).toBe('一个新的真实指令')
    expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('disk unavailable')
    expect((await f.disk()).goalsCommonActions).toBeUndefined()
    expect((await f.disk()).composerShortcuts).toEqual(prompts)
    await save(); await closeSettings(); await manage(); await reference('整理笔记')
    await dom.click('[data-common-select="prompt:notes"]'); await fill('我的正文')
    await external({ composerShortcuts: f.owner.current.composerShortcuts!.map(prompt => prompt.id === 'notes' ? { ...prompt, body: '他人的正文' } : prompt) })
    await save()
    expect(body().value, 'Conflict keeps the editable authored body').toBe('我的正文')
    expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('composerShortcuts.notes.body')
    expect((await f.disk()).composerShortcuts!.find(prompt => prompt.id === 'notes')!.body).toBe('他人的正文')
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })

  it('retains the unconfirmed original primary Provider operation for management without silently launching another Agent', async () => {
    const original = primaryClaude()
    await mount(); await manage(); await reference(); await closeSettings()
    await external({ executors: { codex: composerConfig.executors.codex! } })
    expect(action('prompt:review')!.disabled).toBe(true)
    expect(action('prompt:review')!.textContent).toContain('主 Mote 的 Agent 尚未确认，请先选择适用 claude 的 Agent。')
    await act(async () => action('prompt:review')!.click()); await manage(); await dom.click('[data-common-select="prompt:review"]')
    expect(body().value).toBe(prompts[0]!.body)
    expect(useAppStore.getState().sessions[0]!.control).toEqual(original.control)
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })

  it('leaves a deleted library reference non-executable and removes it without reviving a second body', async () => {
    await mount(); await manage(); await reference(); await closeSettings()
    await external({ composerShortcuts: [prompts[1]!] })
    expect(action('prompt:review')!.disabled).toBe(true)
    expect(action('prompt:review')!.textContent).toContain('原指令已从指令库删除')
    await manage(); await dom.click('[aria-label="Remove from Goals 指令已删除"]'); await save()
    expect((await f.disk()).goalsCommonActions!.items).toEqual([{ kind: 'builtin', id: 'understand' }, { kind: 'builtin', id: 'ideas' }, { kind: 'builtin', id: 'next' }])
    expect((await f.disk()).composerShortcuts).toEqual([prompts[1]])
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })

  it('preserves an explicitly empty directory across readback and carry-over, and can restore a removed default', async () => {
    await external({ goalsCommonActions: { items: [], collapsed: false } })
    await mount()
    expect([...dom.container.querySelectorAll('[data-common-action]')]).toEqual([])
    expect(dom.container.querySelector('.goals-common__empty')!.textContent).toContain('Configure in Settings')
    const saved = await f.disk()
    expect(authoredConfigCarryOver(saved).goalsCommonActions).toEqual({ items: [], collapsed: false })
    await manage(); await reference('尝试一个项目'); await closeSettings()
    expect([...dom.container.querySelectorAll('[data-common-action]')].map(node => (node as HTMLElement).dataset.commonAction)).toEqual(['builtin:ideas'])
    expect((await f.disk()).composerShortcuts).toEqual(prompts)
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })

  it('persists reorder/removal/collapse and returns keyboard focus to the same or adjacent stable reference', async () => {
    await mount(); await manage()
    await dom.click('[aria-label="Move down 了解我并给我建议"]'); await save()
    expect((await f.disk()).goalsCommonActions!.items).toEqual([{ kind: 'builtin', id: 'ideas' }, { kind: 'builtin', id: 'understand' }, { kind: 'builtin', id: 'next' }])
    expect((document.activeElement as HTMLElement).dataset.commonSelect).toBe('builtin:understand')
    await dom.click('[aria-label="Remove from Goals 了解我并给我建议"]'); await save()
    expect((document.activeElement as HTMLElement).dataset.commonSelect).toBe('builtin:next')
    await closeSettings(); await dom.click('[aria-label="Collapse common actions"]'); await settled()
    expect((await f.disk()).goalsCommonActions!.collapsed).toBe(true)
    expect(dom.container.querySelector('.goals-common__hero')).toBeNull()
    expect(dom.container.querySelector('.goals-collection')).not.toBeNull()
    await dom.click('[aria-label="Expand common actions"]'); await settled()
    expect((await f.disk()).goalsCommonActions!.collapsed).toBe(false)
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })

  it('retains the original unknown save and a later body edit through a delayed acknowledgement', async () => {
    await mount(); await manage(); await click('Add common action'); await fill('First original request')
    const id = dom.container.querySelector<HTMLElement>('[data-prompt-editor]')!.dataset.promptEditor!
    const pending = deferred<void>(), published = deferred<void>(), original = vi.mocked(api.config.save).getMockImplementation()!
    vi.mocked(api.config.save).mockImplementationOnce(async (next, expected) => { const result = await original(next, expected); published.resolve(); await pending.promise; return result })
    await dom.click('[data-settings-pane="prompts"] [data-settings-save-bar] button')
    await act(async () => { await published.promise })
    await fill('Later exact body\n  still unsaved  ')
    await closeSettings(); await manage()
    expect(body().value).toBe('Later exact body\n  still unsaved  ')
    await act(async () => pending.resolve()); await settled()
    expect(body().value).toBe('Later exact body\n  still unsaved  ')
    expect((await f.disk()).composerShortcuts!.find(prompt => prompt.id === id)!.body).toBe('First original request')
    expect(dom.container.querySelector('[data-settings-save-bar]')!.textContent).toContain('Unsaved changes')
    await save()
    expect((await f.disk()).composerShortcuts!.filter(prompt => prompt.id === id)).toHaveLength(1)
    expect((await f.disk()).goalsCommonActions!.items.filter(ref => ref.kind === 'prompt' && ref.id === id)).toHaveLength(1)
    expect((await f.disk()).composerShortcuts!.find(prompt => prompt.id === id)!.body).toBe('Later exact body\n  still unsaved  ')
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })

  it('keeps the original body and reference after a lost config acknowledgement without an automatic save or launch', async () => {
    await mount(); await manage(); await click('Add common action'); await fill('Original unknown receipt body')
    const id = dom.container.querySelector<HTMLElement>('[data-prompt-editor]')!.dataset.promptEditor!, original = vi.mocked(api.config.save).getMockImplementation()!
    vi.mocked(api.config.save).mockImplementationOnce(async (next, expected) => { await original(next, expected); throw Error('Original config acknowledgement lost') })
    await save(); await closeSettings(); await manage()
    expect(body().value).toBe('Original unknown receipt body')
    expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('Original config acknowledgement lost')
    expect(api.config.save).toHaveBeenCalledTimes(1)
    expect((await f.disk()).goalsCommonActions!.items.filter(ref => ref.kind === 'prompt' && ref.id === id)).toHaveLength(1)
    expect((await f.disk()).composerShortcuts!.filter(prompt => prompt.id === id)).toHaveLength(1)
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })
  it('saves only referenced live bodies from Goals while unrelated drafts and all pending deletions keep their original expectations', async () => {
    await external({ composerShortcuts: [...prompts, { id: 'extra', keyword: 'extra', label: 'Extra', body: 'Original extra' }],
      goalsCommonActions: { items: [{ kind: 'prompt', id: 'review' }, { kind: 'prompt', id: 'extra' }], collapsed: false } })
    await mount(); await manage(); await dom.click('[data-common-select="prompt:review"]'); await fill('Related original body edit')
    await dom.click('[data-prompt-id="notes"]'); await fill('Unrelated dirty body')
    await dom.click('[data-prompt-id="extra"]'); await dom.click('.prompt-editor__remove button')
    // This concurrent same-field change must still conflict when the unrelated draft is later saved.
    await external({ composerShortcuts: f.owner.current.composerShortcuts!.map(prompt => prompt.id === 'notes' ? { ...prompt, body: 'External notes' } : prompt) })
    await openDirectory()
    expect(dom.container.querySelector('.settings-goals-actions__save')!.textContent).toContain('all library deletions stay in Prompts')
    await save()
    expect((await f.disk()).composerShortcuts!.find(prompt => prompt.id === 'review')!.body).toBe('Related original body edit')
    expect((await f.disk()).composerShortcuts!.find(prompt => prompt.id === 'notes')!.body).toBe('External notes')
    expect((await f.disk()).composerShortcuts!.some(prompt => prompt.id === 'extra')).toBe(true)
    await dom.click('nav [data-settings-target="prompts"]')
    expect(dom.container.querySelector('[data-prompt-id="extra"]')).toBeNull()
    await dom.click('[data-prompt-id="notes"]'); expect(body().value).toBe('Unrelated dirty body')
    await save()
    expect(dom.container.querySelector('[data-settings-pane="prompts"] [role="alert"]')?.textContent).toContain('composerShortcuts.notes.body')
    expect((await f.disk()).composerShortcuts!.some(prompt => prompt.id === 'extra')).toBe(true)
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })

  it('atomically saves a new referenced prompt from Goals after cross-page editing while a later body survives its ACK', async () => {
    await mount(); await manage(); await click('Add common action')
    const id = dom.container.querySelector<HTMLElement>('[data-prompt-editor]')!.dataset.promptEditor!, editor = body()
    await fill('First scoped body'); await openDirectory()
    expect(dom.container.querySelector('[data-settings-pane="goals"]')!.textContent).toContain('Goals preferences saved')
    expect(dom.container.querySelector('[data-settings-pane="goals"]')!.textContent).not.toContain('All changes saved')
    const pending = deferred<void>(), published = deferred<void>(), original = vi.mocked(api.config.configureGoalsCommonActions).getMockImplementation()!
    vi.mocked(api.config.configureGoalsCommonActions).mockImplementationOnce(async input => { const result = await original(input); published.resolve(); await pending.promise; return result })
    await click('Save common actions'); await act(async () => published.promise)
    expect((await f.disk()).goalsCommonActions?.items.at(-1)).toEqual({ kind: 'prompt', id })
    expect((await f.disk()).composerShortcuts!.find(prompt => prompt.id === id)!.body).toBe('First scoped body')
    await dom.click('nav [data-settings-target="prompts"]'); expect(body()).toBe(editor)
    await fill('Later scoped body'); await closeSettings(); await manage()
    await act(async () => pending.resolve()); await settled()
    await dom.click('[data-common-select="prompt:' + id + '"]')
    expect(body()).toBe(editor); expect(body().value).toBe('Later scoped body')
    await openDirectory(); await save()
    expect((await f.disk()).composerShortcuts!.filter(prompt => prompt.id === id)).toHaveLength(1)
    expect((await f.disk()).composerShortcuts!.find(prompt => prompt.id === id)!.body).toBe('Later scoped body')
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })

  it('activates the shared owner lazily without remounting another visited Settings draft', async () => {
    await dom.render(<SettingsPanel initialSection="space" onClose={() => {}} />)
    const dense = dom.container.querySelector<HTMLInputElement>('input[name="space-rail-density"][value="dense"]')!
    expect(dom.container.querySelector('[data-prompt-editor]')).toBeNull()
    await act(async () => dense.click())
    const space = dense.closest<HTMLElement>('[data-settings-pane]')!
    await dom.click('nav [data-settings-target="goals"]')
    await dom.click('[data-common-create]'); await fill('Kept across shared owner navigation')
    const editor = body()
    await dom.click('nav [data-settings-target="space"]')
    expect(dom.container.querySelector('input[name="space-rail-density"][value="dense"]')).toBe(dense)
    expect(dense.checked).toBe(true); expect(space.textContent).toContain('Unsaved changes')
    await dom.click('nav [data-settings-target="prompts"]')
    expect(body()).toBe(editor); expect(editor.value).toBe('Kept across shared owner navigation')
    expect(api.config.save).not.toHaveBeenCalled()
  })

  it('discovers common-action search only in its Goals owner and navigates to the actual directory', async () => {
    await dom.render(<SettingsPanel onClose={() => {}} />)
    const search = dom.container.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'common actions'); search.dispatchEvent(new Event('input', { bubbles: true })) })
    const target = dom.container.querySelector<HTMLButtonElement>('[data-settings-search-target="goals:goals-common-actions"]')
    const matches = [...dom.container.querySelectorAll<HTMLButtonElement>('.settings-search-results button')].filter(button => button.textContent?.includes('Goals common actions'))
    expect(matches).toHaveLength(1)
    await act(async () => (target ?? matches[0])!.click())
    expect(dom.container.querySelector('[data-settings-page]')!.getAttribute('data-settings-page')).toBe('goals')
    expect(dom.container.querySelector<HTMLDetailsElement>('[data-settings-field="goals-common-actions"]')!.open).toBe(true)
    expect(api.config.save).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })

  it.each(['use-saved', 'keep-mine'] as const)('resolves only the Goals save scope with %s while unrelated authored expectations still conflict', async choice => {
    await external({ goalsCommonActions: { items: [{ kind: 'prompt', id: 'review' }], collapsed: false } })
    await mount(); await manage(); await dom.click('[data-common-select="prompt:review"]'); await fill('My related body')
    await dom.click('[data-prompt-id="notes"]'); await fill('My unrelated body')
    await external({ composerShortcuts: prompts.map(prompt => ({ ...prompt, body: prompt.id === 'review' ? 'External related body' : 'External unrelated body' })) })
    await openDirectory(); await save()
    expect(dom.container.querySelector('[data-settings-pane="goals"] [role="alert"]')?.textContent).toContain('composerShortcuts.review.body')
    await dom.click('[data-settings-pane="goals"] [data-settings-conflict-action="' + choice + '"]')
    if (choice === 'keep-mine') await save()
    await dom.click('[data-common-select="prompt:review"]')
    expect(body().value).toBe(choice === 'use-saved' ? 'External related body' : 'My related body')
    await dom.click('[data-prompt-id="notes"]'); expect(body().value).toBe('My unrelated body')
    await save()
    expect(dom.container.querySelector('[data-settings-pane="prompts"] [role="alert"]')?.textContent).toContain('composerShortcuts.notes.body')
    expect((await f.disk()).composerShortcuts!.find(prompt => prompt.id === 'notes')!.body).toBe('External unrelated body')
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })

})
