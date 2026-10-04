import { fixtureYear as _hygiene_fixtureYear } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { focusSettings } from '../src/main/settings/modules/focus'
import { settingsCatalog } from '../src/renderer/src/components/settings/settings-modules'
import { focusSettingsModule } from '../src/renderer/src/components/settings/modules/focus'
import { FocusSettingsPane } from '../src/renderer/src/components/settings/FocusSettingsPane'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { applyConfigEdit } from '../src/shared/config-edit'
import { resolveFocusRecentActivityHours, type FocusRecentActivityHours } from '../src/shared/focus-preferences'
import type { AppConfig } from '../src/shared/contracts'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

// Native PTY painting and an unrelated Avatar disclosure do not participate in lane ordering.
vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => null }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))

const dom = composerDOM()
const Pane = focusSettingsModule.Pane
const saveButton = () => dom.container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!
async function choose(hours: FocusRecentActivityHours) { await dom.click(`input[value="${hours}"]`) }
const checked = (hours: number) => dom.container.querySelector<HTMLInputElement>(`input[value="${hours}"]`)?.checked

it('declares a finite numeric public setting and keeps an unchanged effective default unwritten', () => {
  const setting = focusSettings[0]!
  expect(setting.entry(composerConfig)).toEqual({ key: 'focus.recentActivityHours', kind: 'number', value: 48, default: 48, enum: [12, 24, 48, 72, 168] })
  expect(setting.apply(composerConfig, '48')).toBe(composerConfig)
  for (const hours of [12, 24, 48, 72, 168] as const) {
    const next = setting.apply(composerConfig, String(hours))
    expect(setting.entry(next).value).toBe(hours)
  }
  for (const invalid of ['13', '12.0', '12e0', ' 12', '-12', 'NaN', '']) expect(() => setting.apply(composerConfig, invalid)).toThrow('Invalid value')
  expect(resolveFocusRecentActivityHours(undefined)).toBe(48)
  expect(resolveFocusRecentActivityHours('72')).toBe(48)
})

it('saves the real module with its authored baseline while merging an unrelated external change', async () => {
  let current: AppConfig = { ...composerConfig }
  const save = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => {
    current = applyConfigEdit(current, expected!, next)
    return current
  })
  await dom.render(<Pane config={current} onClose={() => {}} onNavigate={() => {}} active />)
  expect(checked(48)).toBe(true)
  await choose(72)
  current = { ...current, copyPathsAsAbsolute: true }
  useAppStore.setState({ config: current })
  await dom.render(<Pane config={current} onClose={() => {}} onNavigate={() => {}} active />)
  await dom.click('[data-settings-save-bar] button')
  expect(save).toHaveBeenCalledTimes(1)
  expect(current.focus?.recentActivityHours).toBe(72)
  expect(current.copyPathsAsAbsolute).toBe(true)
  expect(save.mock.calls[0]![1]?.focus?.recentActivityHours).toBe(48)
  expect(saveButton().disabled).toBe(true)
})

it('keeps a same-field conflicting draft and original baseline on a real config edit refusal', async () => {
  let current: AppConfig = { ...composerConfig, focus: { recentActivityHours: 24 } }
  const save = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => applyConfigEdit(current, expected!, next))
  useAppStore.setState({ config: current })
  await dom.render(<Pane config={current} onClose={() => {}} onNavigate={() => {}} active />)
  await choose(12)
  current = { ...current, focus: { recentActivityHours: 72 } }
  useAppStore.setState({ config: current })
  await dom.render(<Pane config={current} onClose={() => {}} onNavigate={() => {}} active />)
  await dom.click('[data-settings-save-bar] button')
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('focus.recentActivityHours')
  expect(checked(12)).toBe(true)
  expect(saveButton().disabled).toBe(false)
  expect(current.focus?.recentActivityHours).toBe(72)
  await dom.click('[data-settings-save-bar] button')
  expect(save.mock.calls.map(call => call[1]?.focus?.recentActivityHours)).toEqual([24, 24])
})

it('retains later choice during a pending save and only advances the submitted baseline', async () => {
  let finish!: () => void
  const onSave = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  await dom.render(<FocusSettingsPane recentActivityHours={24} onSave={onSave} />)
  await choose(12)
  await dom.click('[data-settings-save-bar] button')
  expect(saveButton().disabled).toBe(true)
  await choose(168)
  await act(async () => finish())
  expect(checked(168)).toBe(true)
  expect(saveButton().disabled).toBe(false)
  await dom.click('[data-settings-save-bar] button')
  expect(onSave.mock.calls).toEqual([[12, 24], [168, 12]])
  await act(async () => finish())
})

it('updates the actual GlobalFocusSurface for 12 and 72 hours while retaining priority, unknown and original Runs', async () => {
  const now = Date.UTC(_hygiene_fixtureYear, 9, 8, 9), hour = 3_600_000
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const ids = ['old30', 'unknown', 'mid18', 'working', 'attention', 'recent2', 'exact12']
  const workspaces = ids.map(id => ({ id, name: id, hostId: 'local', path: `/focus-window-${id}`, kind: 'folder' as const }))
  const sessions = ids.map((id, index) => {
    const base = composerSession(id)
    const state = id === 'working' ? 'working' as const : id === 'attention' ? 'waiting' as const : 'done' as const
    const status = { state, source: 'native-hook' as const, observedAt: now }
    return { ...base, workspacePath: workspaces[index]!.path, status,
      semanticStatus: { ...status, ...(id === 'unknown' ? {} : { stateEnteredAt: now - (id === 'old30' ? 30 : id === 'mid18' ? 18 : id === 'exact12' ? 12 : 2) * hour }) } }
  })
  const config = { ...composerConfig, workspaces }
  useAppStore.setState({ config, mainSurface: 'agents', sessions, timelines: {}, tabs: {}, agentNames: {},
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  await dom.render(<GlobalFocusSurface />)
  const order = () => [...dom.container.querySelectorAll<HTMLElement>('.focus-project-lanes__row')].map(row => row.dataset.projectId)
  expect(order()).toEqual(['attention', 'working', 'old30', 'mid18', 'recent2', 'exact12', 'unknown'])
  await act(async () => useAppStore.setState({ config: { ...config, focus: { recentActivityHours: 12 } } }))
  expect(order()).toEqual(['attention', 'working', 'recent2', 'exact12', 'old30', 'mid18', 'unknown'])
  await act(async () => useAppStore.setState({ config: { ...config, focus: { recentActivityHours: 72 } } }))
  expect(order()).toEqual(['attention', 'working', 'old30', 'mid18', 'recent2', 'exact12', 'unknown'])
  expect(useAppStore.getState().sessions).toBe(sessions)
  expect(useAppStore.getState().sessions.map(session => session.control.run)).toEqual(sessions.map(session => session.control.run))
  expect(dom.container.querySelector('[data-session-id="unknown"]')).not.toBeNull()
})


it('places the actual Focus contribution in the existing Work catalogue group without a Workflows alias', () => {
  const groups = settingsCatalog.navGroups('focus')
  expect(groups.length).toBeGreaterThan(0)
  const focus = groups.flatMap(group => group.items.map(item => ({ group: group.id, item }))).filter(({ item }) => item.id === 'focus')
  expect(focus).toHaveLength(1)
  expect(focus[0]?.group).toBe('work')
  expect(focus[0]?.item).toBe(focusSettingsModule)
  expect(focusSettingsModule.keywords.toLowerCase()).not.toContain('workflows')
})
