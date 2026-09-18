// @vitest-environment happy-dom
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { AppearanceSettingsPane } from '../src/renderer/src/components/settings/AppearanceSettingsPane'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX, type AppearanceConfig } from '../src/shared/contracts'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const appearance = { terminalTheme: 'graphite' as const, appAppearance: 'dark' as const, terminalFontSize: 12 }
const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'font-draft-test' } as const
const numeric = () => dom.container.querySelector<HTMLInputElement>('[aria-label="Terminal font size in pixels"]')!
const range = () => dom.container.querySelector<HTMLInputElement>('[aria-label="Terminal font size"]')!
const save = () => dom.container.querySelector<HTMLButtonElement>('.settings-pane-actions button')!

async function enter(value: string, input = numeric()) {
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function ownerConsumer() {
  const fixture = await configOwnerFixture({ appearance })
  const publish = fixture.publish.getMockImplementation()!
  fixture.publish.mockImplementation((config) => { publish(config); useAppStore.getState().setConfig(config) })
  useAppStore.setState({ config: fixture.owner.current })
  const uiSave = vi.spyOn(api.config, 'save').mockImplementation((next, expected) => fixture.owner.edit(expected, next))
  await dom.render(<SettingsPanel initialSection="appearance" onClose={() => {}} />)
  return { ...fixture, uiSave }
}

async function commit(fixture: Awaited<ReturnType<typeof ownerConsumer>>) {
  await dom.click('.settings-pane-actions button')
  await act(async () => { await fixture.uiSave.mock.results.at(-1)!.value })
}

describe('font editing on actual settings consumers', () => {
  it('keeps empty and first-digit text editable while the range projects the legal expectation', async () => {
    const onSave = vi.fn(async () => {})
    await dom.render(<AppearanceSettingsPane appearance={appearance} onSave={onSave} />)
    await enter('')
    expect(numeric().value).toBe('')
    expect(range().value).toBe('12')
    await enter('1')
    expect(numeric().value).toBe('1')
    expect(range().value).toBe('12')
    await enter('14')
    expect(numeric().value).toBe('14')
    expect(range().value).toBe('14')
    await enter(String(TERMINAL_FONT_SIZE_MAX), range())
    expect(numeric().value).toBe(String(TERMINAL_FONT_SIZE_MAX))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('saves a legal raw draft as a number through SettingsPanel and the real durable owner', async () => {
    const f = await ownerConsumer()
    await enter('14')
    await commit(f)
    expect(f.uiSave).toHaveBeenCalledTimes(1)
    expect(f.uiSave.mock.calls[0]![0].appearance.terminalFontSize).toBe(14)
    expect(f.uiSave.mock.calls[0]![1].appearance.terminalFontSize).toBe(12)
    expect((await f.disk()).appearance.terminalFontSize).toBe(14)
    expect(numeric().value).toBe('14')
    expect(save().disabled).toBe(true)
    expect(f.publish).toHaveBeenCalledTimes(1)
  })

  it.each(['', ' ', '8.5', String(TERMINAL_FONT_SIZE_MIN - 1), String(TERMINAL_FONT_SIZE_MAX + 1)])(
    'rejects invalid raw %j before any owner or runtime operation and keeps the draft', async (raw) => {
      const f = await ownerConsumer()
      const bytes = await f.bytes()
      await enter(raw)
      const browserRaw = numeric().value
      await dom.click('.settings-pane-actions button')
      expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain(`from ${TERMINAL_FONT_SIZE_MIN} to ${TERMINAL_FONT_SIZE_MAX}`)
      expect(numeric().value).toBe(browserRaw)
      expect(range().value).toBe('12')
      expect(save().disabled).toBe(false)
      expect(f.uiSave).not.toHaveBeenCalled()
      expect(f.save).not.toHaveBeenCalled()
      expect(f.runtime.prepare).not.toHaveBeenCalled()
      expect(f.publish).not.toHaveBeenCalled()
      expect(await f.bytes()).toBe(bytes)
      await enter('14')
      await commit(f)
      expect(f.uiSave).toHaveBeenCalledTimes(1)
      expect(f.uiSave.mock.calls[0]![1].appearance.terminalFontSize).toBe(12)
      expect((await f.disk()).appearance.terminalFontSize).toBe(14)
    }
  )

  it('validates before marking other clean fields as saving, so external commits still refresh them', async () => {
    const onSave = vi.fn(async () => {})
    await dom.render(<AppearanceSettingsPane appearance={appearance} onSave={onSave} />)
    await enter('')
    await dom.click('.settings-pane-actions button')
    await dom.render(<AppearanceSettingsPane appearance={{ ...appearance, appAppearance: 'system', terminalFontSize: 20 }} onSave={onSave} />)
    expect(numeric().value).toBe('')
    expect(range().value).toBe('12')
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Application appearance"] input[type="radio"]:checked')?.getAttribute('aria-label')).toBe('System')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('follows a clean CLI font commit and preserves a dirty raw value and original expectation on a three-value conflict', async () => {
    const f = await ownerConsumer()
    await act(async () => { await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'appearance.terminalFontSize', value: '14' }, f.owner) })
    expect(numeric().value).toBe('14')
    expect(save().disabled).toBe(true)
    await enter('')
    await act(async () => { await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'appearance.terminalFontSize', value: '18' }, f.owner) })
    expect(numeric().value).toBe('')
    expect(range().value).toBe('14')
    await enter('20')
    const bytes = await f.bytes(), publications = f.publish.mock.calls.length
    await dom.click('.settings-pane-actions button')
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('appearance.terminalFontSize')
    expect(numeric().value).toBe('20')
    expect(save().disabled).toBe(false)
    expect(f.uiSave).toHaveBeenCalledTimes(1)
    expect(f.uiSave.mock.calls[0]![1].appearance.terminalFontSize).toBe(14)
    expect(await f.bytes()).toBe(bytes)
    expect(f.publish).toHaveBeenCalledTimes(publications)
  })

  it('keeps a failed raw draft and its original numeric expectation until a real successful retry', async () => {
    const f = await ownerConsumer()
    await enter('14')
    f.save.mockRejectedValueOnce(new Error('disk full'))
    const bytes = await f.bytes()
    await dom.click('.settings-pane-actions button')
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toBe('disk full')
    expect(numeric().value).toBe('14')
    expect(await f.bytes()).toBe(bytes)
    expect(f.publish).not.toHaveBeenCalled()
    await commit(f)
    expect(f.uiSave.mock.calls.map(([, expected]) => expected.appearance.terminalFontSize)).toEqual([12, 12])
    expect((await f.disk()).appearance.terminalFontSize).toBe(14)
    expect(numeric().value).toBe('14')
    expect(save().disabled).toBe(true)
  })

  it('preserves a later incomplete edit through an earlier save publication and successful reply', async () => {
    let finish!: () => void
    const onSave = vi.fn<(next: AppearanceConfig, expected: AppearanceConfig) => Promise<void>>()
      .mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    await dom.render(<AppearanceSettingsPane appearance={appearance} onSave={onSave} />)
    await enter('14')
    await dom.click('.settings-pane-actions button')
    await enter('')
    await enter('1')
    await dom.render(<AppearanceSettingsPane appearance={{ ...appearance, terminalFontSize: 14 }} onSave={onSave} />)
    await act(async () => finish())
    expect(numeric().value).toBe('1')
    expect(range().value).toBe('14')
    expect(save().disabled).toBe(false)
    await enter('16')
    await dom.click('.settings-pane-actions button')
    expect(onSave.mock.calls.map(([next, expected]) => [next.terminalFontSize, expected.terminalFontSize])).toEqual([[14, 12], [16, 14]])
    await act(async () => finish())
  })
})
