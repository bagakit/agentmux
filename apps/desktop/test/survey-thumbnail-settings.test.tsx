// @vitest-environment happy-dom
import '../scripts/fixtures/mote-navigation-footer/atomic-move.setup'
import '../scripts/fixtures/survey-tab-composition/native-listener.setup'
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { GlobalSurveySurface } from '../src/renderer/src/components/GlobalSurveySurface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { DEFAULT_SURVEY_THUMBNAIL_LAYOUT, SURVEY_THUMBNAIL_HEIGHT, SURVEY_THUMBNAIL_COLUMNS } from '../src/shared/survey-thumbnail-layout'
import { ConfigStore } from '../src/main/config-store'
import { executeSettingsControl } from '../src/main/settings-control'
import { AgentMuxControlServer, AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'
import { prepareSourceCoreCli } from './helpers/source-core-cli.mjs'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc'
import { privateRpcCorePort } from '../../../packages/core/test/helpers/private-rpc-core'
import { settingsCatalog } from '../src/renderer/src/components/settings/settings-modules'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('electron', async () => ({ app: { getPath: (await import('node:os')).tmpdir } }))
const dom = composerDOM(), key = 'browser.surveyThumbnails', envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'thumbnail-setting' }
let f: Awaited<ReturnType<typeof configOwnerFixture>>
beforeEach(async () => {
  f = await configOwnerFixture()
  const publish = f.publish.getMockImplementation()!
  f.publish.mockImplementation(saved => { publish(saved); useAppStore.setState({ config: saved }) })
  useAppStore.setState({ config: f.owner.current, surveySidebarWidth: 240 })
  vi.spyOn(api.config, 'save').mockImplementation(async (value, expected) => await f.owner.edit(expected!, value))
})
const set = (name: string, value: string) => executeSettingsControl({ ...envelope, operation: 'settings.set', key: `${key}.${name}`, value }, f.owner)
const inspect = () => executeSettingsControl({ ...envelope, operation: 'settings.get', target: key }, f.owner)
const layout = (config = f.owner.current) => config.browser.surveyThumbnails
const field = (name: string) => dom.container.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!
const area = '.settings-survey-thumbnails', sample = () => dom.container.querySelector<HTMLElement>('.survey-thumbnail-preview')!, surface = () => dom.container.querySelector<HTMLElement>('.global-survey-surface')!
async function value(name: string, next: string) {
  await act(async () => { const input = field(name); expect(input).not.toBeNull(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, next); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function render() {
  await dom.render(<><GlobalSurveySurface catalog={null} projection={null} selection={null} visible={false} /><SettingsPanel initialSection="survey" onClose={() => {}} /></>)
}
async function save() {
  await dom.click(`${area} [data-settings-save-bar] button`)
  await act(async () => { await Promise.resolve(vi.mocked(api.config.save).mock.results.at(-1)?.value).catch(() => {}) })
}

it('[survey-thumbnails] discovers two effective bounded defaults without writing and rejects invalid schema/scalars', async () => {
  const before = await f.bytes(), result = await inspect()
  expect(result).toMatchObject({ operation: 'settings.get', entries: [
    { key: `${key}.height`, value: 52, default: 52, enum: Array.from({ length: 129 }, (_, n) => 52 + n) },
    { key: `${key}.maxColumns`, value: 4, default: 4, enum: [1, 2, 3, 4, 5, 6] }
  ] })
  await set('height', '52'); await set('maxColumns', '4')
  expect(f.save).not.toHaveBeenCalled(); expect(await f.bytes()).toBe(before); expect(layout()).toBeUndefined()
  for (const [name, values] of [['height', ['51', '181', '52.5', '', '-1', 'NaN', '1e2']], ['maxColumns', ['0', '7', '2.5']]] as const) {
    for (const next of values) await expect(set(name, next)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  }
  for (const patch of [{ height: 51 }, { height: 181 }, { height: 1.5 }, { maxColumns: 0 }, { maxColumns: 7 }, { height: '80' }, { unexpected: true }]) expect(() => f.store.validate({ ...f.owner.current, browser: { ...f.owner.current.browser, surveyThumbnails: patch } } as never)).toThrow()
  expect(SURVEY_THUMBNAIL_HEIGHT).toEqual({ min: 52, max: 180 }); expect(SURVEY_THUMBNAIL_COLUMNS).toEqual({ min: 1, max: 6 })
  expect(await f.bytes()).toBe(before)
})

it('[survey-thumbnails] merges first GUI effective defaults with disjoint public edits and refuses a stale same-field write', async () => {
  const before = f.owner.current, baseline = { ...before, browser: { ...before.browser, surveyThumbnails: DEFAULT_SURVEY_THUMBNAIL_LAYOUT } }
  await set('maxColumns', '2')
  const merged = await f.owner.edit(baseline, { ...baseline, browser: { ...baseline.browser, surveyThumbnails: { height: 96, maxColumns: 4 } } }).then(value => ({ value }), error => ({ error }))
  expect(merged).toMatchObject({ value: { browser: { surveyThumbnails: { height: 96, maxColumns: 2 } } } })
  expect(layout()).toEqual({ height: 96, maxColumns: 2 })
  await expect(f.owner.edit(baseline, { ...baseline, browser: { ...baseline.browser, surveyThumbnails: { height: 110, maxColumns: 4 } } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
  expect((await new ConfigStore(f.store.filePath).get()).browser.surveyThumbnails).toEqual(layout())
  expect(f.owner.current.workspaces).toEqual(before.workspaces); expect(f.owner.current.executors).toEqual(before.executors)
})

it('[survey-thumbnails] actual Survey settings preview stays local until save and discard leaves navigation unchanged', async () => {
  const preview = vi.spyOn(api.browser, 'getRecoveryPreview'), create = vi.spyOn(api.browser, 'create'), navigate = vi.spyOn(api.browser, 'navigate')
  await render(); const original = surface(), before = await f.bytes()
  expect(settingsCatalog.searchResults('thumbnail').flatMap(result => result.targets.map(target => target.id))).toEqual(expect.arrayContaining(['thumbnail-height', 'thumbnail-columns']))
  expect(surface().style.getPropertyValue('--survey-thumbnail-height')).toBe('52px')
  await value('Research thumbnail height', '112'); await value('Maximum thumbnails per row', '2')
  expect(sample().style.getPropertyValue('--survey-thumbnail-height')).toBe('112px'); expect(sample().style.getPropertyValue('--survey-thumbnail-columns')).toBe('2')
  expect(sample().textContent).toContain('Unsaved preview'); expect(sample().textContent).toContain('Sample content')
  expect(surface()).toBe(original); expect(surface().style.getPropertyValue('--survey-thumbnail-height')).toBe('52px')
  expect(api.config.save).not.toHaveBeenCalled(); expect(await f.bytes()).toBe(before)
  await dom.click(`${area} .settings-survey-thumbnails__reset button:last-child`)
  expect(sample().style.getPropertyValue('--survey-thumbnail-height')).toBe('52px'); expect(sample().style.getPropertyValue('--survey-thumbnail-columns')).toBe('4')
  expect(await f.bytes()).toBe(before); expect(preview).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
})

it('[survey-thumbnails] saving publishes the same layout to the real Survey surface without replacing its DOM or selection', async () => {
  await render(); const original = surface(), tabs = useAppStore.getState().tabs, selection = useAppStore.getState().surveyZoneSelection
  await value('Research thumbnail height', '180'); await value('Maximum thumbnails per row', '1'); await save()
  expect((await f.disk()).browser.surveyThumbnails).toEqual({ height: 180, maxColumns: 1 })
  expect(surface().style.getPropertyValue('--survey-thumbnail-height')).toBe('180px'); expect(surface().style.getPropertyValue('--survey-thumbnail-columns')).toBe('1')
  expect(surface()).toBe(original); expect(useAppStore.getState().tabs).toBe(tabs); expect(useAppStore.getState().surveyZoneSelection).toBe(selection)
  expect(dom.container.querySelector(`${area} [role="status"]`)?.textContent).toContain('Thumbnail layout saved')
})

it('[survey-thumbnails] a failed original save preserves the draft and later unrelated configuration', async () => {
  await render(); const before = await f.bytes()
  vi.mocked(api.config.save).mockRejectedValueOnce(new Error('Original configuration write unavailable'))
  await value('Research thumbnail height', '128'); await save()
  expect(field('Research thumbnail height').value).toBe('128'); expect(dom.container.querySelector(`${area} [role="alert"]`)?.textContent).toContain('write unavailable')
  expect(await f.bytes()).toBe(before); expect(surface().style.getPropertyValue('--survey-thumbnail-height')).toBe('52px')
  await act(async () => { await f.owner.update(current => ({ ...current, copyPathsAsAbsolute: true })) })
  await save(); expect(f.owner.current.copyPathsAsAbsolute).toBe(true); expect(layout()).toEqual({ height: 128 })
})

it('[survey-thumbnails] keeps a newer local draft during save and exposes original same-field conflict recovery', async () => {
  await render(); await value('Research thumbnail height', '88')
  const held = deferred<void>(), prepare = vi.mocked(f.runtime.prepare).getMockImplementation()!
  vi.mocked(f.runtime.prepare).mockImplementationOnce(async (...args) => { await held.promise; return prepare(...args) })
  await dom.click(`${area} [data-settings-save-bar] button`); await value('Research thumbnail height', '104')
  await act(async () => held.resolve()); await act(async () => { await vi.mocked(api.config.save).mock.results.at(-1)!.value })
  expect(layout()).toEqual({ height: 88 }); expect(field('Research thumbnail height').value).toBe('104')
  await act(async () => { await set('height', '120') }); await save()
  expect(layout()).toEqual({ height: 120 }); expect(field('Research thumbnail height').value).toBe('104')
  expect(dom.container.querySelector(`${area} [data-settings-conflict]`)).not.toBeNull()
  await dom.click(`${area} [data-settings-conflict-action="keep-mine"]`); await save()
  expect(layout()).toEqual({ height: 104 })
})

it('[survey-thumbnails] actual Source CLI discovers and writes through public RPC and a new process reads the saved layout', async () => {
  const generated = process.env.SURVEY_THUMBNAILS_CLI ? null : await prepareSourceCoreCli(), cli = process.env.SURVEY_THUMBNAILS_CLI || generated!.cliPath
  const directory = join(f.store.filePath, '..'), core = await privateRpcCorePort(join(directory, 'sessions.json'), join(directory, 'messages.ndjson'))
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: core.clients, execute: request => {
    if (request.operation === 'settings.get' || request.operation === 'settings.set') return executeSettingsControl(request, f.owner)
    throw new Error('Only original Settings operations belong to this private endpoint')
  } })
  const env = objectCliEnvironment(directory)
  async function run(...args: string[]) {
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'settings', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''
      child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes }); child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }))
    })
  }
  try {
    await server.start(); const before = await f.bytes(), found = await run('inspect', key)
    expect(found.code, found.stderr).toBe(0); expect(JSON.parse(found.stdout).result.entries.map((entry: { key: string }) => entry.key)).toEqual([`${key}.height`, `${key}.maxColumns`])
    expect(await f.bytes()).toBe(before)
    for (const [field, value] of [['height', '180'], ['maxColumns', '6']] as const) { const result = await run('set', `${key}.${field}`, value); expect(result.code, result.stderr).toBe(0) }
    expect((await f.disk()).browser.surveyThumbnails).toEqual({ height: 180, maxColumns: 6 })
    const readback = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).browser.surveyThumbnails))', f.store.filePath], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', part => { output += part }); child.once('error', reject); child.once('close', code => code === 0 ? resolve(output) : reject(new Error('Private configuration readback failed'))) 
    })
    expect(JSON.parse(readback)).toEqual({ height: 180, maxColumns: 6 })
    const bytes = await f.bytes(), invalid = await run('set', `${key}.height`, '181'); expect(invalid.code).not.toBe(0); expect(invalid.stderr).toContain('INVALID_SETTING_VALUE'); expect(await f.bytes()).toBe(bytes)
  } finally { await server.stop(); await core.dispose(); await generated?.cleanup() }
}, 30_000)
