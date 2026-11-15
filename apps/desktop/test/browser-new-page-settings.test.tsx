// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { settingsCatalog } from '../src/renderer/src/components/settings/settings-modules'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store'
import { executeSettingsControl } from '../src/main/settings-control'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, AgentMuxControlServer } from '@agentmux/core'
import { BROWSER_NEW_PAGE_SCENES, BROWSER_NEW_PAGE_DESTINATIONS, BROWSER_NEW_PAGE_PLACEMENT_DEFAULTS, resolveBrowserNewPagePlacement, type BrowserNewPageScene } from '../src/shared/browser-new-page-placement'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'
import { chooseField } from './helpers/selection-field'
import { BROWSER_PROFILE_EXIT_CHECK_URL_LIMIT } from '../src/shared/browser-profile-exit-check-url'
import { prepareSourceCoreCli } from './helpers/source-core-cli.mjs'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc'
import { privateRpcCorePort } from '../../../packages/core/test/helpers/private-rpc-core'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('electron', async () => ({ app: { getPath: (await import('node:os')).tmpdir } }))
const dom = composerDOM(), envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'new-page-setting' }
const prefix = 'browser.newPagePlacement', names = { space: 'Space', focus: 'Focus', survey: 'Survey' }
let f: Awaited<ReturnType<typeof configOwnerFixture>>
beforeEach(async () => {
  f = await configOwnerFixture()
  const publish = f.publish.getMockImplementation()!
  f.publish.mockImplementation(saved => { publish(saved); useAppStore.setState({ config: saved }) })
  useAppStore.setState({ config: f.owner.current })
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => f.owner.edit(expected!, next))
})
const set = (scene: BrowserNewPageScene, value: string) => executeSettingsControl({ ...envelope, operation: 'settings.set', key: `${prefix}.${scene}`, value }, f.owner)
const inspect = (target = prefix) => executeSettingsControl({ ...envelope, operation: 'settings.get', target }, f.owner)
const saved = () => f.owner.current.browser.newPagePlacement
const field = (scene: BrowserNewPageScene) => dom.container.querySelector<HTMLButtonElement>(`[aria-label="New webpage in ${names[scene]}"]`)!
async function render() { await dom.render(<SettingsPanel initialSection="browser" onClose={() => {}} />) }
async function choose(scene: BrowserNewPageScene, label: string) {
  await chooseField(field(scene), label.toLowerCase())
}
async function save() {
  await dom.click('[data-settings-pane="browser"] [data-settings-save-bar] button')
  await act(async () => { await Promise.resolve(vi.mocked(api.config.save).mock.results.at(-1)?.value).catch(() => {}) })
}
const prefs = (config = f.owner.current) => ({ ...config, browser: { ...config.browser, newPagePlacement: { ...BROWSER_NEW_PAGE_PLACEMENT_DEFAULTS } } })

