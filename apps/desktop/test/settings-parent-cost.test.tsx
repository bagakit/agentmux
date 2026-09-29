// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SettingsSectionId } from '../src/renderer/src/components/SettingsPanel'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
const workSurface = vi.hoisted(() => ({ navigation: null as { open(section: SettingsSectionId, executorId?: string): void } | null }))
// Preserve the intake's same three external leaf boundaries. This leaf reads the
// actual App-owned public context; it does not replace App, Panel or their route.
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', async () => {
  const { useContext } = await import('react')
  const { SettingsNavigation } = await import('../src/renderer/src/components/SettingsNavigation')
  return { WorkspaceWorkbench: () => { workSurface.navigation = useContext(SettingsNavigation); return null } }
})
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))

import { App } from '../src/renderer/src/App'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { observations, report } from '../scripts/fixtures/settings-parent-cost/observations'

let initial: ReturnType<typeof useAppStore.getState>, url: string
let container: HTMLDivElement, root: Root, configFixture: Awaited<ReturnType<typeof configOwnerFixture>>
let observation: ReturnType<typeof observations>
let unsubscribe = () => {}
const shortcuts = [
  { id: 'one', keyword: 'one', label: 'One', body: 'First instruction.\nSecond paragraph.' },
  { id: 'two', keyword: 'two', label: 'Two', body: 'Review the changes carefully.' }
]

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  initial = useAppStore.getState(); url = window.location.href
  window.history.replaceState(null, '', '?agentmux-file-editing-report=1')
  workSurface.navigation = null; observation = observations()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  configFixture = await configOwnerFixture({ ...composerConfig,
    hosts: [composerConfig.hosts[0]!, ...Array.from({ length: 7 }, (_, i) => ({
      id: `configured-${i}`, kind: 'ssh' as const, label: `Configured ${i}`, hostname: `configured-${i}.invalid`
    }))],
    executors: { codex: composerConfig.executors.codex!, review: { ...composerConfig.executors.codex!, label: 'Reviewer' } },
    workspaces: ['primary', 'alternate'].map(id => ({ id, name: id, path: `/fixture/${id}`, hostId: 'local', kind: 'folder' as const })),
    composerShortcuts: shortcuts
  })
  const publish = configFixture.publish.getMockImplementation()!
  configFixture.publish.mockImplementation(saved => { publish(saved); useAppStore.setState({ config: saved }) })
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => configFixture.owner.edit(expected!, next))
  const sessions = Array.from({ length: 128 }, (_, i) => {
    const value = composerSession(`unrelated-${i}`)
    return { ...value, hostId: 'off-scope-host', control: { ...value.control, hostId: 'off-scope-host' } }
  })
  useAppStore.setState({ ...initial, config: configFixture.owner.current, loading: false,
    initialize: async () => () => {}, detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}),
    activeWorkspaceId: 'primary', mainSurface: 'workbench', toolsOpen: false,
    sessions, hostChecks: {}, error: null, tabs: {}, layouts: {},
    agentComposerDrafts: { 'unrelated-0': 'Keep my working draft' }, providerCatalog: await api.providers.list() }, true)
})
afterEach(async () => {
  unsubscribe(); unsubscribe = () => {}
  await act(async () => root.unmount()); container.remove()
  window.history.replaceState(null, '', url); useAppStore.setState(initial, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

function connected<T extends HTMLElement = HTMLElement>(selector: string, scope: ParentNode = container): T {
  const node = scope.querySelector<T>(selector)
  expect(node, `非空原产品节点 ${selector}`).not.toBeNull()
  expect(node!.isConnected).toBe(true)
  return node!
}
async function click(selector: string, scope: ParentNode = container) {
  const node = connected<HTMLButtonElement>(selector, scope)
  await act(async () => node.click())
}
async function fill(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function mount() {
  await act(async () => root.render(<App />))
  await click('.window-status-bar [aria-label="Settings"]')
  expect(connected('.settings-page').dataset.settingsPage).toBe('overview')
}
async function section(id: SettingsSectionId) { await click(`[data-settings-target="${id}"]`) }
function hostField(card: ParentNode, name: string): HTMLInputElement {
  const labels = [...card.querySelectorAll<HTMLLabelElement>('label')]
  expect(labels.length).toBeGreaterThan(0)
  const label = labels.find(node => node.querySelector('span')?.textContent === name)
  expect(label, `原 Host 字段 ${name}`).toBeDefined()
  return connected<HTMLInputElement>('input', label!)
}
async function publicRoute(section: SettingsSectionId, executorId?: string) {
  expect(workSurface.navigation, '实际 App Provider 公开 SettingsNavigation 非空').not.toBeNull()
  await act(async () => workSurface.navigation!.open(section, executorId))
}
function sameWorkingFacts(before: ReturnType<typeof useAppStore.getState>) {
  const current = useAppStore.getState()
  expect(current.sessions).toBe(before.sessions)
  expect(current.sessions).toHaveLength(128)
  expect(current.sessions[0]!.control).toEqual(before.sessions[0]!.control)
  expect(current.tabs).toBe(before.tabs); expect(current.layouts).toBe(before.layouts)
  expect(current.agentComposerDrafts).toBe(before.agentComposerDrafts)
}

it('actual App parent cost stays zero with nonempty stable original JSX callback samples', async () => {
  let summary: ReturnType<typeof observation.summary> | undefined, passed = false
  try {
    await mount(); await section('hosts')
    const pane = connected('[data-settings-pane="hosts"]'), cards = pane.querySelectorAll<HTMLElement>('.host-settings-card')
    expect(cards).toHaveLength(8)
    const input = hostField(cards[1]!, 'Label')
    await fill(input, 'Actual App draft retained'); await section('general')
    expect(pane.hidden).toBe(true); observation.proveCollected()
    const facts = useAppStore.getState(), config = facts.config
    expect(config!.workspaces).toHaveLength(2); expect(facts.sessions).toHaveLength(128)
    unsubscribe = useAppStore.subscribe(observation.notify)
    observation.setWindow('six-actual-app-workspace-updates')
    for (let i = 0; i < 6; i++) await act(async () => useAppStore.setState({ activeWorkspaceId: i % 2 === 0 ? 'alternate' : 'primary' }))
    summary = observation.summary('six-actual-app-workspace-updates')
    expect(summary.notifications, '六次真实 Store 通知').toBeGreaterThanOrEqual(6)
    expect(summary.appRenders, '原 App 确实更新').toBeGreaterThanOrEqual(6)
    expect(summary.onCloseIdentities.length, '原 JSX 回调引用样本非空且至少六个').toBeGreaterThanOrEqual(6)
    expect(summary.surfaceCloseIdentities.length, '原 SurfaceSwitch 回调样本非空').toBeGreaterThanOrEqual(6)
    expect(new Set(summary.onCloseIdentities).size, '实际 JSX close callback 唯一稳定身份').toBe(1)
    expect(new Set([...summary.onCloseIdentities, ...summary.surfaceCloseIdentities]).size).toBe(1)
    expect(summary.settingsRenders, '无关 App parent 不渲染原 Settings owner').toBe(0)
    expect(summary.hostRenders, '本 parent 路径的隐藏 Host owner 工作为零').toBe(0)
    expect(summary.hostFieldRenders, '本 parent 路径的隐藏 Host 字段工作为零').toBe(0)
    expect(summary.hostSessionPredicateVisits).toBe(0)
    // A descendant Profiler callback is kept separately; it never substitutes for owner invocation.
    expect(summary.settingsSubtreeCommits).toBe(0)
    expect(useAppStore.getState().config).toBe(config); sameWorkingFacts(facts)
    expect(connected('.settings-page').dataset.settingsPage).toBe('general')
    expect(pane.hidden).toBe(true); expect(hostField(cards[1]!, 'Label')).toBe(input)
    expect(input.value).toBe('Actual App draft retained'); expect(api.config.save).not.toHaveBeenCalled()
    passed = true
  } finally { report('parent-cost', { passed, summary, rawEvents: observation.events }) }
})

it('actual App public SettingsNavigation changes section and exact same-section Executor props', async () => {
  let passed = false
  try {
    await mount(); await section('general')
    const shell = connected('.settings-page'), facts = useAppStore.getState()
    const search = connected<HTMLInputElement>('[aria-label="Search settings"]')
    await fill(search, 'tmux'); expect(search.value).toBe('tmux')
    await publicRoute('agents', 'codex')
    expect(useAppStore.getState().config).toBe(facts.config); sameWorkingFacts(facts)
    expect(shell.dataset.settingsPage, 'App public route 的 initialSection 必须进入原 Panel').toBe('agents')
    expect(connected('.settings-page')).toBe(shell); expect(search.value).toBe('')
    const first = connected<HTMLDetailsElement>('#executor-settings-codex')
    expect(first.open).toBe(true); expect(first.closest('[hidden], [inert]')).toBeNull()
    expect(document.activeElement).toBe(connected('input[data-executor-name]', first))
    await publicRoute('agents', 'review')
    expect(useAppStore.getState().config).toBe(facts.config); sameWorkingFacts(facts)
    const second = connected<HTMLDetailsElement>('#executor-settings-review')
    expect(second.open, 'App public same-section executorId 必须进入另一真实配置对象').toBe(true)
    expect(second.closest('[hidden], [inert]')).toBeNull()
    expect(document.activeElement).toBe(connected('input[data-executor-name]', second))
    expect(connected('#executor-settings-codex')).toBe(first)
    expect(connected('.settings-page')).toBe(shell)
    passed = true
  } finally { report('public-route', { passed, rawEvents: observation.events, configAndSessionIdentityUnchanged: passed }) }
})

it('actual App hidden config publication preserves dirty authored field, clean refresh and expected Save', async () => {
  let passed = false
  try {
    const previous = configFixture.owner.current
    await act(async () => configFixture.owner.edit(previous, { ...previous,
      hosts: previous.hosts.map(host => host.kind === 'ssh' ? { ...host, hostname: `${host.id}.invalid` } : host) }))
    await mount(); await section('hosts')
    const pane = connected('[data-settings-pane="hosts"]'), cards = pane.querySelectorAll<HTMLElement>('.host-settings-card')
    expect(cards).toHaveLength(8)
    const dirty = hostField(cards[1]!, 'Label'), clean = hostField(cards[1]!, 'Hostname'), neighbor = hostField(cards[2]!, 'Label')
    await fill(dirty, 'Authored dirty label'); await section('general')
    const before = configFixture.owner.current
    await act(async () => configFixture.owner.edit(before, { ...before, hosts: before.hosts.map(host => host.id === 'configured-0'
      ? { ...host, hostname: 'published.invalid' } : host.id === 'configured-1' ? { ...host, label: 'Published neighbor' } : host) }))
    expect(pane.hidden).toBe(true); expect(dirty.isConnected).toBe(true)
    expect(dirty.value).toBe('Authored dirty label'); expect(clean.value).toBe('published.invalid')
    expect(neighbor.value).toBe('Published neighbor')
    await section('hosts'); expect(hostField(cards[1]!, 'Label')).toBe(dirty)
    await click('.settings-pane-actions button', pane)
    expect(api.config.save).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.mocked(api.config.save).mock.results[0]!.value })
    const [submitted, expected] = vi.mocked(api.config.save).mock.calls[0]!
    expect(expected!.hosts[1]).toMatchObject({ label: 'Configured 0', hostname: 'published.invalid' })
    expect(expected!.hosts[2]).toMatchObject({ label: 'Published neighbor' })
    expect(submitted.hosts[1]).toMatchObject({ label: 'Authored dirty label', hostname: 'published.invalid' })
    expect((await configFixture.disk()).hosts[1]).toMatchObject({ label: 'Authored dirty label', hostname: 'published.invalid' })
    expect(hostField(cards[1]!, 'Label')).toBe(dirty)
    passed = true
  } finally { report('config-publication', { passed, rawEvents: observation.events }) }
})

it('actual App preserves visited Prompt editor selection, IME, close action and original working surface', async () => {
  let passed = false
  try {
    await mount(); await section('prompts')
    const shell = connected('.settings-page'), workspace = connected('.app-shell__workspace'), facts = useAppStore.getState()
    const editor = connected<HTMLTextAreaElement>('[data-prompt-editor] textarea')
    for (const value of ['中', '中文', '中文组字\nexact draft']) await fill(editor, value)
    await act(async () => { editor.focus(); editor.setSelectionRange(2, 4)
      editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中文' }))
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }))
    })
    expect(connected('.settings-page')).toBe(shell); expect(document.activeElement).toBe(editor)
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 4])
    await act(async () => editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })))
    await act(async () => useAppStore.setState({ activeWorkspaceId: 'alternate' }))
    await section('general'); await publicRoute('prompts')
    expect(connected<HTMLTextAreaElement>('[data-prompt-editor] textarea')).toBe(editor)
    expect(editor.value).toBe('中文组字\nexact draft')
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 4])
    expect(connected('.settings-page').dataset.settingsPage).toBe('prompts')
    expect(api.config.save).not.toHaveBeenCalled(); sameWorkingFacts(facts)
    await click('[aria-label="Close settings"]')
    expect(container.querySelector('.settings-page')).toBeNull()
    expect(connected('.app-shell__workspace')).toBe(workspace); expect(workspace.inert).toBe(false)
    expect(useAppStore.getState().activeWorkspaceId).toBe('alternate'); sameWorkingFacts(facts)
    await click('.window-status-bar [aria-label="Settings"]')
    expect(connected('.settings-page').dataset.settingsPage).toBe('overview')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(container.querySelector('.settings-page')).toBeNull(); sameWorkingFacts(facts)
    passed = true
  } finally { report('prompt-and-close', { passed, rawEvents: observation.events }) }
})
