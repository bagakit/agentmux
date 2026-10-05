import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { createWorkspaceLayout } from '@agentmux/layout'
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("tmp") } }))
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { ShortcutSettingsPane } from '../src/renderer/src/components/settings/ShortcutSettingsPane'
import { api } from '../src/renderer/src/lib/api'
import { EMPTY_AGENT_FOCUS } from '../src/renderer/src/lib/agent-focus'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { resolveComposerShortcuts } from '../src/shared/composer-shortcut-library'
import { authoredConfigCarryOver } from '../src/main/config-store'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'

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
})
async function mount(open = vi.fn()) { await dom.render(<SettingsNavigation.Provider value={{ open }}><GlobalBoardSurface /></SettingsNavigation.Provider>); return open }
function button(text: string) {
  const buttons = [...dom.container.querySelectorAll<HTMLButtonElement>('button')]
  const found = buttons.find(button => button.textContent === text)
  expect(found, `Actual product button ${text}`).not.toBeUndefined()
  return found!
}
async function click(text: string) { await act(async () => button(text).click()) }
const action = (key: string) => dom.container.querySelector<HTMLButtonElement>(`[data-common-action="${key}"]`)
const body = () => dom.container.querySelector<HTMLTextAreaElement>('[data-common-editor] textarea')!
async function fill(value: string) {
  const node = body(); expect(node).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function settled() {
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    if (dom.container.querySelector('.goals-common')?.getAttribute('aria-busy') !== 'true') return
  }
  throw new Error('Common action save did not settle')
}
async function manage() { await click('管理') }
async function reference(label = '检查改动') { await click('引用已有'); await act(async () => {
  const entry = [...dom.container.querySelectorAll<HTMLButtonElement>('.goals-common__available > button')].find(button => button.querySelector('span')?.textContent === label)
  expect(entry).not.toBeUndefined(); entry!.click()
}); await settled() }
async function save() { await click('保存操作'); await settled() }
async function external(patch: Partial<typeof f.owner.current>) {
  const current = f.owner.current
  await act(async () => { await f.owner.edit(current, { ...current, ...patch }) })
}