it('[new-page-settings] discovers three effective defaults without writing and rejects invalid durable values', async () => {
  const before = await f.bytes(), result = await inspect()
  expect(result).toMatchObject({ operation: 'settings.get', entries: BROWSER_NEW_PAGE_SCENES.map(scene => ({
    key: `${prefix}.${scene}`, value: BROWSER_NEW_PAGE_PLACEMENT_DEFAULTS[scene], default: BROWSER_NEW_PAGE_PLACEMENT_DEFAULTS[scene], enum: [...BROWSER_NEW_PAGE_DESTINATIONS]
  })) })
  expect(BROWSER_NEW_PAGE_PLACEMENT_DEFAULTS).toEqual({ space: 'region', focus: 'region', survey: 'tab' })
  for (const scene of BROWSER_NEW_PAGE_SCENES) await set(scene, resolveBrowserNewPagePlacement(undefined, scene))
  expect(f.save).not.toHaveBeenCalled(); expect(f.runtime.prepare).not.toHaveBeenCalled(); expect(await f.bytes()).toBe(before); expect(saved()).toBeUndefined()
  for (const scene of BROWSER_NEW_PAGE_SCENES) for (const value of ['right', 'Window', '', 'true']) await expect(set(scene, value)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  for (const patch of [{ space: 'right' }, { focus: 1 }, { survey: null }, { unknown: 'tab' }]) expect(() => f.store.validate({ ...f.owner.current, browser: { ...f.owner.current.browser, newPagePlacement: patch } } as never)).toThrow()
  expect(await f.bytes()).toBe(before)
})

it('[new-page-settings] merges independent first GUI/public edits without writing absent defaults or neighboring fields', async () => {
  const baseline = prefs(), neighbors = f.owner.current.browser
  await set('survey', 'window')
  const attempt = await f.owner.edit(baseline, { ...baseline, browser: { ...baseline.browser, newPagePlacement: { ...baseline.browser.newPagePlacement, space: 'tab' } } }).then(value => ({ value, error: null }), error => ({ value: null, error }))
  expect(attempt).toMatchObject({ value: { browser: { newPagePlacement: { survey: 'window', space: 'tab' } } } })
  const committed = attempt.value!
  expect(committed.browser.newPagePlacement).toEqual({ survey: 'window', space: 'tab' })
  expect(committed.browser.toolbar).toEqual(neighbors.toolbar)
  expect(committed.workspaces).toEqual(baseline.workspaces); expect(committed.executors).toEqual(baseline.executors)
  await expect(f.owner.edit(baseline, { ...baseline, browser: { ...baseline.browser, newPagePlacement: { ...baseline.browser.newPagePlacement, space: 'window' } } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT', field: `${prefix}.space` })
  expect((await new ConfigStore(f.store.filePath).get()).browser.newPagePlacement).toEqual(committed.browser.newPagePlacement)
})

it('[new-page-settings] original SettingsPanel edits three independent scalar drafts locally and keeps original content until save', async () => {
  const create = vi.spyOn(api.browser, 'create'), navigate = vi.spyOn(api.browser, 'navigate'), state = useAppStore.getState()
  await render(); const pane = dom.container.querySelector('[data-settings-pane="browser"]'), before = await f.bytes()
  expect(BROWSER_NEW_PAGE_SCENES.map(scene => field(scene).dataset.value)).toEqual(['region', 'region', 'tab'])
  expect(settingsCatalog.searchResults('new webpages').flatMap(result => result.targets.map(target => target.id))).toEqual(expect.arrayContaining(BROWSER_NEW_PAGE_SCENES.map(scene => `new-page-${scene}`)))
  await choose('space', 'Window'); await choose('focus', 'Tab'); await choose('survey', 'Region')
  expect(saved()).toBeUndefined(); expect(await f.bytes()).toBe(before); expect(api.config.save).not.toHaveBeenCalled()
  await save()
  expect((await f.disk()).browser.newPagePlacement).toEqual({ space: 'window', focus: 'tab', survey: 'region' })
  expect(dom.container.querySelector('[data-settings-pane="browser"]')).toBe(pane)
  expect(useAppStore.getState().tabs).toBe(state.tabs); expect(useAppStore.getState().surveyZoneSelection).toBe(state.surveyZoneSelection)
  expect(create).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
})

it('[new-page-settings] independent GUI fields adopt a newer untouched scene while keeping the original dirty scene', async () => {
  await render(); await choose('space', 'Window')
  await act(async () => { await set('survey', 'region'); await f.owner.update(current => ({ ...current, browser: { ...current.browser, appLinkSchemes: { 'preserved-app': 'deny' }, startPage: { title: 'Original start page' } } })) })
  await vi.waitFor(() => expect(field('survey').dataset.value).toBe('region'))
  expect(field('space').dataset.value).toBe('window'); expect(field('focus').dataset.value).toBe('region')
  await save(); expect(saved()).toEqual({ survey: 'region', space: 'window' })
  expect(f.owner.current.browser.appLinkSchemes).toEqual({ 'preserved-app': 'deny' }); expect(f.owner.current.browser.startPage).toEqual({ title: 'Original start page' })
})

it('[new-page-settings] failed physical save retains the GUI draft and original config; retry preserves later neighboring edits', async () => {
  await render(); await choose('space', 'Window')
  const original = f.owner.current, backup = `${f.store.filePath}.test-original`
  await rename(f.store.filePath, backup); await mkdir(f.store.filePath)
  try {
    await save(); expect(f.owner.current).toBe(original); expect(field('space').dataset.value).toBe('window')
    expect(dom.container.querySelector('[role="alert"]')).not.toBeNull()
  } finally { await rm(f.store.filePath, { recursive: true }); await rename(backup, f.store.filePath) }
  await act(async () => { await f.owner.update(current => ({ ...current, browser: { ...current.browser, toolbar: { ...current.browser.toolbar, devTools: false } } })) })
  await save(); expect(saved()).toEqual({ space: 'window' }); expect(f.owner.current.browser.toolbar.devTools).toBe(false)
})

it('[new-page-settings] pending save does not discard a later local change', async () => {
  await render(); await choose('space', 'Window')
  const held = deferred<void>(), prepare = vi.mocked(f.runtime.prepare).getMockImplementation()!
  vi.mocked(f.runtime.prepare).mockImplementationOnce(async (...args) => { await held.promise; return prepare(...args) })
  try {
    await dom.click('[data-settings-pane="browser"] [data-settings-save-bar] button')
    await vi.waitFor(() => expect(f.runtime.prepare).toHaveBeenCalled())
    expect(dom.container.querySelector('[data-settings-save-bar] button')?.getAttribute('aria-busy')).toBe('true')
    expect(dom.container.querySelector('[data-settings-save-bar]')?.textContent).toContain('Saving Browser preferences')
    await choose('space', 'Tab')
  } finally {
    held.resolve()
    await act(async () => { await vi.mocked(api.config.save).mock.results.at(-1)!.value })
  }
  expect(saved()).toEqual({ space: 'window' }); expect(field('space').dataset.value).toBe('tab')
  expect(dom.container.querySelector('[data-settings-save-bar]')?.textContent).toContain('Browser preferences: unsaved changes')
  await save(); expect(saved()).toEqual({ space: 'tab' })
})

it('[new-page-settings] same-scene conflicts keep drafts and use the original Use saved and Keep mine recovery', async () => {
  await render(); await choose('space', 'Window')
  await act(async () => { await set('space', 'tab') }); await save()
  expect(field('space').dataset.value).toBe('window'); expect(dom.container.querySelector('[data-settings-conflict]')).not.toBeNull()
  await dom.click('[data-settings-conflict-action="use-saved"]'); expect(field('space').dataset.value).toBe('tab')
  await choose('space', 'Region'); await act(async () => { await set('space', 'window') }); await save()
  await dom.click('[data-settings-conflict-action="keep-mine"]'); await save()
  expect(saved()).toEqual({ space: 'region' })
})

it('[new-page-settings] Source CLI discovers, writes and reads the same persisted choices while the original Focus entry stays independent', async () => {
  const cli = await prepareSourceCoreCli(), directory = await mkdtemp(join(tmpdir(), 'amx-page-settings-')), socket = join(directory, 'control.sock')
  const core = await privateRpcCorePort(join(directory, 'sessions.json'), join(directory, 'messages.ndjson'))
  const server = new AgentMuxControlServer({ socketPath: socket, coreClients: core.clients, execute: request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw Error('Wrong private setting owner')
    return executeSettingsControl(request, f.owner)
  } })
  const proof = { passed: false, sourceRoot: cli.sourceRoot, identity: cli.identity, cli: cli.cli, requests: [] as { args: string[]; pid: number | undefined; code: number | null }[], readbackPid: 0 }
  const env = objectCliEnvironment(directory), command = (args: string[], expected = 0) => new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [cli.cliPath, 'settings', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''; child.stdout.on('data', part => { out += part }); child.stderr.on('data', part => { err += part })
    child.once('error', reject); child.once('close', code => { try { proof.requests.push({ args, pid: child.pid, code }); expect(code, err + out).toBe(expected); resolve(expected === 0 ? JSON.parse(out).result : { stdout: out, stderr: err }) } catch (error) { reject(error) } })
  })
  try {
    await server.start(); const baseline = await f.bytes(), defaults = await command(['inspect', prefix])
    expect(defaults.entries.map((e: any) => e.value)).toEqual(['region', 'region', 'tab'])
    await command(['set', `${prefix}.survey`, 'tab']); expect(await f.bytes()).toBe(baseline)
    for (const scene of BROWSER_NEW_PAGE_SCENES) {
      const result = await command(['set', `${prefix}.${scene}`, 'window']); expect(result.entry).toMatchObject({ key: `${prefix}.${scene}`, value: 'window', enum: ['window', 'tab', 'region'] })
    }
    expect((await command(['inspect', prefix])).entries.every((e: any) => e.value === 'window')).toBe(true)
    const savedBytes = await f.bytes(); const invalid = await command(['set', `${prefix}.focus`, 'right'], 1); expect(invalid.stderr + invalid.stdout).toContain('INVALID_SETTING_VALUE'); expect(await f.bytes()).toBe(savedBytes)
    await command(['set', 'focus.linkDestination', 'tab'])
    expect((await command(['inspect', 'focus.linkDestination'])).entries).toEqual([{ key: 'focus.linkDestination', kind: 'string', value: 'tab', default: 'region', enum: ['region', 'tab'] }])
    expect(saved()).toEqual({ space: 'window', focus: 'window', survey: 'window' })
    const disk = await new ConfigStore(f.store.filePath).get(); expect(disk.browser.newPagePlacement).toEqual(saved()); expect(disk.focus?.linkDestination).toBe('tab')
    const readback = await new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({pid:process.pid,config:JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))}))', f.store.filePath], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let raw = ''
      child.stdout.on('data', part => { raw += part }); child.once('error', reject); child.once('close', code => code === 0 ? resolve(JSON.parse(raw)) : reject(Error('Original config readback failed')))
    })
    proof.readbackPid = readback.pid; expect(readback.pid).not.toBe(process.pid); expect(readback.config.browser.newPagePlacement).toEqual(saved()); expect(readback.config.focus.linkDestination).toBe('tab'); proof.passed = true
  } finally {
    try { if (process.env.BROWSER_SETTINGS_CLI_PROOF) await writeFile(process.env.BROWSER_SETTINGS_CLI_PROOF, JSON.stringify(proof) + '\n') }
    finally { await server.stop(); await core.dispose(); await cli.cleanup(); await rm(directory, { recursive: true, force: true }) }
  }
}, 90_000)


