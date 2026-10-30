// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.mock('electron', async () => { const { tmpdir } = await import('node:os'); return { app: { getPath: () => tmpdir() } } })
import { focusSettingsModule } from '../src/renderer/src/components/settings/modules/focus'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { executeSettingsControl } from '../src/main/settings-control'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'
import { agentBookmarks } from '../src/renderer/src/lib/agent-bookmarks'

const dom = composerDOM(), Pane = focusSettingsModule.Pane
const choose = (field: string, value: string) => dom.click(`input[name="focus-${field}"][value="${value}"]`)
const checked = (value: string) => dom.container.querySelector<HTMLInputElement>(`input[name="focus-topic-presentation"][value="${value}"]`)!.checked
const collection = () => dom.container.querySelector<HTMLElement>('.focus-settings-preview [data-focus-collection]')!
const exampleAgents = () => [...collection().querySelectorAll<HTMLElement>('[data-example-agent]')].map(node => node.dataset.exampleAgent)
const saveButton = () => dom.container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!
async function scene(f: Awaited<ReturnType<typeof configOwnerFixture>>) {
  useAppStore.setState({ config: f.owner.current })
  const pending: Promise<unknown>[] = []
  const save = vi.spyOn(api.config, 'save').mockImplementation((next, expected) => {
    const operation = f.owner.edit(expected!, next).then(saved => { useAppStore.setState({ config: saved }); return saved })
    pending.push(operation)
    return operation
  })
  const render = () => dom.render(<Pane config={f.owner.current} active onClose={() => {}} onNavigate={() => {}} />)
  await render()
  const settled = () => act(async () => { await Promise.allSettled(pending) })
  return { save, render, settled }
}

it('the original GUI changes the shared Collection example immediately, then saves only its authored choice through ConfigOwner', async () => {
  const f = await configOwnerFixture(), { save, render, settled } = await scene(f)
  const before = useAppStore.getState(), bookmarks = agentBookmarks.get()
  const sources = vi.spyOn(api.sessions, 'historySources'), history = vi.spyOn(api.sessions, 'historyPage')
  expect(checked('cards')).toBe(true)
  const agents = exampleAgents()
  expect(agents).toHaveLength(2); expect(new Set(agents).size).toBe(2)
  expect(collection().querySelectorAll('[data-example-agent] [data-focus-topic-id]')).toHaveLength(2)
  expect(collection().querySelectorAll('.focus-topic-section')).toHaveLength(0)
  await choose('topic-presentation', 'sections')
  expect(exampleAgents()).toEqual(agents)
  expect(collection().querySelectorAll('.focus-topic-section')).toHaveLength(2)
  expect(collection().querySelectorAll('[data-example-agent] [data-focus-topic-id]')).toHaveLength(0)
  expect(save).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled()
  expect(useAppStore.getState().config?.focus?.topicPresentation).toBeUndefined()
  for (const key of ['sessions', 'tabs', 'layouts', 'agentFocus', 'agentComposerDrafts', 'mainSurface'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
  expect(agentBookmarks.get()).toBe(bookmarks); expect(sources).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled()
  await executeSettingsControl({ schemaVersion: 5, requestId: 'concurrent-reply-lines', operation: 'settings.set', key: 'focus.replyLines', value: '3' }, f.owner)
  await act(async () => useAppStore.setState({ config: f.owner.current })); await render()
  await dom.click('[data-settings-save-bar] button')
  await settled()
  expect(f.owner.current.focus).toEqual({ recentActivityHours: 48, replyLines: 3, topicPresentation: 'sections' })
  expect((await f.disk()).focus).toEqual(f.owner.current.focus)
  expect(useAppStore.getState().config?.focus?.topicPresentation).toBe('sections')
  expect(save).toHaveBeenCalledOnce(); expect(saveButton().disabled).toBe(true)
  expect(focusSettingsModule.savedSummary(f.owner.current)).toContain('Topic sections')
  expect(focusSettingsModule.searchTargets.some(target => target.id === 'topic-presentation' && target.keywords.includes('collection'))).toBe(true)
})

it('a real authored-field conflict preserves the Topic draft and original baseline instead of publishing another choice', async () => {
  const f = await configOwnerFixture({ focus: { recentActivityHours: 24 } }), { save, render } = await scene(f)
  await choose('topic-presentation', 'sections'); await choose('recent-activity', '12')
  await executeSettingsControl({ schemaVersion: 5, requestId: 'conflicting-window', operation: 'settings.set', key: 'focus.recentActivityHours', value: '72' }, f.owner)
  await act(async () => useAppStore.setState({ config: f.owner.current })); await render()
  await dom.click('[data-settings-save-bar] button')
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('focus.recentActivityHours')
  expect(checked('sections')).toBe(true); expect(f.owner.current.focus?.topicPresentation).toBeUndefined()
  expect(f.owner.current.focus?.recentActivityHours).toBe(72)
  await dom.click('[data-settings-save-bar] button')
  expect(save.mock.calls.map(call => call[1]?.focus?.recentActivityHours)).toEqual([24, 24])
  expect(checked('sections')).toBe(true); expect(saveButton().disabled).toBe(false)
})

it('a failed original durable save leaves the Topic draft, while a later pending-save choice remains authored', async () => {
  const f = await configOwnerFixture(), { save, settled } = await scene(f)
  const initial = f.owner.current, bytes = await f.bytes()
  f.save.mockRejectedValueOnce(Object.assign(new Error('Private durable Topic choice write failed'), { code: 'EIO' }))
  await choose('topic-presentation', 'sections'); await dom.click('[data-settings-save-bar] button')
  await settled()
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('Private durable Topic choice write failed')
  expect(checked('sections')).toBe(true); expect(f.owner.current).toBe(initial); expect(await f.bytes()).toBe(bytes)
  expect(f.publish).not.toHaveBeenCalled()
  const release = deferred<void>(), realSave = f.save.getMockImplementation()!
  f.save.mockImplementationOnce(async next => { await release.promise; return realSave(next) })
  await dom.click('[data-settings-save-bar] button')
  expect(saveButton().disabled).toBe(true)
  await choose('topic-presentation', 'cards')
  release.resolve(); await settled()
  expect(f.owner.current.focus?.topicPresentation).toBe('sections')
  expect(checked('cards')).toBe(true); expect(saveButton().disabled).toBe(false)
  await dom.click('[data-settings-save-bar] button')
  await settled()
  expect(f.owner.current.focus?.topicPresentation).toBe('cards'); expect(saveButton().disabled).toBe(true)
  expect(save.mock.calls.at(-1)?.[1]?.focus?.topicPresentation).toBe('sections')
})

it('Restore defaults previews cards and saves the enum through the same original field', async () => {
  const f = await configOwnerFixture({ focus: { recentActivityHours: 48, topicPresentation: 'sections' } })
  const { settled } = await scene(f)
  expect(checked('sections')).toBe(true); expect(collection().querySelectorAll('.focus-topic-section')).toHaveLength(2)
  await dom.click('.focus-settings__intro button')
  expect(checked('cards')).toBe(true)
  expect(collection().querySelectorAll('.focus-topic-section')).toHaveLength(0)
  expect(collection().querySelectorAll('[data-example-agent] [data-focus-topic-id]')).toHaveLength(2)
  expect(f.owner.current.focus?.topicPresentation).toBe('sections')
  await dom.click('[data-settings-save-bar] button')
  await settled()
  expect((await f.disk()).focus?.topicPresentation).toBe('cards')
})
