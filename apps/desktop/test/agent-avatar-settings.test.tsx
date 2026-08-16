// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { AppearanceSettingsPane } from '../src/renderer/src/components/settings/AppearanceSettingsPane'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar'
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
const executors = { ...composerConfig.executors, review: { ...composerConfig.executors.codex!, label: 'Reviewer' } }
const appearances = { codex: { tint: '#ee7755', badge: 'A' }, review: { tint: '#6688dd', badge: 'B' } }
async function change(label: string, value: string) {
  const input = dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const badges = () => [...dom.container.querySelectorAll('.agent-avatar__badge')].map((node) => node.textContent)

it('previews per-executor changes, saves both entries, and restores the saved appearance when reopened', async () => {
  const config = { ...composerConfig, executors }
  let restored = config
  const save = vi.fn(async (appearance: typeof config.appearance) => { restored = { ...config, appearance } })
  await dom.render(<AppearanceSettingsPane appearance={config.appearance} executors={executors} onSave={save} />)
  await change('Codex avatar tint', '#ee7755')
  await change('Codex avatar badge', 'A')
  await change('Reviewer avatar tint', '#6688dd')
  await change('Reviewer avatar badge', 'B')
  expect(badges()).toEqual(['A', 'B'])
  expect([...dom.container.querySelectorAll('feFlood')].map((node) => node.getAttribute('flood-color'))).toEqual(['#ee7755', '#6688dd'])
  await dom.click('.settings-pane-actions button')
  expect(save).toHaveBeenCalledOnce()
  expect(restored.appearance.agentAvatars).toEqual(appearances)
  await dom.render(null)
  await dom.render(<AppearanceSettingsPane appearance={restored.appearance} executors={restored.executors} onSave={save} />)
  expect(badges()).toEqual(['A', 'B'])
  await dom.click('[aria-label="Codex avatar tint"]')
  const reset = dom.container.querySelector<HTMLButtonElement>('[aria-label="Reset Codex avatar"]')!
  await act(async () => reset.click())
  expect(badges()).toEqual(['B'])
  await dom.click('.settings-pane-actions button')
  expect(restored.appearance.agentAvatars).toEqual({ review: appearances.review })
})

it('keeps save failures local without discarding unsaved avatar edits', async () => {
  await dom.render(<AppearanceSettingsPane appearance={composerConfig.appearance} executors={executors}
    onSave={async () => { throw new Error('Settings write failed') }} />)
  await change('Reviewer avatar badge', 'QA')
  await dom.click('.settings-pane-actions button')
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toBe('Settings write failed')
  expect(badges()).toEqual(['QA'])
})

it('projects executor identity through Session controls and keeps mailbox and identity as separate buttons', async () => {
  useAppStore.setState({ config: { ...composerConfig, executors, appearance: { ...composerConfig.appearance, agentAvatars: appearances } },
    sessions: [{ ...composerSession(), executorId: 'review' }] })
  const open = vi.fn()
  await dom.render(<SettingsNavigation.Provider value={{ open }}><AgentSessionComposer sessionId="agent-1" /></SettingsNavigation.Provider>)
  expect(badges()).toEqual(['B'])
  const identity = dom.container.querySelector<HTMLButtonElement>('.composer-agent-identity')!
  const mailbox = dom.container.querySelector<HTMLButtonElement>('.composer__mailbox')!
  expect(identity).not.toBeNull(); expect(mailbox).not.toBeNull()
  expect(identity.contains(mailbox)).toBe(false); expect(mailbox.contains(identity)).toBe(false)
  expect(identity.textContent).not.toContain('Reviewer')
  const panel = dom.container.querySelector<HTMLDivElement>('.agent-identity-popover')!
  expect(panel.textContent).toContain('Reviewer · review')
  expect(identity.getAttribute('popovertarget')).toBe(panel.id)
  panel.hidePopover = vi.fn()
  await dom.click('.agent-identity-popover button')
  expect(open).toHaveBeenCalledExactlyOnceWith('appearance')
})

it('passes appearance and stack count through both shared presence paths', async () => {
  const agent = { key: 'a', providerId: 'codex', state: 'running' as const, label: 'Review', appearance: appearances.review, count: 3 }
  await dom.render(<><SelectorPresence agents={[agent]} /><RegionMosaic cells={[{ regionId: 'r', agentSessionId: 'a', bounds: { x: 0, y: 0, width: 1, height: 1 } }]} agents={[agent]} /></>)
  expect(badges()).toEqual(['B', 'B'])
  expect([...dom.container.querySelectorAll('.agent-avatar__count')].map((node) => node.textContent)).toEqual(['3', '3'])
  expect(dom.container.querySelectorAll('.agent-avatar__status.status__dot')).toHaveLength(2)
  expect(dom.container.querySelectorAll('[data-agent-provider="codex"]')).toHaveLength(2)
})

it('groups Branch presence by executor and renders each executor customization', async () => {
  const a = composerSession('a'); const b = { ...composerSession('b'), executorId: 'review' }; const c = { ...b, id: 'c', status: { ...b.status, state: 'working' as const } }
  const grouped = runningAgentPresenceByWorktree([a, b, c]).get(worktreePresenceKey('local', '/repo'))!
  expect(grouped).toHaveLength(2)
  expect(grouped.map((item) => [item.executorId, item.count, item.state])).toEqual([['codex', 1, 'running'], ['review', 2, 'working']])
  const urgent = runningAgentPresenceByWorktree([{ ...b, status: { ...b.status, state: 'waiting' } }, c]).get(worktreePresenceKey('local', '/repo'))
  expect(urgent?.map((item) => item.state)).toEqual(['waiting'])

  useAppStore.setState({ config: { ...composerConfig, executors, appearance: { ...composerConfig.appearance, agentAvatars: appearances } }, sessions: [a, b, c] })
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'git-repository', hostId: 'local', repoPath: '/repo',
    branches: [{ name: 'main', worktreePath: '/repo', workspaceId: 'workspace', isCurrent: true }] })
  await dom.render(<BranchesPanel workspace={composerConfig.workspaces[0]!} />)
  await vi.waitFor(() => expect(badges()).toEqual(['A', 'B']))
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

it('SettingsPanel passes the configured executor inventory to Appearance', async () => {
  useAppStore.setState({ config: { ...composerConfig, executors } })
  await dom.render(<SettingsPanel initialSection="appearance" onClose={() => {}} />)
  expect(dom.container.querySelector('[aria-label="Codex avatar badge"]')).not.toBeNull()
  expect(dom.container.querySelector('[aria-label="Reviewer avatar badge"]')).not.toBeNull()
})

it('Topic presence reads the live Session executor rather than its Provider', async () => {
  const workspace = { ...composerConfig.workspaces[0]!, id: SCRATCH_WORKSPACE_ID, name: 'Scratch', path: '/scratch' }
  const path = '/scratch/topic--view--review'
  useAppStore.setState({ config: { ...composerConfig, executors, workspaces: [workspace], appearance: { ...composerConfig.appearance, agentAvatars: appearances } },
    sessions: [{ ...composerSession(), executorId: 'review', workspacePath: path }] })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([{ id: 'view:review', directoryPath: path, topicPath: `${path}/topic.md`, title: 'Review', summary: '', collaborators: [] }])
  await dom.render(<WorkspaceTopicsPanel workspace={workspace} onRevealDirectory={() => {}} />)
  await vi.waitFor(() => expect(badges()).toEqual(['B']))
})
