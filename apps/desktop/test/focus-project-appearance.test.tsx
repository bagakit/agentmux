// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react'
import { expect, it, vi } from 'vitest'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { FocusProjectLanes } from '../src/renderer/src/components/FocusProjectLanes'
import { ProjectIcon } from '../src/renderer/src/components/ProjectIcon'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { FocusProjectLane } from '../src/renderer/src/lib/focus-project-lanes'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
const dom = composerDOM(), key = (id: string, host = 'local') => JSON.stringify([host, id])
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlSAAAAAASUVORK5CYII='
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function frame(project: string, host = 'local') { return [...dom.container.querySelectorAll<HTMLElement>('[data-project-group-key]')].find(node => node.dataset.projectGroupKey === key(project, host))! }
async function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
  expect(button, label).not.toBeNull(); await act(async () => button!.click())
}
async function scene() {
  const root = { ...composerConfig.workspaces[0]!, id: 'root', name: 'Project', path: fixturePath('appearance/root') }
  const workspaces = [root, ...['one', 'two'].map(id => ({ ...root, id, path: fixturePath('appearance/checkout/' + id), repoPath: root.path, branch: id })),
    { ...root, id: 'other', path: fixturePath('appearance/other') }]
  const sessions = workspaces.map(workspace => ({ ...composerSession('task-' + workspace.id), workspacePath: workspace.path,
    status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } }))
  const tabs = Object.fromEntries(workspaces.map(workspace => { const tab = createWorkbenchTab('tab-' + workspace.id,
    { kind: 'agent', phase: 'attached', regionId: 'r-' + workspace.id, workspaceId: workspace.id, sessionId: 'task-' + workspace.id }); return [tab.id, tab] }))
  useAppStore.setState({ config: { ...composerConfig, workspaces, focus: { recentActivityHours: 48, zonePresentations: [{ key: JSON.stringify(['project', 'local', 'root']), presentation: 'sections' }], projects: [{ key: key('root'), pinned: true, note: 'My project route', color: 'blue', collapsed: null }] } },
    mainSurface: 'agents', sessions, tabs, layouts: Object.fromEntries(workspaces.map(workspace => [workspace.id, createWorkspaceLayout('g-' + workspace.id, ['tab-' + workspace.id])])),
    timelines: {}, agentNames: {}, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  vi.spyOn(api.spatial, 'read').mockImplementation(async () => ({ schemaVersion: 1, revision: 1, graph: desktopSpatialGraph(useAppStore.getState(), []) }))
  await initializeSpatialControlFixture()
  await dom.render(<GlobalFocusSurface />)
}

it('actual Global consumer has one stable project header and image owner across its three checkouts', async () => {
  const appearance = vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: image })
  await scene()
  expect(dom.container.querySelectorAll('[data-project-group-key]')).toHaveLength(2)
  const project = frame('root'), heading = project.querySelector('.focus-project-frame__heading')!
  expect(project.querySelectorAll('[data-lane-id]')).toHaveLength(1)
  expect(project.querySelectorAll('[data-focus-zone-section]')).toHaveLength(3)
  expect([...project.querySelectorAll('[data-focus-zone-section] .focus-project-lanes__label')].map(node => node.textContent)).toEqual(['Root', 'one', 'two'])
  expect(frame('other').querySelector('[data-focus-zone-section]')).toBeNull()
  expect(project.querySelectorAll('.focus-project-preferences__trigger')).toHaveLength(1)
  expect(project.querySelectorAll('[data-focus-project-note]')).toHaveLength(1)
  expect(heading.textContent).toContain('My project route')
  expect(project.querySelectorAll('[data-project-watermark]')).toHaveLength(1)
  expect(project.querySelector('img[alt="Project icon"]')?.getAttribute('src')).toBe(project.querySelector('[data-project-watermark]')?.getAttribute('src'))
  expect(appearance.mock.calls.map(([id]) => id).sort()).toEqual(['other', 'other', 'root', 'root'])
  const card = project.querySelector('[data-session-id="task-one"]'), before = useAppStore.getState()
  await act(async () => useAppStore.setState({ config: { ...before.config!, focus: { ...before.config!.focus!, projects: [{ ...before.config!.focus!.projects![0]!, color: 'green' }] } },
    sessions: before.sessions.map(session => ({ ...session, latestOutputBytes: session.latestOutputBytes + 1024 })) }))
  expect(frame('root')).toBe(project); expect(frame('root').querySelector('[data-session-id="task-one"]')).toBe(card)
  expect(frame('root').dataset.focusProjectColor).toBe('green')
  expect(appearance).toHaveBeenCalledTimes(4)
  for (const field of ['tabs', 'layouts', 'agentFocus', 'agentComposerDrafts'] as const) expect(useAppStore.getState()[field]).toBe(before[field])
})