describe('Goals common actions through the mounted product and durable config owner', () => {
  it('orders, removes and discloses through distinct themeable meanings in the actual directory', async () => {
    await mount(); await manage()
    const up = dom.container.querySelector('[aria-label="上移 了解我并给我建议"]')!
    const down = dom.container.querySelector('[aria-label="下移 了解我并给我建议"]')!
    const remove = dom.container.querySelector('[aria-label="移出常用 了解我并给我建议"]')!
    expect(up.querySelector('svg')?.getAttribute('data-semantic-icon')).toBe('action.move-up')
    expect(down.querySelector('svg')?.getAttribute('data-semantic-icon')).toBe('action.move-down')
    expect(remove.querySelector('svg')?.getAttribute('data-semantic-icon')).toBe('action.remove')
    expect((up as HTMLButtonElement).disabled).toBe(true)
    expect((down as HTMLButtonElement).disabled).toBe(false)
    const collapse = dom.container.querySelector('[aria-label="收起常用操作"]')!
    expect(collapse.querySelector('svg')?.getAttribute('data-semantic-icon')).toBe('navigation.up')
    await dom.click('[aria-label="下移 了解我并给我建议"]'); await settled()
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
    expect(dom.container.querySelector('.goals-common__heading')!.textContent).toContain('常用操作')
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
    await mount(); await click('全部操作（4）')
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
    await mount(); await manage(); await reference(); await click('完成')
    const node = action('prompt:review')!
    expect(node.querySelector('.goals-entry__request')!.textContent, 'Live prompt body is the complete request').toBe(prompts[0]!.body)
    expect(node.querySelector('.goals-common__facts')!.textContent, 'The visible target comes from the actual primary Session and configured provider').toBe('主 Mote · Other Claude')
    expect(node.disabled).toBe(false)
    await act(async () => node.click())
    expect(openTopic, 'Visible body and the actual primary executor reach the original Mote owner').toHaveBeenCalledExactlyOnceWith(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { newTab: true, reveal: false, initialRequest: { prompt: prompts[0]!.body, executorId: 'otherClaude' } })
    expect(createTopic).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions[0]!.control).toEqual(original.control)
    expect((await f.disk()).composerShortcuts).toEqual(prompts)
  })

  it('creates one authored body and its reference atomically, generating helper fields and preserving foreign config', async () => {
    await mount(); await manage(); await click('新增操作')
    const text = '  帮我检查今天的笔记。\n指出一个值得尝试的方向。  '
    await fill(text)
    await external({ appearance: { terminalTheme: 'graphite', appAppearance: 'light' } })
    await save()
    const saved = await f.disk(), created = saved.composerShortcuts!.find(prompt => !prompts.some(original => original.id === prompt.id))!
    expect(created.body, 'One-body creation retains exact authored bytes').toBe(text)
    expect(created.label).toBe('帮我检查今天的笔记。')
    expect(created.keyword).toMatch(/^action-/)
    expect(new Set(saved.composerShortcuts!.map(prompt => prompt.keyword)).size).toBe(3)
    expect(saved.goalsCommonActions!.items.at(-1)).toEqual({ kind: 'prompt', id: created.id })
    expect(saved.appearance.appAppearance).toBe('light')
    expect(vi.mocked(api.config.save)).toHaveBeenCalledTimes(1)
    expect(createTopic, 'Management and save never start an Agent').not.toHaveBeenCalled()
    await click('完成')
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
    await dom.render(<ShortcutSettingsPane config={f.owner.current} onSave={vi.fn()} />)
    expect(dom.container.querySelector<HTMLTextAreaElement>('[data-prompt-editor="review"] textarea')!.value).toBe(text)
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })

  it('retains unsaved body when finishing or pressing Escape and only explicit cancel drops it', async () => {
    await mount(); await manage(); await click('新增操作'); await fill('尚未保存的点子')
    const draftId = dom.container.querySelector<HTMLElement>('[data-common-editor]')!.dataset.commonEditor!
    await click('返回目录')
    expect((document.activeElement as HTMLElement).dataset.commonSelect, 'Unsaved new operation returns focus to the same stable draft').toBe(`prompt:${draftId}`)
    await act(async () => dom.container.querySelector<HTMLButtonElement>('.goals-common__draft')!.click())
    await act(async () => body().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(dom.container.querySelector('[aria-label="管理常用操作"]')).toBeNull()
    await manage()
    await act(async () => dom.container.querySelector<HTMLButtonElement>('.goals-common__draft')!.click())
    expect(body().value).toBe('尚未保存的点子')
    await click('完成'); await manage(); await act(async () => dom.container.querySelector<HTMLButtonElement>('.goals-common__draft')!.click())
    expect(body().value).toBe('尚未保存的点子')
    await click('取消编辑')
    expect(dom.container.querySelector('.goals-common__draft')).toBeNull()
    expect((await f.disk()).composerShortcuts).toEqual(prompts)
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })

  it('keeps a failed or conflicted body draft and the original expectation without creating a half-saved reference', async () => {
    await mount(); await manage(); await click('新增操作'); await fill('一个新的真实指令')
    f.save.mockRejectedValueOnce(new Error('disk unavailable'))
    await save()
    expect(body().value).toBe('一个新的真实指令')
    expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('disk unavailable')
    expect((await f.disk()).goalsCommonActions).toBeUndefined()
    expect((await f.disk()).composerShortcuts).toEqual(prompts)
    await save(); await click('完成'); await manage(); await reference('整理笔记')
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
    await mount(); await manage(); await reference(); await click('完成')
    await external({ executors: { codex: composerConfig.executors.codex! } })
    expect(action('prompt:review')!.disabled).toBe(true)
    expect(action('prompt:review')!.textContent).toContain('主 Mote 的 Agent 尚未确认，请先选择适用 claude 的 Agent。')
    await act(async () => action('prompt:review')!.click()); await manage(); await dom.click('[data-common-select="prompt:review"]')
    expect(body().value).toBe(prompts[0]!.body)
    expect(useAppStore.getState().sessions[0]!.control).toEqual(original.control)
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })

  it('leaves a deleted library reference non-executable and removes it without reviving a second body', async () => {
    await mount(); await manage(); await reference(); await click('完成')
    await external({ composerShortcuts: [prompts[1]!] })
    expect(action('prompt:review')!.disabled).toBe(true)
    expect(action('prompt:review')!.textContent).toContain('原指令已从指令库删除')
    await manage(); await dom.click('[aria-label="移出常用 指令已删除"]'); await settled()
    expect((await f.disk()).goalsCommonActions!.items).toEqual([{ kind: 'builtin', id: 'understand' }, { kind: 'builtin', id: 'ideas' }, { kind: 'builtin', id: 'next' }])
    expect((await f.disk()).composerShortcuts).toEqual([prompts[1]])
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })

  it('preserves an explicitly empty directory across readback and carry-over, and can restore a removed default', async () => {
    await external({ goalsCommonActions: { items: [], collapsed: false } })
    await mount()
    expect([...dom.container.querySelectorAll('[data-common-action]')]).toEqual([])
    expect(dom.container.querySelector('.goals-common__empty')!.textContent).toContain('添加操作')
    const saved = await f.disk()
    expect(authoredConfigCarryOver(saved).goalsCommonActions).toEqual({ items: [], collapsed: false })
    await manage(); await reference('尝试一个项目'); await click('完成')
    expect([...dom.container.querySelectorAll('[data-common-action]')].map(node => (node as HTMLElement).dataset.commonAction)).toEqual(['builtin:ideas'])
    expect((await f.disk()).composerShortcuts).toEqual(prompts)
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })

  it('persists reorder/removal/collapse and returns keyboard focus to the same or adjacent stable reference', async () => {
    await mount(); await manage()
    await dom.click('[aria-label="下移 了解我并给我建议"]'); await settled()
    expect((await f.disk()).goalsCommonActions!.items).toEqual([{ kind: 'builtin', id: 'ideas' }, { kind: 'builtin', id: 'understand' }, { kind: 'builtin', id: 'next' }])
    expect((document.activeElement as HTMLElement).dataset.commonSelect).toBe('builtin:understand')
    await dom.click('[aria-label="移出常用 了解我并给我建议"]'); await settled()
    expect((document.activeElement as HTMLElement).dataset.commonSelect).toBe('builtin:next')
    await click('完成'); await dom.click('[aria-label="收起常用操作"]'); await settled()
    expect((await f.disk()).goalsCommonActions!.collapsed).toBe(true)
    expect(dom.container.querySelector('.goals-common__hero')).toBeNull()
    expect(dom.container.querySelector('.goals-collection')).not.toBeNull()
    await dom.click('[aria-label="展开常用操作"]'); await settled()
    expect((await f.disk()).goalsCommonActions!.collapsed).toBe(false)
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })

  it('requires the same explicit save/cancel path before leaving unsaved bodies for Settings', async () => {
    const open = await mount(); await manage(); await click('新增操作'); await fill('尚未提交')
    await click('在设置中管理指令库')
    expect(open).not.toHaveBeenCalled()
    expect(body().value).toBe('尚未提交')
    expect(dom.container.querySelector('[data-common-editor] [role="status"]')!.textContent).toContain('先保存或取消')
    await save()
    expect(open).toHaveBeenCalledExactlyOnceWith('prompts')
    expect((await f.disk()).composerShortcuts!.at(-1)!.body).toBe('尚未提交')
    expect(createTopic).not.toHaveBeenCalled(); expect(openTopic).not.toHaveBeenCalled()
  })
})
