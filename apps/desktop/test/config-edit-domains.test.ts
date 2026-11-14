import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import type { ToolkitToolDefinition } from '@agentmux/core/control'
import { applyConfigEdit, ConfigConflict } from '../src/shared/config-edit.js'
import type { AppConfig } from '../src/shared/contracts.js'
import { resolveAutomationPreferences } from '../src/shared/automation-preferences.js'
import { resolveBrowserAgentControl } from '../src/shared/browser-agent-control.js'
import { resolveBrowserStartPage } from '../src/shared/browser-start-page.js'
import { resolveNotesPreferences } from '../src/shared/notes-preferences.js'
import { resolveMarkdownPreferences } from '../src/shared/markdown-preferences.js'
import { resolveGoalsCommonActions, resolveGoalsPreferences } from '@agentmux/host/goals-preferences'
import { normalizeAgentContinuityPolicy } from '@agentmux/core/agent-session-recovery'
import { resolveUserProfile } from '@agentmux/host/mote-model'
import { DEFAULT_COMPOSER_INPUT_CONFIG } from '@agentmux/client-ui/composer-input-config'
import { DEFAULT_APP_ICON } from '@agentmux/client-ui/app-icon-catalog'
import { DEFAULT_FOCUS_MAP_PREFERENCES, focusMapPreset } from '../src/shared/focus-map-preferences.js'
import { DEFAULT_PERFORMANCE_PREFERENCES, DEFAULT_MOBILE_CONNECTION_PREFERENCES } from '../src/shared/toolkit-preferences.js'

function withValue(config: AppConfig, path: string, value: unknown): AppConfig {
  const result = structuredClone(config)
  const keys = path.split('.'), leaf = keys.pop()!
  let record = result as unknown as Record<string, unknown>
  for (const key of keys) {
    record[key] ??= {}
    record = record[key] as Record<string, unknown>
  }
  if (value === undefined) delete record[leaf]
  else record[leaf] = value
  return result
}

function valueAt(config: AppConfig, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], config)
}

const sparseDomains = [
  { path: 'automation', defaults: resolveAutomationPreferences(), first: { progressIntervalMs: 60_000 }, second: { calendarTimezone: 'UTC' } },
  { path: 'browser.agentControl', defaults: resolveBrowserAgentControl(), first: { showCursor: false }, second: { showDiscussion: true } },
  { path: 'browser.startPage', defaults: resolveBrowserStartPage(), first: { title: 'Workspace' }, second: { showHistory: false } },
  { path: 'continuity', defaults: normalizeAgentContinuityPolicy(), first: { activeRecoveryDelayMs: 5000 }, second: { resumeAfterExit: false } },
  { path: 'notes', defaults: resolveNotesPreferences(undefined), first: { fontSize: 16 }, second: { contentWidth: 'wide' } },
  { path: 'markdown', defaults: resolveMarkdownPreferences(undefined), first: { readingWidth: 'wide' }, second: { readingTypeface: 'serif' } },
  { path: 'goals', defaults: resolveGoalsPreferences(undefined), first: { defaultView: 'board' }, second: { showFinished: true } },
  { path: 'appearance.channelHeaderVisibility', defaults: {}, first: { 'channel-a': false }, second: { 'channel-b': false } }
]

