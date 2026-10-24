import { fixtureEpoch as _batchFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: () => <textarea /> }))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { GitHistoryPanel } from '../src/renderer/src/features/git/history/GitHistoryPanel'
import { useGitHistory } from '../src/renderer/src/features/git/history/useGitHistory'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { GitHistoryResult } from '../src/shared/git-contracts'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { installGitHistoryViewport } from './helpers/git-history-viewport'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { executeSettingsControl } from '../src/main/settings-control'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'

const dom = composerDOM()
const originalBridge = Object.getOwnPropertyDescriptor(window, 'agentmux')
const workspace = composerConfig.workspaces[0]!
const oid = (index: number) => index.toString(16).padStart(40, '0')
const authoredAt = _batchFixtureEpoch(20277, 0, 48420000)
const result: GitHistoryResult = { kind: 'ready', snapshot: { hostId: 'local', repoPath: workspace.path, selectedRef: null,
  roots: [oid(0)], refs: [], checkedAt: authoredAt + 1 }, nextCursor: null,
commits: Array.from({ length: 100 }, (_, index) => ({ oid: oid(index), subject: `Commit ${index}`, author: 'Recorded author',
  authoredAt: index === 10 ? null : index === 11 ? Number.NaN : authoredAt, parents: index < 99 ? [oid(index + 1)] : [], refs: [] })) }
let history: ReturnType<typeof vi.fn>
let controls: ReturnType<typeof useGitHistory>
function ReadingSurface() {
  controls = useGitHistory(workspace, true)
  return <><SettingsPanel initialSection="space" onClose={() => {}} />
    <GitHistoryPanel workspace={workspace} history={controls} selectedOid={oid(10)} onSelectCommit={() => {}} /></>
}
const checkbox = () => dom.container.querySelector<HTMLInputElement>('[aria-label="Show commit time"]')!
const times = () => dom.container.querySelectorAll('.git-history-commit .git-history-time')
const scroll = () => dom.container.querySelector<HTMLDivElement>('.git-history-scroll')!
const save = () => dom.click('[data-settings-pane="space"] [data-settings-save-bar] button')
beforeEach(() => {
  installGitHistoryViewport()
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2400)
  history = vi.fn().mockResolvedValue(result)
  Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: { history } } })
})
afterEach(() => {
  if (originalBridge) Object.defineProperty(window, 'agentmux', originalBridge)
  else Reflect.deleteProperty(window, 'agentmux')
})

it('saves commit-time preference through the durable owner and changes the live tree without losing its reading state', async () => {
  const fixture = await configOwnerFixture(composerConfig)
  useAppStore.setState({ config: fixture.owner.current })
  const write = vi.spyOn(api.config, 'save').mockImplementation((next, expected) => fixture.owner.edit(expected!, next))
  await dom.render(<ReadingSurface />)
  expect(checkbox().checked).toBe(true)
  expect(times().length).toBeGreaterThan(0)
  const known = dom.container.querySelector<HTMLTimeElement>('.git-history-commit time')!
  expect(known.dateTime).toBe(new Date(authoredAt).toISOString())
  expect(known.title).toBe(`Author time · ${new Date(authoredAt).toLocaleString()} (local time)`)
  expect(known.textContent).toMatch(/\d/)
  expect([...times()].filter(node => node.textContent === 'Time unknown')).toHaveLength(2)
  expect([...times()].filter(node => node.textContent === 'Time unknown').map(node => node.tagName)).toEqual(['SPAN', 'SPAN'])
  const before = controls.result, host = scroll()
  await act(async () => { host.scrollTop = 240; host.dispatchEvent(new Event('scroll')) })
  const selected = dom.container.querySelector('[aria-current="true"][data-history-oid]')
  expect(selected).not.toBeNull()
  await dom.click('[aria-label="Show commit time"]')
  await fixture.owner.update(current => ({ ...current, copyPathsAsAbsolute: true }))
  await act(async () => useAppStore.setState({ config: fixture.owner.current }))
  await save()
  expect(write).toHaveBeenCalledTimes(1)
  expect(write.mock.calls[0]![1]?.gitHistoryShowTime).toBe(true)
  await act(async () => { await write.mock.results[0]!.value })
  expect(fixture.owner.current.gitHistoryShowTime).toBe(false)
  expect((await fixture.disk()).gitHistoryShowTime).toBe(false)
  expect(useAppStore.getState().config?.gitHistoryShowTime).toBe(false)
  expect(useAppStore.getState().config?.copyPathsAsAbsolute).toBe(true)
  expect(times()).toHaveLength(0)
  expect(scroll()).toBe(host)
  expect(host.scrollTop).toBe(240)
  expect(dom.container.querySelector('[aria-current="true"][data-history-oid]')).toBe(selected)
  expect(controls.result).toBe(before)
  expect(controls.reference).toBeNull()
  expect(history).toHaveBeenCalledTimes(1)
})

