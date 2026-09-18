// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AppearanceSettingsPane } from '../src/renderer/src/components/settings/AppearanceSettingsPane'
import { CopyPathsSettingsPane } from '../src/renderer/src/components/settings/CopyPathsSettingsPane'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { applyConfigEdit } from '../src/shared/config-edit'
import { TERMINAL_FONT_SIZE_DEFAULT, type AppearanceConfig } from '../src/shared/contracts'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const initial: AppearanceConfig = { terminalTheme: 'graphite', appAppearance: 'dark' }
function mode(name: string) {
  const input = [...dom.container.querySelectorAll<HTMLInputElement>('[aria-label="Application appearance"] input[type="radio"]')]
    .find((node) => node.getAttribute('aria-label') === name)
  if (!input) throw new Error(`Missing appearance choice: ${name}`)
  return input
}
async function choose(name: string) { await act(async () => mode(name).click()) }
const selected = (name: string) => String(mode(name).checked)
const saveButton = () => dom.container.querySelector<HTMLButtonElement>('.settings-pane-actions button')!

describe('Settings drafts across external commits', () => {
  it('refreshes clean fields, keeps dirty fields and saves only authored intent against the original baseline', async () => {
    const onSave = vi.fn(async () => {})
    await dom.render(<AppearanceSettingsPane appearance={initial} onSave={onSave} />)
    await choose('Light')
    const external = { ...initial, terminalFontSize: 21 }
    await dom.render(<AppearanceSettingsPane appearance={external} onSave={onSave} />)
    expect(selected('Light')).toBe('true')
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Terminal font size in pixels"]')?.value).toBe('21')
    expect(saveButton().disabled).toBe(false)
    await dom.click('.settings-pane-actions button')
    expect(onSave).toHaveBeenCalledWith(
      { ...external, appAppearance: 'light' },
      { ...external, appAppearance: 'dark' }
    )
  })

  it('reports a real same-field conflict and keeps the draft and its original expected value for retry', async () => {
    let current = { ...composerConfig, appearance: initial }
    const onSave = vi.fn(async (appearance: AppearanceConfig, expected: AppearanceConfig) => {
      current = applyConfigEdit(current, { ...current, appearance: expected }, { ...current, appearance })
    })
    await dom.render(<AppearanceSettingsPane appearance={current.appearance} onSave={onSave} />)
    await choose('Light')
    current = { ...current, appearance: { ...initial, appAppearance: 'system' } }
    await dom.render(<AppearanceSettingsPane appearance={current.appearance} onSave={onSave} />)
    await dom.click('.settings-pane-actions button')
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('appearance.appAppearance')
    expect(selected('Light')).toBe('true')
    expect(saveButton().disabled).toBe(false)
    expect(current.appearance.appAppearance).toBe('system')
    await dom.click('.settings-pane-actions button')
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(onSave.mock.calls.map(([, expected]) => expected.appAppearance)).toEqual(['dark', 'dark'])
  })

  it('keeps failed Appearance drafts and the original baseline until a successful durable save', async () => {
    const onSave = vi.fn(async () => {}).mockRejectedValueOnce(new Error('disk full'))
    await dom.render(<AppearanceSettingsPane appearance={initial} onSave={onSave} />)
    await choose('Light')
    await dom.click('.settings-pane-actions button')
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toBe('disk full')
    expect(selected('Light')).toBe('true')
    expect(saveButton().disabled).toBe(false)
    await dom.click('.settings-pane-actions button')
    expect(onSave).toHaveBeenLastCalledWith(
      { ...initial, appAppearance: 'light', terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT },
      { ...initial, terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT }
    )
    expect(saveButton().disabled).toBe(true)
  })

  it('preserves edits made while a previous save is pending', async () => {
    let finish!: () => void
    const onSave = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    await dom.render(<AppearanceSettingsPane appearance={initial} onSave={onSave} />)
    await choose('Light')
    await dom.click('.settings-pane-actions button')
    expect(saveButton().disabled).toBe(true)
    await choose('System')
    await act(async () => finish())
    expect(selected('System')).toBe('true')
    expect(saveButton().disabled).toBe(false)
    await dom.click('.settings-pane-actions button')
    expect(onSave.mock.calls[1]).toEqual([
      { ...initial, appAppearance: 'system', terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT },
      { ...initial, appAppearance: 'light', terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT }
    ])
    await act(async () => finish())
  })

  it('refreshes a now-clean appearance draft after local undo reaches its old baseline', async () => {
    const onSave = vi.fn(async () => {})
    await dom.render(<AppearanceSettingsPane appearance={initial} onSave={onSave} />)
    await choose('Light')
    await dom.render(<AppearanceSettingsPane appearance={{ ...initial, appAppearance: 'system' }} onSave={onSave} />)
    await choose('Dark')
    expect(selected('System')).toBe('true')
    expect(saveButton().disabled).toBe(true)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('preserves an edit back to the old appearance baseline while a save is pending', async () => {
    let finish!: () => void
    const onSave = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    await dom.render(<AppearanceSettingsPane appearance={initial} onSave={onSave} />)
    await choose('Light')
    await dom.click('.settings-pane-actions button')
    expect(onSave).toHaveBeenCalledOnce()
    await choose('Dark')
    await dom.render(<AppearanceSettingsPane appearance={{ ...initial, appAppearance: 'light' }} onSave={onSave} />)
    await act(async () => finish())
    expect(selected('Dark')).toBe('true')
    expect(saveButton().disabled).toBe(false)
    await dom.click('.settings-pane-actions button')
    expect(onSave.mock.calls[1]).toEqual([
      { ...initial, terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT },
      { ...initial, appAppearance: 'light', terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT }
    ])
    await act(async () => finish())
  })

  it('updates a clean Copy Paths field from a CLI commit', async () => {
    const onSave = vi.fn(async () => {})
    await dom.render(<CopyPathsSettingsPane copyPathsAsAbsolute={false} onSave={onSave} />)
    await dom.render(<CopyPathsSettingsPane copyPathsAsAbsolute={true} onSave={onSave} />)
    expect(dom.container.querySelector<HTMLInputElement>('[type="checkbox"]')?.checked).toBe(true)
    expect(saveButton().disabled).toBe(true)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('refreshes a now-clean Copy Paths draft after local undo reaches its old baseline', async () => {
    const onSave = vi.fn(async () => {})
    await dom.render(<CopyPathsSettingsPane copyPathsAsAbsolute={false} onSave={onSave} />)
    await dom.click('[type="checkbox"]')
    await dom.render(<CopyPathsSettingsPane copyPathsAsAbsolute={true} onSave={onSave} />)
    await dom.click('[type="checkbox"]')
    expect(dom.container.querySelector<HTMLInputElement>('[type="checkbox"]')?.checked).toBe(true)
    expect(saveButton().disabled).toBe(true)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('preserves an edit back to the old Copy Paths baseline while a save is pending', async () => {
    let finish!: () => void
    const onSave = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    await dom.render(<CopyPathsSettingsPane copyPathsAsAbsolute={false} onSave={onSave} />)
    await dom.click('[type="checkbox"]')
    await dom.click('.settings-pane-actions button')
    expect(onSave).toHaveBeenCalledOnce()
    await dom.click('[type="checkbox"]')
    await dom.render(<CopyPathsSettingsPane copyPathsAsAbsolute={true} onSave={onSave} />)
    await act(async () => finish())
    expect(dom.container.querySelector<HTMLInputElement>('[type="checkbox"]')?.checked).toBe(false)
    expect(saveButton().disabled).toBe(false)
    await dom.click('.settings-pane-actions button')
    expect(onSave.mock.calls[1]).toEqual([false, true])
    await act(async () => finish())
  })

  it('does not silently accept a matching external boolean commit as the user’s successful save', async () => {
    const onSave = vi.fn(async () => {})
    await dom.render(<CopyPathsSettingsPane copyPathsAsAbsolute={undefined} onSave={onSave} />)
    await dom.click('[type="checkbox"]')
    await dom.render(<CopyPathsSettingsPane copyPathsAsAbsolute={true} onSave={onSave} />)
    expect(saveButton().disabled).toBe(false)
    await dom.click('.settings-pane-actions button')
    expect(onSave).toHaveBeenCalledWith(true, false)
    expect(saveButton().disabled).toBe(true)
  })

  it('keeps Copy Paths checked after a failed save and retries with the same baseline', async () => {
    const onSave = vi.fn(async () => {}).mockRejectedValueOnce(new Error('disk full'))
    await dom.render(<CopyPathsSettingsPane copyPathsAsAbsolute={false} onSave={onSave} />)
    await dom.click('[type="checkbox"]')
    await dom.click('.settings-pane-actions button')
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toBe('disk full')
    expect(dom.container.querySelector<HTMLInputElement>('[type="checkbox"]')?.checked).toBe(true)
    expect(saveButton().disabled).toBe(false)
    await dom.click('.settings-pane-actions button')
    expect(onSave.mock.calls).toEqual([[true, false], [true, false]])
    expect(saveButton().disabled).toBe(true)
  })

  it('does not replace a newer committed Store fact with a delayed successful save receipt', async () => {
    const baseline = { ...composerConfig, appearance: initial, copyPathsAsAbsolute: false }
    useAppStore.setState({ config: baseline })
    let finish!: (config: typeof baseline) => void
    const save = vi.spyOn(api.config, 'save').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await dom.render(<SettingsPanel initialSection="appearance" onClose={() => {}} />)
    await choose('Light')
    const appearanceSave = dom.container.querySelector<HTMLButtonElement>('[data-settings-pane="appearance"] .settings-pane-actions button')!
    await act(async () => appearanceSave.click())
    expect(save).toHaveBeenCalledTimes(1)
    const later = { ...baseline, appearance: { ...initial, appAppearance: 'system' as const }, copyPathsAsAbsolute: true }
    // App's ordered Main commit subscription already delivered a later CLI commit.
    await act(async () => useAppStore.getState().setConfig(later))
    await act(async () => finish({ ...baseline, appearance: { ...initial, appAppearance: 'light' } }))
    expect(useAppStore.getState().config).toEqual(later)
  })

  it('does not let a delayed startup get replace a newer Main commit in the Store', async () => {
    const baseline = { ...composerConfig, appearance: initial, copyPathsAsAbsolute: false }
    useAppStore.setState({ config: baseline, loading: true, restoredWorkbench: null, warmTerminal: null })
    let finish!: (config: typeof baseline) => void
    vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
    const read = vi.spyOn(api.config, 'get').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.demands, 'list').mockResolvedValue([])
    const startup = useAppStore.getState().initialize()
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    const committed = { ...baseline, appearance: { ...initial, appAppearance: 'system' as const }, copyPathsAsAbsolute: true }
    useAppStore.getState().setConfig(committed)
    finish(baseline)
    const dispose = await startup
    try {
      expect(useAppStore.getState().loading).toBe(false)
      expect(useAppStore.getState().config).toEqual(committed)
    } finally { dispose() }
  })

  it('keeps known Executor and Host diagnostics when an ordinary setting commits', () => {
    const diagnostics = { codex: { state: 'ready' as const, detail: 'Known available', observedAt: 123 } }
    const checks = { local: { state: 'ready' as const, detail: 'Known healthy', observedAt: 123 } }
    useAppStore.setState({ config: composerConfig, executorDetections: diagnostics, hostChecks: checks })
    useAppStore.getState().setConfig({ ...composerConfig, copyPathsAsAbsolute: true,
      appearance: { ...composerConfig.appearance, appAppearance: 'light' } })
    expect(useAppStore.getState().executorDetections).toEqual(diagnostics)
    expect(useAppStore.getState().hostChecks).toEqual(checks)
    expect(useAppStore.getState().sessions).toEqual([expect.objectContaining({ id: 'agent-1', processState: 'running' })])
    useAppStore.getState().setConfig({ ...composerConfig, executors: {
      ...composerConfig.executors, codex: { ...composerConfig.executors.codex!, command: '/different/codex' }
    } })
    expect(useAppStore.getState().executorDetections).toEqual({})
    expect(useAppStore.getState().hostChecks).toEqual({})
  })
})
