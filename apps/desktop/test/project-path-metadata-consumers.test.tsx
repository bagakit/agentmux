const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import type { AgentMuxSpaceFact, AgentMuxZoneFact } from '@agentmux/core/control'
import type { HostConfig } from '../src/shared/contracts'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { SpaceTopicsTree } from '../src/renderer/src/components/SpaceTopicsTree'
import { WorkspaceTopicsPanel } from '../src/renderer/src/components/WorkspaceTopicsPanel'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { FocusProjectLanes } from '../src/renderer/src/components/FocusProjectLanes'
import { ProjectActivity } from '../src/renderer/src/components/ProjectActivity'
import { WorkspaceBoard } from '../src/renderer/src/components/WorkspaceBoard'
import { BoardDiscussionCanvas } from '../src/renderer/src/components/BoardDiscussionCanvas'
import { GoalsCommonActions } from '../src/renderer/src/components/GoalsCommonActions'
import { ConversationInputDetails } from '@agentmux/client-ui'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { SurveyItemOptions } from '../src/renderer/src/components/SurveyItemOptions'
import { LauncherResumePicker } from '../src/renderer/src/components/LauncherResumePicker'
import { AttentionRequestPanel } from '../src/renderer/src/components/AttentionRequestPanel'
import { ContinuousProgressControl } from '../src/renderer/src/components/ContinuousProgressControl'
import { WorkspaceSettingsPane } from '../src/renderer/src/components/settings/WorkspaceSettingsPane'
import { BoardRowsProvider } from '../src/renderer/src/hooks/useBoardRows'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { deriveFocusProjectLanes } from '../src/renderer/src/lib/focus-project-lanes'
import { buildProjectBranchLanes } from '../src/renderer/src/lib/project-board'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const home = _hygiene_fixturePath("Users/metadata-reader")
const path = ("" + (home) + _hygiene_fixturePath("projects/one"))
const local: HostConfig = { id: 'local', label: 'Local', kind: 'local' }
const remote: HostConfig = { id: 'remote', label: 'Remote', kind: 'ssh', hostname: 'example.invalid' }
const modes = [[local, false, '~/projects/one'], [local, true, path], [remote, false, path]] as const
function seed(host: HostConfig, absolute: boolean) {
  const workspace = { id: 'one', name: 'One', hostId: host.id, path, branch: 'main', kind: 'folder' as const }
  const session = { ...composerSession('reader'), hostId: host.id, workspacePath: path,
    control: { kind: 'agent' as const, hostId: host.id, agentSessionId: 'reader', run: { runId: 'original-run' } } }
  const config = { ...composerConfig, hosts: [host], workspaces: [workspace], copyPathsAsAbsolute: absolute, executors: {} }
  useAppStore.setState({ config, localHome: home, sessions: [session], activeWorkspaceId: workspace.id,
    tabs: {}, layouts: {}, timelines: {}, agentNames: {}, scratchTopicSnapshots: {}, executorDetections: {},
    hostChecks: {}, detectExecutors: vi.fn(), checkHost: vi.fn(), agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  return { config, workspace, session }
}
function element(selector: string, owner: ParentNode = document) {
  const node = owner.querySelector<HTMLElement>(selector)
  expect(node, `Mounted product consumer ${selector}`).not.toBeNull()
  return node!
}
async function key(node: HTMLElement, key: string) { await act(async () => node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))) }
beforeEach(() => {
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: 'reader', source: { providerId: 'codex', nativeSessionId: 'native-reader' }, items: [], nextCursor: null })
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  vi.spyOn(api.continuousProgress, 'onChanged').mockReturnValue(() => {})
})