describe('optional preference edits', () => {
  it.each(sparseDomains)('$path saves only authored fields and preserves disjoint concurrent first edits', ({ path, defaults, first, second }) => {
    const before = withValue(DEFAULT_CONFIG, path, undefined)
    const expected = withValue(before, path, defaults)
    const after = withValue(before, path, { ...defaults, ...first })
    const submitted = JSON.stringify([before, expected, after])
    const firstSaved = applyConfigEdit(before, expected, after)
    expect(valueAt(firstSaved, path)).toEqual(first)
    const secondSaved = applyConfigEdit(firstSaved, expected, withValue(before, path, { ...defaults, ...second }))
    expect(valueAt(secondSaved, path)).toEqual({ ...first, ...second })
    expect(JSON.stringify([before, expected, after])).toBe(submitted)
    expect(secondSaved.hosts).toEqual(before.hosts)
    expect(secondSaved.executors).toEqual(before.executors)
  })

  const completeDomains = [
    { path: 'profile', defaults: resolveUserProfile(), first: { displayName: 'Ada' }, second: { about: 'Build tools' } },
    { path: 'focus', defaults: { recentActivityHours: 48, topicPresentation: 'cards' }, first: { topicPresentation: 'sections' }, second: { linkDestination: 'tab' } },
    { path: 'focus.map', defaults: DEFAULT_FOCUS_MAP_PREFERENCES, first: { boundary: 'polygon' }, second: { levels: focusMapPreset(4) } },
    { path: 'messageToolCompletion', defaults: DEFAULT_COMPOSER_INPUT_CONFIG, first: { command: null }, second: { keywords: false } },
    { path: 'goalsCommonActions', defaults: resolveGoalsCommonActions(undefined), first: { collapsed: true }, second: { items: [] } },
    { path: 'toolkit.performance', defaults: DEFAULT_PERFORMANCE_PREFERENCES, first: { enabled: false }, second: { statusBar: 'label' } },
    { path: 'toolkit.mobileConnection', defaults: DEFAULT_MOBILE_CONNECTION_PREFERENCES, first: { enabled: false }, second: { statusBar: 'label' } }
  ]

  it.each(completeDomains)('$path retains its complete value contract during concurrent first edits', ({ path, defaults, first, second }) => {
    const before = withValue(DEFAULT_CONFIG, path, undefined)
    const expected = withValue(before, path, defaults)
    const firstSaved = applyConfigEdit(before, expected, withValue(before, path, { ...defaults, ...first }))
    expect(valueAt(firstSaved, path)).toEqual({ ...defaults, ...first })
    const secondSaved = applyConfigEdit(firstSaved, expected, withValue(before, path, { ...defaults, ...second }))
    expect(valueAt(secondSaved, path)).toEqual({ ...defaults, ...first, ...second })
  })

  it('keeps A2A first edits separate from an unrelated concurrent preference', () => {
    const before = withValue(DEFAULT_CONFIG, 'a2a', undefined)
    const current = { ...before, copyPathsAsAbsolute: true }
    const saved = applyConfigEdit(current, withValue(before, 'a2a', { notifications: 'follow-global' }), withValue(before, 'a2a', { notifications: 'silent' }))
    expect(saved.a2a).toEqual({ notifications: 'silent' })
    expect(saved.copyPathsAsAbsolute).toBe(true)
  })

  it('keeps the Toolkit root, its user tools and the independent builtin preference together', () => {
    const before = withValue(DEFAULT_CONFIG, 'toolkit', undefined)
    const tool = { id: 'tool-a', revision: 'read-files', name: 'Read files', icon: 'file-text', script: 'console.log(1)',
      workspacePath: fixturePath('tool-directory'), args: [], enabled: true, statusBar: 'icon' } satisfies ToolkitToolDefinition
    const tools = withValue(before, 'toolkit', { tools: [tool] })
    const mobile = withValue(before, 'toolkit', { mobileConnection: { enabled: false, statusBar: 'label' } })
    const saved = applyConfigEdit(tools, before, mobile)
    expect(saved.toolkit).toEqual({ tools: [tool], mobileConnection: { enabled: false, statusBar: 'label' } })
    const another = { ...tool, id: 'tool-b', name: 'Read directory' }
    expect(applyConfigEdit(saved, before, withValue(before, 'toolkit', { tools: [another] })).toolkit?.tools).toEqual([tool, another])
  })

  it('merges first custom actions by identity and keeps a concurrent visibility edit', () => {
    const before = withValue(DEFAULT_CONFIG, 'agentDerivedActions', undefined)
    const action = { id: 'review-a', label: 'Review', base: 'fork', instruction: 'Review this change.' }
    const current = withValue(before, 'agentDerivedActions', { actions: [action] })
    const saved = applyConfigEdit(current, before, withValue(before, 'agentDerivedActions', { hidden: ['fork'] }))
    expect(saved.agentDerivedActions).toEqual({ actions: [action], hidden: ['fork'] })
    expect(applyConfigEdit(saved, saved, withValue(saved, 'agentDerivedActions.hidden', undefined)).agentDerivedActions).toEqual({ actions: [action] })
    expect(() => applyConfigEdit(saved, before, withValue(before, 'agentDerivedActions', { hidden: ['take-over'] }))).toThrow(ConfigConflict)
    const another = { ...action, id: 'review-b' }
    expect(applyConfigEdit(saved, before, withValue(before, 'agentDerivedActions', { actions: [another] })).agentDerivedActions).toEqual({ actions: [action, another], hidden: ['fork'] })
  })

  it('compares the absent App icon and default Focus presentation by their effective values', () => {
    const before = withValue(withValue(DEFAULT_CONFIG, 'appearance.appIcon', undefined), 'focus', undefined)
    const expected = withValue(before, 'focus', { recentActivityHours: 48, topicPresentation: 'cards' })
    const next = withValue(withValue(withValue(expected, 'appearance.appIcon', DEFAULT_APP_ICON), 'appearance.appAppearance', 'light'), 'focus.linkDestination', 'tab')
    const saved = applyConfigEdit(before, expected, next)
    expect(saved.appearance.appIcon).toBeUndefined()
    expect(saved.appearance.appAppearance).toBe('light')
    expect(saved.focus).toEqual({ recentActivityHours: 48, linkDestination: 'tab' })
  })

  it('uses the durable ConfigOwner edit path for simultaneous first Notes drafts and rejects stale same-field intent', async () => {
    const f = await configOwnerFixture({ notes: undefined })
    const before = f.owner.current
    await Promise.all([
      f.owner.edit(before, { ...before, notes: { fontSize: 16 } }),
      f.owner.edit(before, { ...before, notes: { contentWidth: 'wide' } })
    ])
    expect((await f.disk()).notes).toEqual({ fontSize: 16, contentWidth: 'wide' })
    const bytes = await f.bytes()
    await expect(f.owner.edit(before, { ...before, notes: { fontSize: 18 } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT', field: 'notes.fontSize' })
    expect(await f.bytes()).toBe(bytes)
    expect(f.publish).toHaveBeenCalledTimes(2)
  })

  it('commits map coordinates together per original Host and clears them when that Host is removed', async () => {
    const remote = { id: 'original-remote', label: 'Original remote', kind: 'ssh' as const, hostname: 'original.internal' }
    const f = await configOwnerFixture({ hosts: [...DEFAULT_CONFIG.hosts, remote] })
    const before = f.owner.current
    await Promise.all([
      f.owner.edit(before, { ...before, meshMapLocations: { local: '0, 0' } }),
      f.owner.edit(before, { ...before, meshMapLocations: { [remote.id]: '45, -90' } })
    ])
    const saved = await f.store.readSaved()
    expect(saved.hosts).toEqual(before.hosts)
    expect(saved.meshMapLocations).toEqual({ local: '0, 0', [remote.id]: '45, -90' })
    await expect(f.owner.edit(before, { ...before, meshMapLocations: { local: '4, 0' } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    await expect(f.owner.edit(saved, { ...saved, meshMapLocations: { ...saved.meshMapLocations, local: '0, 181' } })).rejects.toThrow()
    await f.owner.update(current => ({ ...current, hosts: current.hosts.filter(host => host.id !== remote.id) }))
    await expect(f.owner.edit(saved, { ...saved, meshMapLocations: { ...saved.meshMapLocations, [remote.id]: '45, -91' } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    await f.owner.update(current => ({ ...current, hosts: [...current.hosts, remote] }))
    expect((await f.disk()).meshMapLocations).toEqual({ local: '0, 0' })
  })
})