it('retains a failed time draft and original expectation while the committed tree stays readable', async () => {
  const write = vi.spyOn(api.config, 'save').mockRejectedValueOnce(new Error('Controlled durable save failed'))
    .mockImplementation(async next => next)
  await dom.render(<ReadingSurface />)
  await dom.click('[aria-label="Show commit time"]')
  await save()
  expect(checkbox().checked).toBe(false)
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('Controlled durable save failed')
  expect(times().length).toBeGreaterThan(0)
  await save()
  expect(write.mock.calls.map(call => call[1]?.gitHistoryShowTime)).toEqual([true, true])
  expect(times()).toHaveLength(0)
})

it('keeps a delayed save receipt from replacing newer committed settings', async () => {
  let finish!: (config: typeof composerConfig) => void
  const write = vi.spyOn(api.config, 'save').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await dom.render(<ReadingSurface />)
  await dom.click('[aria-label="Show commit time"]'); await save()
  const newer = { ...composerConfig, gitHistoryShowTime: false, copyPathsAsAbsolute: true }
  await act(async () => useAppStore.setState({ config: newer }))
  await act(async () => finish(write.mock.calls[0]![0]))
  expect(useAppStore.getState().config).toBe(newer)
  expect(times()).toHaveLength(0)
})

it('uses the existing settings owner for default, persistent CLI edits and authored default comparisons', async () => {
  const fixture = await configOwnerFixture(composerConfig)
  const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'git-history-time' } as const
  const initial = await fixture.bytes()
  expect(fixture.owner.current.gitHistoryShowTime).toBeUndefined()
  const settings = await executeSettingsControl({ ...envelope, operation: 'settings.get' }, fixture.owner)
  expect(settings.operation === 'settings.get' && settings.entries.find(entry => entry.key === 'gitHistoryShowTime'))
    .toEqual({ key: 'gitHistoryShowTime', kind: 'boolean', value: true, default: true })
  await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'gitHistoryShowTime', value: 'true' }, fixture.owner)
  expect(await fixture.bytes()).toBe(initial)
  await fixture.owner.edit(fixture.owner.current, { ...fixture.owner.current, gitHistoryShowTime: true })
  expect(await fixture.bytes()).toBe(initial)
  const before = fixture.owner.current
  await fixture.owner.edit({ ...before, projectRailDensity: 'default', gitHistoryShowTime: true },
    { ...before, projectRailDensity: 'dense', gitHistoryShowTime: true })
  expect(fixture.owner.current.gitHistoryShowTime).toBeUndefined()
  expect((await fixture.disk()).gitHistoryShowTime).toBeUndefined()
  const saved = await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'gitHistoryShowTime', value: 'false' }, fixture.owner)
  expect(saved).toMatchObject({ operation: 'settings.set', entry: { key: 'gitHistoryShowTime', value: false } })
  expect((await fixture.store.get()).gitHistoryShowTime).toBe(false)
  await expect(fixture.store.save({ ...fixture.owner.current, gitHistoryShowTime: 'false' } as never)).rejects.toThrow()
})