it('unknown and failed images never become a watermark, and image failure keeps the original project available', async () => {
  const pending = deferred<{ kind: 'repository'; icon: string | null }>()
  vi.spyOn(api.workspaces, 'appearance').mockImplementation(id => id === 'root' ? pending.promise : Promise.resolve({ kind: 'directory', icon: null }))
  await scene()
  const project = frame('root')
  expect(dom.container.querySelector('[data-project-watermark]')).toBeNull()
  expect(frame('other').querySelector('[data-monogram]')).not.toBeNull()
  await act(async () => pending.resolve({ kind: 'repository', icon: image }))
  expect(frame('root')).toBe(project)
  const watermark = project.querySelector<HTMLImageElement>('[data-project-watermark]')!
  expect(watermark.alt).toBe(''); expect(watermark.getAttribute('aria-hidden')).toBe('true')
  await act(async () => watermark.dispatchEvent(new Event('error')))
  expect(project.querySelector('[data-project-watermark]')).toBeNull()
  expect(project.querySelector('[data-monogram]')).not.toBeNull()
  expect(project.querySelector('.focus-project-preferences__trigger')).not.toBeNull()
  expect(project.querySelector('[data-session-id="task-one"]')).not.toBeNull()
})

function lane(id: string, hostId = 'local'): FocusProjectLane {
  return { id, workspaceId: id, projectId: 'root', projectWorkspaceId: 'root', hostId, name: 'Project / ' + id, labels: ['Project', id], path: fixturePath('appearance/' + id), topicId: null,
    recovery: null, summary: null, activeAgentRefs: [], contextRefs: [], lastActivityAt: null }
}
it('removing the first checkout preserves project preference draft and the other Hosts stay separate', async () => {
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  const a = lane('a'), b = lane('b'), remote = lane('c', 'remote')
  useAppStore.setState({ config: { ...composerConfig, workspaces: [{ ...composerConfig.workspaces[0]!, id: 'root', name: 'Actual root' }] } })
  const render = (lanes: readonly FocusProjectLane[], currentLaneId = 'b') => dom.render(<FocusProjectLanes resourceMenus lanes={lanes} currentLaneId={currentLaneId} selectedProjectKey={key('root', 'remote')} onSelect={() => {}} renderLane={(lane, heading) => <>{heading}{[...(lane.zoneHeadings?.values() ?? [])].map(view => view.section)}<input aria-label={'Draft ' + lane.id} defaultValue="Original work" /></>} />)
  await render([a, b, remote])
  expect(dom.container.querySelectorAll('[data-project-group-key]')).toHaveLength(2)
  const project = frame('root'), original = project.querySelector('input[aria-label^="Draft "]')
  expect(original).not.toBeNull()
  expect(project.querySelector('.focus-project-frame__heading .focus-project-lanes__axis')?.getAttribute('aria-current')).toBe('location')
  expect(project.querySelector('.focus-project-frame__heading .focus-project-lanes__axis')?.getAttribute('aria-pressed')).toBe('false')
  expect(frame('root', 'remote').querySelector('.focus-project-frame__heading .focus-project-lanes__axis')?.hasAttribute('aria-current')).toBe(false)
  expect(project.querySelector('[data-focus-zone-id="b"] .focus-project-lanes__axis')?.getAttribute('aria-current')).toBe('location')
  await render([{ ...a, labels: ['Project'] }, b, remote], 'a')
  expect(project.querySelector('[data-focus-zone-id="a"] .focus-project-lanes__axis')?.textContent).toBe('Root')
  expect(project.querySelector('[data-focus-zone-id="a"] .focus-project-lanes__axis')?.getAttribute('aria-current')).toBe('location')
  expect(project.querySelector('[data-focus-zone-id="b"] .focus-project-lanes__axis')?.hasAttribute('data-focus-project-scope-control')).toBe(true)
  expect(project.querySelector('.focus-project-frame__heading .focus-project-lanes__axis')?.getAttribute('aria-current')).toBe('location')
  await click('Project preferences · Actual root')
  const note = document.querySelector<HTMLInputElement>('[aria-label="Project note"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(note, 'Unsubmitted route'); note.dispatchEvent(new Event('input', { bubbles: true })) })
  await render([b, remote])
  expect(frame('root')).toBe(project)
  expect(project.querySelector('input[aria-label^="Draft "]')).toBe(original)
  expect(document.querySelector('[aria-label="Project note"]')).toBe(note)
  expect(note.value).toBe('Unsubmitted route')
  expect(frame('root', 'remote').querySelector('.focus-project-frame__heading')?.textContent).toContain('Project')
})

it('ProjectIcon shares one read for foreground/background and never paints a previous workspace result', async () => {
  const pending = deferred<{ kind: 'directory'; icon: null }>()
  const appearance = vi.spyOn(api.workspaces, 'appearance').mockImplementation(id => id === 'first' ? Promise.resolve({ kind: 'repository', icon: image }) : pending.promise)
  const committed: Array<string | null> = []
  function Preview({ workspaceId }: { workspaceId: string }) {
    useLayoutEffect(() => { committed.push(dom.container.querySelector('[data-project-watermark]')?.getAttribute('src') ?? null) }, [workspaceId])
    return <div><ProjectIcon workspaceId={workspaceId} name={workspaceId === 'first' ? 'First' : 'Second'} backdrop /></div>
  }
  await dom.render(<Preview workspaceId="first" />)
  expect(dom.container.querySelectorAll('img')).toHaveLength(2); expect(appearance).toHaveBeenCalledOnce()
  await dom.render(<Preview workspaceId="second" />)
  expect(committed.at(-1)).toBeNull()
  expect(dom.container.querySelectorAll('img')).toHaveLength(0)
  await act(async () => pending.resolve({ kind: 'directory', icon: null }))
  expect(dom.container.querySelector('[data-project-watermark]')).toBeNull()
  expect(dom.container.querySelector('[data-monogram]')?.textContent).toBe('S')
  expect(appearance.mock.calls.map(([id]) => id)).toEqual(['first', 'second'])
})

it('an unregistered repository root never borrows the first checkout for image discovery', async () => {
  const appearance = vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: image })
  const checkout = { ...composerConfig.workspaces[0]!, id: 'checkout', repoPath: fixturePath('appearance/unregistered-root') }
  useAppStore.setState({ config: { ...composerConfig, workspaces: [checkout] } })
  await dom.render(<FocusProjectLanes resourceMenus lanes={[{ ...lane('checkout'), projectWorkspaceId: 'checkout' }]} selectedProjectKey="all" onSelect={() => {}} renderLane={(_lane, heading) => heading} />)
  expect(dom.container.querySelector('[data-project-group-key]')).not.toBeNull()
  expect(dom.container.querySelector('[data-project-watermark]')).toBeNull()
  expect(appearance).not.toHaveBeenCalled()
})

it('the compact original editor keeps a newer note while an earlier authored save completes', async () => {
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  await scene()
  const original = useAppStore.getState().config!, request = deferred<typeof original>()
  const save = vi.spyOn(api.config, 'save').mockImplementation(() => request.promise)
  await click('Project preferences · Project')
  const note = document.querySelector<HTMLInputElement>('[aria-label="Project note"]')!
  const edit = async (value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(note, value); note.dispatchEvent(new Event('input', { bubbles: true })) })
  await edit('Submitted note'); await click('Save project preferences')
  expect(save).toHaveBeenCalledOnce()
  await edit('Newer unsaved note')
  await act(async () => request.resolve({ ...original, focus: { ...original.focus!, projects: original.focus!.projects!.map(item => ({ ...item, note: 'Submitted note' })) } }))
  expect(document.querySelector('[aria-label="Project note"]')).toBe(note)
  expect(note.value).toBe('Newer unsaved note')
  expect(document.querySelector('[data-focus-project-preferences]')?.textContent).toContain('Your newer edits are kept')
  expect(useAppStore.getState().config?.focus?.projects?.[0]?.note).toBe('Submitted note')
  expect(save).toHaveBeenCalledOnce()
})
