// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SpaceTopicsTree } from '../src/renderer/src/components/SpaceTopicsTree'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { seedMoteWorkface, scratchWorkspace, moteTopics, customMoteId, quietMoteId, defaultTab, installNativePopover } from './fixtures/mote-workface'
const dom = composerDOM()
let restorePopover: () => void
beforeEach(() => { restorePopover = installNativePopover() })
afterEach(() => restorePopover())
const selector = '[data-mote-directory-view]'
function seed() {
  seedMoteWorkface()
  const topics = moteTopics.map(t => t.soul ? { ...t, moteArchive: { state: t.id === quietMoteId ? 'archived' : 'active', version: 'fixture' } as const } : t)
  const read = vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  useAppStore.setState({ activeWorkspaceId: scratchWorkspace.id, collapsedProjectGroups: {}, pinnedItems: {},
    workbenchSpaceSelection: { workspaceId: scratchWorkspace.id, topicId: customMoteId, spaceId: 'original-space', zoneId: 'original-zone', groupId: 'mote-group', tabId: defaultTab.id, regionId: 'default-region' },
    scratchTopicSnapshots: { ...useAppStore.getState().scratchTopicSnapshots, [scratchWorkspace.id]: { ...useAppStore.getState().scratchTopicSnapshots[scratchWorkspace.id]!, topics } } })
  return { topics, read }
}
const tree = (query = '') => <SpaceTopicsTree workspace={scratchWorkspace} icons={{}} onChangeIcon={() => {}} query={query} />
it('both actual presentations retain identical original Mote nodes, selection, draft, Run and ordering; ordinary Topics stay out', async () => {
  seed(); await dom.render(tree())
  const before = useAppStore.getState(), row = dom.container.querySelector('[data-space-nav="topic:' + customMoteId + '"]')
  expect(dom.container.querySelector(selector)?.getAttribute('data-mote-directory-view')).toBe('collaborators')
  const ids = [...dom.container.querySelectorAll(selector + ' [data-space-nav]')].map(n => n.getAttribute('data-space-nav'))
  expect(ids).toHaveLength(2)
  expect(row?.getAttribute('aria-current')).toBe('page')
  await act(async () => useAppStore.setState({ config: { ...before.config!, moteDirectoryView: 'list' } }))
  expect(dom.container.querySelector(selector)?.getAttribute('data-mote-directory-view')).toBe('list')
  expect(dom.container.querySelector('[data-space-nav="topic:' + customMoteId + '"]')).toBe(row)
  expect([...dom.container.querySelectorAll(selector + ' [data-space-nav]')].map(n => n.getAttribute('data-space-nav'))).toEqual(ids)
  for (const key of ['tabs', 'layouts', 'sessions', 'agentComposerDrafts', 'workbenchSpaceSelection'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
})
it('icon/count archive filter reveals the original archived object and keeps unknown and main objects', async () => {
  seed(); await dom.render(tree())
  const archive = dom.container.querySelector<HTMLButtonElement>('[aria-label="Show archived Motes in Space"]')!
  expect(archive.textContent).toBe('1'); expect(archive.querySelector('svg')).not.toBeNull()
  expect(archive.getAttribute('aria-pressed')).toBe('false')
  expect(dom.container.querySelector('[data-space-nav="topic:' + quietMoteId + '"]')).toBeNull()
  await dom.click('[aria-label="Show archived Motes in Space"]')
  expect(dom.container.querySelector('[data-space-nav="topic:' + quietMoteId + '"]')).not.toBeNull()
  expect(archive.getAttribute('aria-pressed')).toBe('true')
  await dom.click('[aria-label="Show archived Motes in Space"]')
  expect(dom.container.querySelector('[data-space-nav="topic:' + quietMoteId + '"]')).toBeNull()
})
it('more affordance opens the original exact object menu and rename without navigating or rewriting a healthy Run', async () => {
  seed(); await dom.render(tree())
  const before = useAppStore.getState()
  await dom.click('[aria-label="More actions for Analyst with a long persistent name"]')
  const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(n => n.textContent === 'Rename Mote…')
  expect(rename).toBeDefined()
  await act(async () => rename!.click())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')
  expect(input?.value).toBe('Analyst with a long persistent name')
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
})
it('a collaborator opens its exact original object through the existing navigation owner', async () => {
  seed()
  const ensure = vi.spyOn(api.scratch, 'ensureMote').mockResolvedValue(moteTopics.find(t => t.id === customMoteId)!)
  const open = vi.fn().mockResolvedValue(true)
  useAppStore.setState({ openScratchTopic: open })
  await dom.render(tree())
  const before = useAppStore.getState()
  await dom.click('[data-space-nav="topic:' + customMoteId + '"]')
  expect(ensure).toHaveBeenCalledWith(scratchWorkspace.id, customMoteId)
  expect(open).toHaveBeenCalledWith(customMoteId, scratchWorkspace.id, { signal: expect.any(AbortSignal) })
  for (const key of ['tabs', 'layouts', 'sessions', 'agentComposerDrafts'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
})
it('search filters the same Mote list and zero archived remains a discoverable icon', async () => {
  const { topics } = seed()
  topics.forEach(t => { if (t.soul) t.moteArchive = { state: 'active', version: 'fixture' } })
  await dom.render(tree('Analyst'))
  expect(dom.container.querySelectorAll(selector + ' [data-space-nav]')).toHaveLength(1)
  expect(dom.container.querySelector('[aria-label="Show archived Motes in Space"]')?.textContent).toBe('0')
})
it('actual Settings panel retains dirty choice on real save failure and saves only its authored config field', async () => {
  const f = await configOwnerFixture({ workspaces: [scratchWorkspace] })
  const publish = f.publish.getMockImplementation()!
  f.publish.mockImplementation(config => { publish(config); useAppStore.getState().setConfig(config) })
  useAppStore.setState({ config: f.owner.current })
  const save = vi.spyOn(api.config, 'save').mockImplementation((next, expected) => f.owner.edit(expected, next))
  await dom.render(<SettingsPanel initialSection="mote" onClose={() => {}} />)
  expect(dom.container.querySelector<HTMLInputElement>('[value="collaborators"]')?.checked).toBe(true)
  await dom.click('[value="list"]')
  f.save.mockRejectedValueOnce(new Error('disk full'))
  await dom.click('.settings-pane-actions button')
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toBe('disk full')
  expect(dom.container.querySelector<HTMLInputElement>('[value="list"]')?.checked).toBe(true)
  expect(f.owner.current.moteDirectoryView).toBeUndefined()
  await act(async () => f.owner.update(c => ({ ...c, copyPathsAsAbsolute: true })))
  await dom.click('.settings-pane-actions button')
  await act(async () => { await save.mock.results.at(-1)!.value })
  expect((await f.disk()).moteDirectoryView).toBe('list')
  expect(f.owner.current.copyPathsAsAbsolute).toBe(true)
  expect(f.owner.current.workspaces).toEqual([scratchWorkspace])
})

it('configured portrait size reaches the original directory without replacing identities, selection, drafts or Runs', async () => {
  seed(); await dom.render(tree())
  const roster = dom.container.querySelector<HTMLElement>(selector)!, before = useAppStore.getState()
  const rows = [...roster.querySelectorAll('[data-space-nav]')]
  expect(roster.style.getPropertyValue('--mote-directory-avatar-size')).toBe('45px')
  for (const moteDirectoryAvatarSize of [48, 24]) {
    await act(async () => useAppStore.setState({ config: { ...before.config!, moteDirectoryAvatarSize } }))
    expect(roster.style.getPropertyValue('--mote-directory-avatar-size')).toBe(`${moteDirectoryAvatarSize}px`)
    expect([...roster.querySelectorAll('[data-space-nav]')]).toEqual(rows)
    for (const key of ['tabs', 'layouts', 'sessions', 'agentComposerDrafts', 'workbenchSpaceSelection'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
  }
  expect(rows[1]?.getAttribute('title')).toContain('Analyst with a long persistent name')
})
async function moveSize(value: number): Promise<void> {
  const range = dom.container.querySelector<HTMLInputElement>('.mote-directory-size input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(range, String(value))
    range.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
it('original Settings previews size locally, retains failed draft and saves it durably with concurrent other settings intact', async () => {
  const f = await configOwnerFixture(), publish = f.publish.getMockImplementation()!
  f.publish.mockImplementation(config => { publish(config); useAppStore.getState().setConfig(config) })
  useAppStore.setState({ config: f.owner.current })
  const save = vi.spyOn(api.config, 'save').mockImplementation((next, expected) => f.owner.edit(expected, next))
  await dom.render(<SettingsPanel initialSection="mote" onClose={() => {}} />)
  expect(dom.container.querySelector<HTMLInputElement>('.mote-directory-size input')?.value).toBe('45')
  await moveSize(44)
  expect(dom.container.querySelector('output')?.textContent).toBe('44px')
  expect((dom.container.querySelector('.mote-directory-settings') as HTMLElement).style.getPropertyValue('--mote-directory-avatar-size')).toBe('44px')
  expect(f.owner.current.moteDirectoryAvatarSize).toBeUndefined()
  f.save.mockRejectedValueOnce(new Error('disk full'))
  await dom.click('.settings-pane-actions button')
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toBe('disk full')
  expect(dom.container.querySelector('output')?.textContent).toBe('44px')
  await act(async () => f.owner.update(c => ({ ...c, copyPathsAsAbsolute: true, moteDirectoryView: 'list' })))
  expect(dom.container.querySelector<HTMLInputElement>('[value="list"]')?.checked).toBe(true)
  await dom.click('.settings-pane-actions button')
  await act(async () => { await save.mock.results.at(-1)!.value })
  expect((await f.disk()).moteDirectoryAvatarSize).toBe(44)
  expect(f.owner.current.copyPathsAsAbsolute).toBe(true)
  expect(f.owner.current.moteDirectoryView).toBe('list')
  await dom.render(<div />)
  useAppStore.setState({ config: await f.store.get() })
  await dom.render(<SettingsPanel initialSection="mote" onClose={() => {}} />)
  expect(dom.container.querySelector<HTMLInputElement>('.mote-directory-size input')?.value).toBe('44')
})
it('a concurrent size edit rejects the stale save and preserves the local draft and original authoritative value', async () => {
  const f = await configOwnerFixture(), publish = f.publish.getMockImplementation()!
  f.publish.mockImplementation(config => { publish(config); useAppStore.getState().setConfig(config) })
  useAppStore.setState({ config: f.owner.current })
  vi.spyOn(api.config, 'save').mockImplementation((next, expected) => f.owner.edit(expected, next))
  await dom.render(<SettingsPanel initialSection="mote" onClose={() => {}} />)
  await moveSize(44)
  await act(async () => f.owner.update(c => ({ ...c, moteDirectoryAvatarSize: 40 })))
  await dom.click('.settings-pane-actions button')
  expect(dom.container.querySelector('[role="alert"]')).not.toBeNull()
  expect(dom.container.querySelector('output')?.textContent).toBe('44px')
  expect(f.owner.current.moteDirectoryAvatarSize).toBe(40)
  expect((await f.disk()).moteDirectoryAvatarSize).toBe(40)
})

it('actual silhouette presets and the fine slider share one draft, saved through the original owner', async () => {
  const f = await configOwnerFixture(), publish = f.publish.getMockImplementation()!
  f.publish.mockImplementation(config => { publish(config); useAppStore.getState().setConfig(config) })
  useAppStore.setState({ config: f.owner.current })
  const save = vi.spyOn(api.config, 'save').mockImplementation((next, expected) => f.owner.edit(expected, next))
  await dom.render(<SettingsPanel initialSection="mote" onClose={() => {}} />)
  expect(dom.container.querySelector('output')?.textContent).toBe('45px')
  for (const size of [24, 32, 40, 48]) {
    const button = dom.container.querySelector<HTMLButtonElement>(`[aria-label="${size}px avatar"]`)!
    const silhouette = button.querySelector<HTMLElement>('.mote-directory-sizes__silhouette')!
    expect(silhouette.style.width).toBe(`${size}px`); expect(silhouette.querySelector('svg')).not.toBeNull()
    await dom.click(`[aria-label="${size}px avatar"]`)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(dom.container.querySelector<HTMLInputElement>('.mote-directory-size input')?.value).toBe(String(size))
    expect(f.owner.current.moteDirectoryAvatarSize).toBeUndefined()
  }
  await moveSize(45)
  expect(dom.container.querySelector('[aria-pressed="true"][aria-label$="px avatar"]')).toBeNull()
  await dom.click('[aria-label="40px avatar"]')
  await dom.click('.settings-pane-actions button')
  await act(async () => { await save.mock.results.at(-1)!.value })
  expect((await f.disk()).moteDirectoryAvatarSize).toBe(40)
})
