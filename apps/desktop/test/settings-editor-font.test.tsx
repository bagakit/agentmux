// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { composerDOM } from './helpers/composer-dom-fixture'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { GitDiffCanvas } from '../src/renderer/src/components/GitDiffCanvas'
import { useEditorTypography } from '../src/renderer/src/hooks/useEditorTypography'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { ConfigStore } from '../src/main/config-store.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import type { AppearanceConfig } from '../src/shared/contracts'

const mounted = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  widgets: [] as Array<{ updateOptions: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; selection: { line: number; column: number } }>,
  models: [] as Array<{ getValue(): string; getLanguageId(): string; setValue: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>
}))
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('monaco-editor', () => ({
  Uri: { parse: (value: string) => ({ value }) },
  editor: {
    createModel: (value: string, language: string) => {
      const model = { getValue: () => value, getLanguageId: () => language, setValue: vi.fn(), dispose: vi.fn() }
      mounted.models.push(model); return model
    },
    createDiffEditor: (_host: HTMLElement, options: Record<string, unknown>) => {
      mounted.options.push(options)
      const widget = { updateOptions: vi.fn(), dispose: vi.fn(), selection: { line: 2, column: 4 },
        setModel: vi.fn(), createViewModel: vi.fn(() => ({ dispose: vi.fn() })) }
      mounted.widgets.push(widget); return widget
    },
    setModelLanguage: vi.fn(), setTheme: vi.fn()
  }
}))

const dom = composerDOM()
const initialAppearance: AppearanceConfig = { appAppearance: 'dark', terminalTheme: 'graphite', terminalFontSize: 18,
  agentAvatars: { 'font-test-agent': { tint: '#123456' } } }
const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'editor-font-owning' } as const
const saveSelector = '[data-settings-pane="appearance"] [data-settings-save-bar] button'
let stylesheet: HTMLStyleElement
beforeEach(() => {
  stylesheet = document.createElement('style')
  stylesheet.textContent = readFileSync('apps/desktop/src/renderer/src/styles/tokens.css', 'utf8')
  document.head.append(stylesheet)
})
afterEach(() => {
  stylesheet.remove(); document.documentElement.style.removeProperty('--fs-body')
  mounted.options.splice(0); mounted.widgets.splice(0); mounted.models.splice(0)
})
function TypographyConsumer() {
  const typography = useEditorTypography()
  return <output aria-label="Editor typography">{typography.fontSize}:{typography.lineHeight}</output>
}
function Consumers() {
  return <><SettingsPanel initialSection="appearance" onClose={() => {}} /><TypographyConsumer />
    <GitDiffCanvas wordWrap={false} language="typescript" theme="vs-dark" diff={{ loading: false, error: null,
      diff: { path: 'app.ts', binary: false, change: 'modified', old: { present: true, binary: false, text: 'const n = 1' }, new: { present: true, binary: false, text: 'const n = 2' } } }} /></>
}
const numeric = () => dom.container.querySelector<HTMLInputElement>('[aria-label="Editor font size in pixels"]')!
const inherit = () => dom.container.querySelector<HTMLInputElement>('[aria-label="Use App font size"]')!
const save = () => dom.container.querySelector<HTMLButtonElement>(saveSelector)!
const typography = () => dom.container.querySelector('[aria-label="Editor typography"]')!.textContent
async function enter(value: string) {
  expect(numeric()).not.toBeNull(); expect(numeric().disabled).toBe(false)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(numeric(), value)
    numeric().dispatchEvent(new Event('input', { bubbles: true }))
    numeric().dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function ownerConsumer(appearance = initialAppearance) {
  const fixture = await configOwnerFixture({ appearance })
  const publish = fixture.publish.getMockImplementation()!
  fixture.publish.mockImplementation((config) => { publish(config); useAppStore.getState().setConfig(config) })
  useAppStore.setState({ config: fixture.owner.current })
  const uiSave = vi.spyOn(api.config, 'save').mockImplementation((next, expected) => fixture.owner.edit(expected, next))
  await dom.render(<Consumers />)
  return { ...fixture, uiSave }
}
async function commit(fixture: Awaited<ReturnType<typeof ownerConsumer>>) {
  await dom.click(saveSelector)
  await act(async () => { await fixture.uiSave.mock.results.at(-1)!.value })
}
async function cli(fixture: Awaited<ReturnType<typeof ownerConsumer>>, value: string) {
  let receipt: Awaited<ReturnType<typeof executeSettingsControl>> | undefined
  await act(async () => { receipt = await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'appearance.editorFontSize', value }, fixture.owner) })
  return receipt!
}

