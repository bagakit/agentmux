// @vitest-environment happy-dom
import { AgentSettingsPane } from '../src/renderer/src/components/settings/AgentSettingsPane'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { AppearanceSettingsPane } from '../src/renderer/src/components/settings/AppearanceSettingsPane'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { AgentAvatar, ExecutorIdentityContext } from '../src/renderer/src/components/AgentAvatar'
import { SelectorPresence } from '../src/renderer/src/components/SelectorList'
import { RegionMosaic } from '../src/renderer/src/components/TopicPresence'
import { WorkspaceTopicsPanel } from '../src/renderer/src/components/WorkspaceTopicsPanel'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/contracts'
import { BranchesPanel } from '../src/renderer/src/components/BranchesPanel'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { runningAgentPresenceByWorktree, worktreePresenceKey } from '../src/renderer/src/lib/branch-agent-presence'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const executors: typeof composerConfig.executors = { ...composerConfig.executors, review: { ...composerConfig.executors.codex!, label: 'Reviewer' } }
const appearances = { codex: { tint: '#ee7755', badge: 'spark' as const }, review: { tint: '#6688dd', badge: 'shield' as const } }
async function change(label: string, value: string) {
  const input = dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function chooseIcon(label: string, value: string) {
  const input = dom.container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!
  expect(input).not.toBeNull()
  await act(async () => {
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
function customizedExecutors() { return { codex: { ...executors.codex!, avatar: appearances.codex }, review: { ...executors.review!, avatar: appearances.review } } }
const badges = () => [...dom.container.querySelectorAll<HTMLElement>('[data-avatar-badge]')].map((node) => node.dataset.avatarBadge)

it('edits avatars in Executor templates and preserves both through save and reopen', async () => {
  let config = { ...composerConfig, executors }
  const save = vi.fn(async (saved: typeof config.executors) => { config = { ...config, executors: saved } })
  await dom.render(<AgentSettingsPane config={config} onSave={save} />)
  await change('Codex avatar tint', '#ee7755')
  await chooseIcon('Codex avatar icon', 'spark')
  await change('Reviewer avatar tint', '#6688dd')
  await chooseIcon('Reviewer avatar icon', 'shield')
  expect(badges()).toEqual(['spark', 'shield'])
  await dom.click('.settings-pane-actions button')
  expect(save).toHaveBeenCalledOnce()
  expect(config.executors.codex?.avatar).toEqual(appearances.codex)
  expect(config.executors.review?.avatar).toEqual(appearances.review)
  await dom.render(null)
  await dom.render(<AgentSettingsPane config={config} onSave={save} />)
  expect(badges()).toEqual(['spark', 'shield'])
  await dom.click('[aria-label="Reset Codex avatar"]')
  expect(badges()).toEqual(['shield'])
  await dom.click('.settings-pane-actions button')
  expect(config.executors.codex?.avatar).toBeUndefined()
  expect(config.executors.review?.avatar).toEqual(appearances.review)
})

it('shows legacy appearance in Executor settings and makes an explicit reset win', async () => {
  const legacy = { ...composerConfig, appearance: { ...composerConfig.appearance, agentAvatars: { codex: appearances.codex } } }
  let savedExecutors = legacy.executors
  const save = vi.fn(async (next: typeof legacy.executors) => { savedExecutors = next })
  await dom.render(<AgentSettingsPane config={legacy} onSave={save} />)
  expect(badges()).toEqual(['spark'])

  await dom.click('[aria-label="Reset Codex avatar"]')
  expect(badges()).toEqual([])
  await dom.click('.settings-pane-actions button')
  expect(save).toHaveBeenCalledOnce()
  expect(savedExecutors.codex?.avatar).toEqual({})
  expect(legacy.appearance.agentAvatars?.codex).toEqual(appearances.codex)
  const config = { ...legacy, executors: savedExecutors }
  await dom.render(null)
  await dom.render(<ExecutorIdentityContext.Provider value={{ config, sessions: [] }}>
    <AgentSettingsPane config={config} onSave={save} />
    <AgentAvatar executorId="codex" />
  </ExecutorIdentityContext.Provider>)
  expect(badges()).toEqual([])
  expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="Reset Codex avatar"]')?.disabled).toBe(true)
})

it('keeps failed Executor saves local without discarding unsaved avatar edits', async () => {
  await dom.render(<AgentSettingsPane config={{ ...composerConfig, executors }}
    onSave={async () => { throw new Error('Settings write failed') }} />)
  await chooseIcon('Reviewer avatar icon', 'bolt')
  await dom.click('.settings-pane-actions button')
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toBe('Settings write failed')
  expect(badges()).toEqual(['bolt'])
})

it('shows details on hover and focus, then routes the settings action to the matching Executor', async () => {
  const config = { ...composerConfig, executors: customizedExecutors() }
  const session = { ...composerSession(), executorId: 'review', status: { ...composerSession().status, detail: 'Stopped by user' } }
  useAppStore.setState({ config, sessions: [session] })
  const open = vi.fn()
  await dom.render(<ExecutorIdentityContext.Provider value={{ config, sessions: [session] }}><SettingsNavigation.Provider value={{ open }}><AgentSessionComposer sessionId="agent-1" /></SettingsNavigation.Provider></ExecutorIdentityContext.Provider>)
  expect(badges()).toEqual(['shield'])
  const identity = dom.container.querySelector<HTMLElement>('.composer-agent-identity .agent-avatar')!
  const mailbox = dom.container.querySelector<HTMLButtonElement>('.composer__mailbox')!
  expect(identity).not.toBeNull(); expect(mailbox).not.toBeNull()
  expect(identity.contains(mailbox)).toBe(false)
  expect(document.querySelector('.agent-identity-popover')).toBeNull()
  await act(async () => identity.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
  let panel = document.querySelector<HTMLDivElement>('.agent-identity-popover')!
  expect(panel.textContent).toContain('Reviewer · review')
  expect(panel.textContent).toContain('Stopped by user')
  expect(identity.getAttribute('aria-describedby')).toBe(panel.id)
  await act(async () => panel.querySelector<HTMLButtonElement>('button')!.click())
  expect(open).toHaveBeenCalledExactlyOnceWith('agents', 'review')
  expect(document.querySelector('.agent-identity-popover')).toBeNull()
  await act(async () => identity.focus())
  panel = document.querySelector<HTMLDivElement>('.agent-identity-popover')!
  expect(panel.textContent).toContain('Reviewer · review')
  await act(async () => window.dispatchEvent(new Event('resize')))
  expect(document.querySelector('.agent-identity-popover')).toBeNull()
  await act(async () => { identity.blur(); identity.focus() })
  expect(document.querySelector('.agent-identity-popover')).not.toBeNull()
  await act(async () => identity.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('.agent-identity-popover')).toBeNull()
})

it('holds one native-surface lease per visible avatar panel and releases it on close and unmount', async () => {
  useAppStore.setState({ nativeSurfaceOverlayCount: 0 })
  const browserStage = document.createElement('div')
  browserStage.dataset.nativeBrowserStage = ''
  browserStage.style.visibility = 'visible'
  browserStage.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800,
    toJSON: () => ({})
  })
  document.body.append(browserStage)
  const onPanelVisibilityChange = (visible: boolean) => {
    if (visible) useAppStore.getState().acquireNativeSurfaceOverlay()
    else useAppStore.getState().releaseNativeSurfaceOverlay()
  }
  await dom.render(<ExecutorIdentityContext.Provider value={{ config: null, sessions: [], onPanelVisibilityChange }}>
    <AgentAvatar label="Left Agent" providerId="codex" />
    <AgentAvatar label="Second Agent" providerId="claude" />
  </ExecutorIdentityContext.Provider>)
  const avatars = [...dom.container.querySelectorAll<HTMLElement>('.agent-avatar')]
  expect(avatars).toHaveLength(2)
  await act(async () => {
    avatars[0]!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    avatars[0]!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  })
  expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(1)
  await act(async () => avatars[1]!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
  expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(2)
  await act(async () => avatars[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(1)
  await dom.render(null)
  expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(0)
  browserStage.remove()
})

it('passes appearance and stack count through both shared presence paths', async () => {
  const agent = { key: 'a', providerId: 'codex', state: 'running' as const, label: 'Review', appearance: appearances.review, count: 3 }
  await dom.render(<><SelectorPresence agents={[agent]} /><RegionMosaic cells={[{ regionId: 'r', agentSessionId: 'a', bounds: { x: 0, y: 0, width: 1, height: 1 } }]} agents={[agent]} /></>)
  expect(badges()).toEqual(['shield', 'shield'])
  expect([...dom.container.querySelectorAll('.agent-avatar__count')].map((node) => node.textContent)).toEqual(['3', '3'])
  expect(dom.container.querySelectorAll('.agent-avatar__status')).toHaveLength(0)
  expect(dom.container.querySelectorAll('[data-agent-provider="codex"]')).toHaveLength(2)
})

it('groups Branch presence by executor and renders each executor customization', async () => {
  const a = composerSession('a'); const b = { ...composerSession('b'), executorId: 'review' }; const c = { ...b, id: 'c', status: { ...b.status, state: 'working' as const } }
  const grouped = runningAgentPresenceByWorktree([a, b, c]).get(worktreePresenceKey('local', '/repo'))!
  expect(grouped).toHaveLength(2)
  expect(grouped.map((item) => [item.executorId, item.count, item.state])).toEqual([['codex', 1, 'running'], ['review', 2, 'working']])
  const urgent = runningAgentPresenceByWorktree([{ ...b, status: { ...b.status, state: 'waiting' } }, c]).get(worktreePresenceKey('local', '/repo'))
  expect(urgent?.map((item) => item.state)).toEqual(['waiting'])

  useAppStore.setState({ config: { ...composerConfig, executors: customizedExecutors() }, sessions: [a, b, c] })
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'git-repository', hostId: 'local', repoPath: '/repo',
    branches: [{ name: 'main', worktreePath: '/repo', workspaceId: 'workspace', isCurrent: true }] })
  await dom.render(<BranchesPanel workspace={composerConfig.workspaces[0]!} />)
  await vi.waitFor(() => expect(badges()).toEqual(['spark', 'shield']))
  expect(dom.container.querySelector('.status--working .agent-avatar__count')?.textContent).toBe('2')
})

it('clickable avatars select once without opening the containing row', async () => {
  const open = vi.fn(); const row = vi.fn()
  await dom.render(<div onClick={row}><AgentAvatar label="Review" providerId="claude" state="waiting" appearance={appearances.review} onOpen={open} /></div>)
  expect(dom.container.querySelector('[data-agent-provider="claude"]')).not.toBeNull()
  await dom.click('button.agent-avatar')
  expect(open).toHaveBeenCalledOnce(); expect(row).not.toHaveBeenCalled()
  expect(dom.container.querySelector('.agent-avatar')?.getAttribute('data-attention')).toBe('needs-you')
})

it('Appearance has no avatar controls and the Executor deep link opens the matching template', async () => {
  useAppStore.setState({ config: { ...composerConfig, executors } })
  await dom.render(<AppearanceSettingsPane appearance={composerConfig.appearance} onSave={async () => {}} />)
  expect(dom.container.querySelectorAll('[aria-label$="avatar icon"]')).toHaveLength(0)
  await dom.render(<SettingsPanel initialSection="agents" executorId="review" onClose={() => {}} />)
  expect(dom.container.querySelector('[aria-label="Reviewer avatar icon"]')).not.toBeNull()
  expect(dom.container.querySelector<HTMLDetailsElement>('#executor-settings-review')?.open).toBe(true)
})

it('Topic presence reads the live Session executor rather than its Provider', async () => {
  const workspace = { ...composerConfig.workspaces[0]!, id: SCRATCH_WORKSPACE_ID, name: 'Scratch', path: '/scratch' }
  const path = '/scratch/topic--view--review'
  useAppStore.setState({ config: { ...composerConfig, executors: customizedExecutors(), workspaces: [workspace] },
    sessions: [{ ...composerSession(), executorId: 'review', workspacePath: path }] })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([{ id: 'view:review', directoryPath: path, topicPath: `${path}/topic.md`, title: 'Review', summary: '', collaborators: [] }])
  await dom.render(<WorkspaceTopicsPanel workspace={workspace} onRevealDirectory={() => {}} />)
  await vi.waitFor(() => expect(badges()).toEqual(['shield']))
})