it('[new-page-settings] original Settings search and Overview reach the exact three fields without saving', async () => {
  await dom.render(<SettingsPanel onClose={() => {}} />)
  expect(dom.container.querySelector('[data-settings-directory] [data-settings-section="browser"]')).not.toBeNull()
  const bytes = await f.bytes()
  for (const scene of BROWSER_NEW_PAGE_SCENES) {
    const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, `New webpages in ${names[scene]}`); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await dom.click(`[data-settings-search-result="browser:new-page-${scene}"]`)
    const target = dom.container.querySelector<HTMLElement>(`[data-settings-pane="browser"] [data-settings-field="new-page-${scene}"]`)!
    await vi.waitFor(() => expect(target.hasAttribute('data-settings-search-highlight')).toBe(true))
    expect(document.activeElement).toBe(target); expect(field(scene)).not.toBeNull()
  }
  expect(await f.bytes()).toBe(bytes); expect(api.config.save).not.toHaveBeenCalled()
})

it('Browser Settings and public config accept the same boundary for an exit-check address', async () => {
  await render()
  await dom.click('.settings-browser__preferences > details > summary')
  const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Exit check address"]')!
  const submit = dom.container.querySelector<HTMLButtonElement>('[data-settings-pane="browser"] [data-settings-save-bar] button')!
  const lengthLimit = 'https://exit.example.test/'.padEnd(BROWSER_PROFILE_EXIT_CHECK_URL_LIMIT, 'a')
  const fill = async (address: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, address)
      input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    })
  }
  await fill(lengthLimit + 'a')
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(submit.disabled).toBe(true)
  expect(api.config.save).not.toHaveBeenCalled()
  await expect(executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'browser.exitCheckUrl', value: lengthLimit + 'a' }, f.owner))
    .rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  await fill(lengthLimit)
  expect(submit.disabled).toBe(false)
  await save()
  expect((await f.disk()).browser.exitCheckUrl).toBe(lengthLimit)
})