describe('Editor font settings on the real UI, durable owner, public scalar and mounted Diff', () => {
  it('inherits the actual App token without writing a default and creates the Diff at that size', async () => {
    const f = await ownerConsumer()
    expect(getComputedStyle(document.documentElement).getPropertyValue('--fs-body')).toBe('12px')
    expect(typography()).toBe('12:18')
    expect(inherit().checked).toBe(true); expect(numeric().disabled).toBe(true)
    expect(Object.hasOwn((await f.disk()).appearance, 'editorFontSize')).toBe(false)
    expect(mounted.options).toHaveLength(1)
    expect(mounted.options[0]).toMatchObject({ fontSize: 12, lineHeight: 18 })
    expect(mounted.models).toHaveLength(2)
    const bytes = await f.bytes()
    document.documentElement.style.setProperty('--fs-body', '15px')
    await dom.render(<Consumers />)
    expect(typography()).toBe('15:23')
    expect(mounted.widgets[0]!.updateOptions).toHaveBeenLastCalledWith({ fontSize: 15, lineHeight: 23 })
    expect(mounted.widgets).toHaveLength(1); expect(mounted.models).toHaveLength(2)
    expect(await f.bytes()).toBe(bytes); expect(f.save).not.toHaveBeenCalled()
  })

  it('saves a number through Appearance UI, restores from disk and resets to inheritance without replacing models', async () => {
    const f = await ownerConsumer()
    const widget = mounted.widgets[0]!, models = [...mounted.models]
    await dom.click('[aria-label="Use App font size"]'); expect(numeric().value).toBe('12')
    await enter('20'); await commit(f)
    expect(f.uiSave.mock.calls[0]![0].appearance.editorFontSize).toBe(20)
    expect(f.uiSave.mock.calls[0]![1].appearance.editorFontSize).toBeUndefined()
    expect((await new ConfigStore(f.store.filePath).get()).appearance).toEqual({ ...initialAppearance, editorFontSize: 20 })
    expect(typography()).toBe('20:30')
    expect(widget.updateOptions).toHaveBeenLastCalledWith({ fontSize: 20, lineHeight: 30 })
    expect(save().disabled).toBe(true)
    await dom.click('[data-settings-pane="appearance"] button.small-button'); await commit(f)
    expect(Object.hasOwn((await f.disk()).appearance, 'editorFontSize')).toBe(false)
    expect((await f.disk()).appearance).toEqual(initialAppearance)
    expect(f.uiSave.mock.calls[1]![1].appearance.editorFontSize).toBe(20)
    expect(typography()).toBe('12:18'); expect(inherit().checked).toBe(true)
    expect(widget.updateOptions).toHaveBeenLastCalledWith({ fontSize: 12, lineHeight: 18 })
    expect(mounted.widgets).toEqual([widget]); expect(mounted.models).toEqual(models)
    expect(widget.selection).toEqual({ line: 2, column: 4 })
    expect(widget.dispose).not.toHaveBeenCalled(); for (const model of models) expect(model.dispose).not.toHaveBeenCalled()
  })

  it('reports inherit through the public directory, follows clean numeric CLI commits and removes the field on CLI reset', async () => {
    const f = await ownerConsumer()
    const directory = await executeSettingsControl({ ...envelope, operation: 'settings.get', target: 'appearance.editorFontSize' }, f.owner)
    expect(directory).toMatchObject({ operation: 'settings.get', entries: [{ kind: 'string', value: 'inherit', default: 'inherit' }] })
    if (directory.operation !== 'settings.get') throw new Error('Expected settings.get')
    expect(directory.entries[0]!.enum).toEqual(['inherit', ...Array.from({ length: 25 }, (_, index) => String(index + 8))])
    expect(await cli(f, '8')).toMatchObject({ entry: { value: '8' } }); expect(typography()).toBe('8:12')
    expect(await cli(f, '32')).toMatchObject({ entry: { value: '32' } }); expect(typography()).toBe('32:48')
    expect(numeric().value).toBe('32'); expect(save().disabled).toBe(true)
    expect(await cli(f, 'inherit')).toMatchObject({ entry: { value: 'inherit' } })
    expect(inherit().checked).toBe(true); expect(typography()).toBe('12:18')
    expect((await new ConfigStore(f.store.filePath).get()).appearance).toEqual(initialAppearance)
    expect(f.uiSave).not.toHaveBeenCalled()
    const bytes = await f.bytes(), writes = f.save.mock.calls.length
    await cli(f, 'inherit'); expect(await f.bytes()).toBe(bytes); expect(f.save).toHaveBeenCalledTimes(writes)
  })

  it.each(['', '7', '8.5', '33'])('keeps illegal UI draft %j without persistence and accepts a corrected retry', async raw => {
    const f = await ownerConsumer()
    await dom.click('[aria-label="Use App font size"]'); await enter(raw)
    const draft = numeric().value, bytes = await f.bytes()
    await dom.click(saveSelector)
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('Editor font size must be a whole number from 8 to 32')
    expect(numeric().value).toBe(draft); expect(save().disabled).toBe(false)
    expect(f.uiSave).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled(); expect(f.runtime.prepare).not.toHaveBeenCalled()
    expect(await f.bytes()).toBe(bytes); expect(typography()).toBe('12:18')
    await enter('16'); await commit(f)
    expect(f.uiSave.mock.calls[0]![1].appearance.editorFontSize).toBeUndefined()
    expect((await f.disk()).appearance).toEqual({ ...initialAppearance, editorFontSize: 16 })
  })

  it.each(['7', '33', '8.5', 'NaN', 'inherit '])('rejects illegal CLI scalar %j without changing unrelated preferences', async value => {
    const f = await ownerConsumer()
    const bytes = await f.bytes()
    await expect(executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'appearance.editorFontSize', value }, f.owner)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
    expect(await f.bytes()).toBe(bytes); expect(f.publish).not.toHaveBeenCalled(); expect(f.runtime.prepare).not.toHaveBeenCalled()
    expect((await f.disk()).appearance).toEqual(initialAppearance)
  })

  it('rejects illegal durable values rather than clamping or coercing them', async () => {
    const f = await ownerConsumer()
    const bytes = await f.bytes()
    for (const editorFontSize of [7, 33, 8.5, NaN, '20']) {
      await expect(f.store.save({ ...f.owner.current, appearance: { ...initialAppearance, editorFontSize } } as never)).rejects.toThrow()
      expect(await f.bytes()).toBe(bytes)
    }
    expect(f.publish).not.toHaveBeenCalled(); expect(typography()).toBe('12:18')
  })

  it('retains the dirty draft and original expectation on a CLI conflict while preserving a concurrent Terminal edit', async () => {
    const f = await ownerConsumer({ ...initialAppearance, editorFontSize: 14 })
    await cli(f, '18'); expect(numeric().value).toBe('18')
    await enter('')
    await cli(f, '20'); expect(numeric().value).toBe(''); expect(typography()).toBe('20:30')
    await act(async () => { await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'appearance.terminalFontSize', value: '24' }, f.owner) })
    await enter('22')
    const bytes = await f.bytes()
    await dom.click(saveSelector)
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('appearance.editorFontSize')
    expect(numeric().value).toBe('22'); expect(save().disabled).toBe(false)
    expect(f.uiSave.mock.calls[0]![1].appearance.editorFontSize).toBe(18)
    expect(await f.bytes()).toBe(bytes)
    expect((await f.disk()).appearance).toEqual({ ...initialAppearance, terminalFontSize: 24, editorFontSize: 20 })
  })

  it('preserves a later incomplete draft through an earlier publication and successful save reply', async () => {
    const f = await ownerConsumer({ ...initialAppearance, editorFontSize: 14 })
    const persist = f.save.getMockImplementation()!
    let release!: () => void
    f.save.mockImplementationOnce(async next => {
      await new Promise<void>(resolve => { release = resolve })
      return persist(next)
    })
    await enter('16'); await dom.click(saveSelector)
    await enter('1')
    await act(async () => { release(); await f.uiSave.mock.results[0]!.value })
    expect(numeric().value).toBe('1'); expect(save().disabled).toBe(false)
    expect(typography()).toBe('16:24')
    await enter('18'); await commit(f)
    expect(f.uiSave.mock.calls.map(([next, expected]) => [next.appearance.editorFontSize, expected.appearance.editorFontSize])).toEqual([[16, 14], [18, 16]])
    expect((await f.disk()).appearance).toEqual({ ...initialAppearance, editorFontSize: 18 })
  })

  it('keeps a failed draft and its expectation until a successful durable retry', async () => {
    const f = await ownerConsumer({ ...initialAppearance, editorFontSize: 14 })
    await enter('19'); f.save.mockRejectedValueOnce(new Error('disk full'))
    const bytes = await f.bytes()
    await dom.click(saveSelector)
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toBe('disk full')
    expect(numeric().value).toBe('19'); expect(typography()).toBe('14:21'); expect(await f.bytes()).toBe(bytes)
    await commit(f)
    expect(f.uiSave.mock.calls.map(([, expected]) => expected.appearance.editorFontSize)).toEqual([14, 14])
    expect((await f.disk()).appearance).toEqual({ ...initialAppearance, editorFontSize: 19 })
    expect(typography()).toBe('19:29')
  })
})