describe('typed project metadata consumers preserve canonical identities', () => {
  it.each(modes)('Focus rows and lanes obey Host / setting: %j %s', async (host, absolute, expected) => {
    const { config, session } = seed(host, absolute)
    const contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts
    expect(contexts).toHaveLength(1)
    const lanes = deriveFocusProjectLanes(contexts, config)
    expect(lanes).toHaveLength(1)
    expect(lanes[0]!.hostId).toBe(host.id)
    const select = vi.fn()
    await dom.render(<><FocusContextRow context={contexts[0]!} selected={false} onSelect={select} />
      <FocusProjectLanes lanes={lanes} selectedWorkspaceId="one" onSelect={select} renderLane={(_, heading) => heading} /></>)
    expect(element('.focus-context').title).toContain(expected)
    expect(element('.focus-project-lanes__axis').title).toContain(expected)
    await dom.click('.focus-context')
    expect(select).toHaveBeenCalledExactlyOnceWith(session.id)
    expect(useAppStore.getState().sessions[0]!.workspacePath).toBe(path)
    expect(useAppStore.getState().sessions[0]!.control.run.runId).toBe('original-run')
  })

  it.each(modes)('Recent Focus current and retained identities style true workspace paths: %j %s', async (host, absolute, expected) => {
    const { config } = seed(host, absolute)
    const contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts
    const lanes = deriveFocusProjectLanes(contexts, config)
    const now = Date.now()
    await dom.render(<RecentFocusTimeline entries={[{ sessionId: 'archived', focusedAt: now - 60000,
      identity: { name: 'Archived', kind: 'agent', providerId: 'codex', hostId: host.id, workspacePath: path } }]}
      currentSessionId="reader" contexts={contexts} lanes={lanes} onSelect={() => {}} />)
    expect(element('[data-focus-timeline-id="reader"] .recent-focus__gutter').title).toContain(expected)
    expect(element('[data-focus-timeline-id="archived"] .recent-focus__gutter').title).toContain(expected)
    expect(useAppStore.getState().sessions[0]!.workspacePath).toBe(path)
  })

  it.each(modes)('Topic navigation hover and empty-summary directory use the same preference: %j %s', async (host, absolute, expected) => {
    const { workspace } = seed(host, absolute)
    const topic = { id: 'view:one', title: 'Topic One', summary: '', directoryPath: path, topicPath: `${path}/topic.md`, collaborators: [] }
    useAppStore.setState({ scratchTopicSnapshots: { one: { scope: scratchTopicsScope(workspace), topics: [topic], error: null } },
      refreshScratchTopics: vi.fn(), collapsedProjectGroups: {}, pinnedItems: {}, spaceObjectIcons: {} })
    await dom.render(<><SpaceTopicsTree workspace={workspace} icons={{}} onChangeIcon={() => {}} />
      <WorkspaceTopicsPanel workspace={workspace} onRevealDirectory={() => {}} /></>)
    expect(element('.space-topic-row').title).toBe(`Topic One\n${expected}`)
    expect(element('.workspace-topic-entry .selector-row__identity small').textContent).toBe(expected)
    expect(topic.directoryPath).toBe(path)
  })

  it.each(modes)('Board row and discussion detail display one styled path: %j %s', async (host, absolute, expected) => {
    const { workspace, session } = seed(host, absolute)
    const snapshot = { kind: 'git-repository' as const, hostId: host.id, repoPath: path,
      branches: [{ name: 'main', isCurrent: true, worktreePath: path, workspaceId: workspace.id }] }
    vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue(snapshot)
    const rows = buildProjectBranchLanes(snapshot, [workspace], [session])
    expect(rows).toHaveLength(1)
    await dom.render(<BoardRowsProvider enabled><WorkspaceBoard /></BoardRowsProvider>)
    const small = element('.board-branch-head__identity small[title]')
    expect([small.textContent, small.title]).toEqual([expected, expected])
    await dom.render(<BoardDiscussionCanvas row={rows[0]!} anchor={workspace} onClose={() => {}} onOpenBranches={() => {}} />)
    const detail = element('.discussion-canvas small[title]')
    expect([detail.textContent, detail.title]).toEqual([expected, expected])
    expect(api.workspaces.listBranches).toHaveBeenCalledWith('one')
    expect(rows[0]!.path).toBe(path)
  })

  it.each(modes)('activity menu keeps exact original Session actions: %j %s', async (host, absolute, expected) => {
    const { workspace, session } = seed(host, absolute)
    const selectSession = vi.fn()
    useAppStore.setState({ selectSession })
    await dom.render(<ProjectActivity sessions={[session]} contexts={[{ id: workspace.id, kind: 'branch', label: 'main', hostId: host.id, path }]} />)
    const trigger = element('.project-activity')
    await act(async () => trigger.focus()); await key(trigger, 'ArrowDown')
    const item = element('.project-activity-group__summary')
    expect(item.title).toContain(expected)
    expect(element('.project-activity-group__identity em').textContent).toContain(expected)
    await act(async () => item.click())
    expect(selectSession).toHaveBeenCalledExactlyOnceWith('reader')
  })

  it.each(modes)('sender disclosure and Goals hover honor project presentation: %j %s', async (host, absolute, expected) => {
    const { workspace } = seed(host, absolute)
    const details = { sessionId: 'reader', label: 'Reader', providerId: 'codex', createdAt: 1,
      project: { workspaceId: workspace.id, name: workspace.name, path }, goals: [] }
    const readDetails = vi.fn(() => details)
    await dom.render(<DesktopClientUiProvider><ConversationInputDetails messageId="message" speaker={{ role: 'agent', id: 'reader' }} describeSpeaker={() => ({ name: 'Reader', readDetails })} /></DesktopClientUiProvider>)
    expect(readDetails).not.toHaveBeenCalled()
    await dom.click('[aria-label="Message details"]')
    expect(element('.conversation-input-details__identity small').title).toBe(expected)
    expect(readDetails).toHaveBeenCalledTimes(1)
    expect(details.project.path).toBe(path)
    await dom.render(<GoalsCommonActions />)
    const facts = [...dom.container.querySelectorAll<HTMLElement>('.goals-common__facts small[title]')]
    expect(facts.length).toBeGreaterThan(0)
    expect(facts.map(node => node.title)).toEqual(facts.map(() => `${host.id} · ${expected}`))
  })

  it.each(modes)('Survey menus format project and related Topic body/hover without changing link identity: %j %s', async (host, absolute, expected) => {
    const { workspace } = seed(host, absolute)
    const zone: AgentMuxZoneFact = { zoneId: 'zone', workspaceId: workspace.id, kind: 'worktree', hostId: host.id, directoryPath: path, branch: 'main' }
    const topic: AgentMuxSpaceFact = { spaceId: 'topic-one', kind: 'topic', name: 'Topic', hostId: host.id, directoryPath: path, projectId: null }
    const link = vi.fn(), open = vi.fn()
    await dom.render(<SurveyItemOptions visible title="One exploration" zone={zone} workspace={workspace} collected={false} relatedTopics={[topic]} activityDetails={null} panels={null}
      relations={{ zone, topics: [topic], relatedTopics: [], pendingSpaceId: null, onLinkChange: link, onOpenTopic: open }}
      onCollectedChange={() => {}} onManageBrowsers={() => {}} onOpenWorkspace={open} />)
    const trigger = element('[aria-label="Exploration options"]')
    await act(async () => trigger.focus()); await key(trigger, 'ArrowDown')
    expect(element('[aria-label^="Open resource Workspace:"]').getAttribute('aria-label')).toContain(expected)
    const sub = element('[aria-label="Link Topics"]')
    await act(async () => sub.focus()); await key(sub, 'ArrowRight')
    const checkbox = element('[role="menuitemcheckbox"][data-survey-topic-id="topic-one"]')
    expect(checkbox.getAttribute('aria-label')).toBe(`Link Topic: Topic, ${host.id}, ${expected}`)
    expect(checkbox.title).toBe(`Topic\n${host.id}\n${expected}`)
    expect(checkbox.textContent).toContain(`${host.id} · ${expected}`)
    await act(async () => checkbox.click())
    expect(link).toHaveBeenCalledExactlyOnceWith('topic-one', true)
    expect(topic.directoryPath).toBe(path)
  })

  it.each(modes)('request, continuous-progress target and Settings retain original machine path: %j %s', async (host, absolute, expected) => {
    const { config, session } = seed(host, absolute)
    await dom.render(<><AttentionRequestPanel sessionId={session.id} onClose={() => {}} /><ContinuousProgressControl session={session} /><WorkspaceSettingsPane config={config} onClose={() => {}} /></>)
    const target = element('[data-progress-details="target"] dd[title]')
    expect([target.textContent, target.title]).toEqual([expected, expected])
    const settings = element('.workspace-settings-list small')
    expect([settings.textContent, settings.title]).toEqual([expected, expected])
    const request = element('.attention-request-panel small[title]')
    expect([request.textContent, request.title]).toEqual([expected, expected])
    expect(api.continuousProgress.list).toHaveBeenCalledExactlyOnceWith({ hostId: host.id, agentSessionId: session.id, providerId: 'codex', workspacePath: path })
    expect(useAppStore.getState().sessions[0]!.control.run.runId).toBe('original-run')
  })

  it.each(modes)('saved Session directory is styled while recovery identity remains canonical: %j %s', async (host, absolute, expected) => {
    const { workspace } = seed(host, absolute)
    const candidate = { agentSessionId: 'saved', hostId: host.id, workspacePath: path, providerId: 'codex', executorId: 'codex',
      capabilities: { providerResume: true }, label: 'Saved reader', createdAt: 1, updatedAt: 2, run: { runId: 'old-run' } }
    useAppStore.setState({ recoveryCandidates: [candidate] })
    await dom.render(<LauncherResumePicker workspace={workspace} />)
    const resume = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Resume')!
    expect(resume).toBeDefined(); await act(async () => resume.click())
    const directory = element('.launcher-resume__path')
    expect([directory.textContent, directory.title]).toEqual([expected, expected])
    expect(useAppStore.getState().recoveryCandidates[0]!.workspacePath).toBe(path)
    expect(api.sessions.historyPage).toHaveBeenCalledWith({ hostId: host.id, agentSessionId: 'saved' }, expect.anything())
  })
})
