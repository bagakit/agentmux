// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { settingsNavGroups } from '../src/renderer/src/components/settings/settings-modules'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'
import { DEFAULT_BROWSER_AGENT_CONTROL, resolveBrowserAgentControl } from '../src/shared/browser-agent-control'
import { executeSettingsControl } from '../src/main/settings-control'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { scalarSettingsSchemaKeys } from './helpers/settings-schema-keys'

const dom = composerDOM()
let f: Awaited<ReturnType<typeof configOwnerFixture>>
beforeEach(async () => {
  f = await configOwnerFixture()
  const publish = f.publish.getMockImplementation()!
  f.publish.mockImplementation(saved => { publish(saved); useAppStore.setState({ config: saved }) })
  useAppStore.setState({ config: f.owner.current })
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => { await f.owner.edit(expected!, next) })
})
const scope = '[data-settings-pane="browser-agent-control"]'
const field = (key: string) => `${scope} [data-settings-field="${key}"] input`
const input = (key: string) => dom.container.querySelector<HTMLInputElement>(field(key))!
const saveButton = () => dom.container.querySelector<HTMLButtonElement>(`${scope} [data-settings-save-bar] button`)!
const shadow = () => dom.container.querySelector('.browser-agent-preview__effects')!.shadowRoot!
const pane = () => dom.render(<SettingsPanel initialSection="browser-agent-control" onClose={() => {}} />)
async function value(key: string, text: string) {
  await act(async () => {
    const element = input(key)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, text)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function settled() {
  for (let n = 0; n < 100; n++) {
    await act(async () => { await new Promise(done => setTimeout(done, 5)) })
    if (saveButton().getAttribute('aria-busy') === 'false') return
  }
  throw new Error('Private Browser appearance save did not settle')
}

it('mounts the Browser use contribution and previews an unsaved draft through the shared effects without a Browser operation', async () => {
  const group = settingsNavGroups('').find(group => group.id === 'browser-use')!
  expect(group.title).toBe('Browser use')
  expect(group.items.map(item => item.id)).toEqual(['browser', 'browser-agent-control'])
  const operate = vi.spyOn(api.browser, 'runScript')
  await dom.render(<SettingsPanel onClose={() => {}} />)
  await dom.click('[data-settings-overview] [data-settings-section="browser-agent-control"]')
  expect(dom.container.querySelector(`${scope}`)).not.toBeNull()
  expect(input('showCursor').checked).toBe(true)
  expect(input('showDiscussion').checked).toBe(false)
  const before = await f.bytes()
  await value('glowColor', '#c78cfa')
  await value('glowWidth', '40')
  expect(shadow().querySelector('style')!.textContent).toContain('--amux-agent-color:#c78cfa')
  expect(shadow().querySelector('style')!.textContent).toContain('inset 0 0 40px')
  expect(saveButton().disabled).toBe(false)
  expect(await f.bytes()).toBe(before)
  expect(api.config.save).not.toHaveBeenCalled()
  expect(operate).not.toHaveBeenCalled()
  await dom.click(`${scope} [data-settings-field="showCursor"] input`)
  expect(shadow().querySelector('style')!.textContent).toContain('display:none;align-items:flex-start')
  await dom.click(`${scope} [data-settings-field="showDiscussion"] input`)
  expect(dom.container.querySelector('.browser-agent-preview__discussion')!.textContent).toContain('Message sample Agent')
})

it('merges concurrent first edits and keeps a later draft while persistence is pending', async () => {
  await pane()
  await value('glowWidth', '38')
  const held = deferred<void>(), prepare = vi.mocked(f.runtime.prepare).getMockImplementation()!
  vi.mocked(f.runtime.prepare).mockImplementationOnce(async (...args) => { await held.promise; return prepare(...args) })
  await dom.click(`${scope} [data-settings-save-bar] button`)
  await value('glowWidth', '47')
  expect(input('glowWidth').value).toBe('47')
  await act(async () => held.resolve())
  await settled()
  expect((await f.disk()).browser.agentControl).toEqual({ glowWidth: 38 })
  expect(input('glowWidth').value).toBe('47')
  expect(saveButton().disabled).toBe(false)
  await act(async () => { await f.owner.update(current => ({ ...current, browser: { ...current.browser, agentControl: { ...current.browser.agentControl, glowColor: '#abcdef' } } })) })
  expect(input('glowColor').value).toBe('#abcdef')
  await dom.click(`${scope} [data-settings-save-bar] button`); await settled()
  expect((await f.disk()).browser.agentControl).toEqual({ glowWidth: 47, glowColor: '#abcdef' })
  expect(f.owner.current.browser.agentAutomation).toBe(false)
})

it('previews real activity vocabulary, steady ownership and immediate handoff without invented waiting targets or writes', async () => {
  await pane()
  const before = await f.bytes()
  for (const [phase, cue, owns] of [
    ['observing', 'Observing', true], ['script', 'Script', true], ['navigating', 'Navigating', true],
    ['waiting', 'Waiting', true], ['completed', 'Done', true], ['human', 'Your turn', false]
  ] as const) {
    await act(async () => {
      const select = dom.container.querySelector<HTMLSelectElement>('[aria-label="Simulation state"]')!
      select.value = phase; select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(dom.container.querySelector('.browser-operation-status__cue')?.textContent).toBe(cue)
    expect(Boolean(dom.container.querySelector('[data-browser-control-boundary]'))).toBe(owns)
    expect(shadow().querySelector('.amux-browser-agent-pointer')).toBeNull()
    expect(shadow().querySelector('.amux-browser-agent-ripple')).toBeNull()
  }
  expect(await f.bytes()).toBe(before)
  expect(api.config.save).not.toHaveBeenCalled()
})

it('retains a conflicting draft and clears effects in the simulated human state without changing configuration', async () => {
  await pane(); await value('glowWidth', '35')
  await act(async () => { await f.owner.update(current => ({ ...current, browser: { ...current.browser, agentControl: { glowWidth: 54 } } })) })
  await dom.click(`${scope} [data-settings-save-bar] button`); await settled()
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('changed since')
  expect(input('glowWidth').value).toBe('35')
  expect((await f.disk()).browser.agentControl).toEqual({ glowWidth: 54 })
  await act(async () => {
    const select = dom.container.querySelector<HTMLSelectElement>('[aria-label="Simulation state"]')!
    select.value = 'human'; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(shadow().querySelector('.amux-browser-agent-effects')!.getAttribute('data-active')).toBe('false')
})

it('stops the local simulation when its visited pane is hidden and keeps its draft', async () => {
  vi.useFakeTimers()
  try {
    await pane(); await value('glowWidth', '37')
    await dom.click('.browser-agent-preview__playback button')
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    const pointer = shadow().querySelector('.amux-browser-agent-label-text')!
    const before = pointer.textContent
    const nav = [...dom.container.querySelectorAll<HTMLButtonElement>('nav button')].find(node => node.textContent === 'Appearance')!
    await act(async () => nav.click())
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(pointer.textContent).toBe(before)
    expect(shadow().querySelector('.amux-browser-agent-effects')!.getAttribute('data-active')).toBe('false')
    expect(input('glowWidth').value).toBe('37')
  } finally { vi.useRealTimers() }
})

it('actual CLI reads and persists the same preferences through public RPC and rejects invalid values before writing', async () => {
  const catalog = await executeSettingsControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'catalog', operation: 'settings.get' }, f.owner)
  if (catalog.operation !== 'settings.get') throw new Error('Wrong result')
  expect(catalog.entries.filter(entry => entry.key.startsWith('browser.agentControl.'))).toHaveLength(16)
  const directory = await mkdtemp(join(tmpdir(), 'amux-browser-effects-'))
  const server = new AgentMuxControlServer({ execute: request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Wrong owner')
    return executeSettingsControl(request, f.owner)
  } }, join(directory, 'control.sock'))
  await server.start()
  const cli = promisify(execFile), args = [resolve('packages/core/bin/amux'), '--endpoint', `unix:${server.path}`, 'settings']
  const options = { timeout: 10000, env: { ...process.env, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined } }
  try {
    const found = JSON.parse((await cli(process.execPath, [...args, 'inspect', 'browser.agentControl'], options)).stdout).result
    expect(found.entries).toHaveLength(Object.keys(DEFAULT_BROWSER_AGENT_CONTROL).length)
    expect(found.entries.map((entry: { key: string }) => entry.key).sort()).toEqual((await scalarSettingsSchemaKeys(resolve('apps/desktop/src/main/config-store.ts'))).filter(key => key.startsWith('browser.agentControl.')).sort())
    expect(Object.fromEntries(found.entries.map((entry: { key: string; value: unknown }) => [entry.key.split('.').at(-1), entry.value]))).toEqual(DEFAULT_BROWSER_AGENT_CONTROL)
    for (const [key, next] of [['glowColor', '#a4c1ff'], ['glowWidth', '42'], ['showDiscussion', 'true'], ['glowBlend', 'screen'], ['glowAnimation', 'breathe']]) {
      const receipt = JSON.parse((await cli(process.execPath, [...args, 'set', `browser.agentControl.${key}`, next!], options)).stdout).result
      expect(String(receipt.entry.value)).toBe(next)
    }
    const before = await f.bytes()
    for (const [key, bad] of [['glowColor', 'red'], ['glowWidth', '1000'], ['glowOpacity', 'NaN'], ['glowBlend', 'url(x)']]) {
      await expect(cli(process.execPath, [...args, 'set', `browser.agentControl.${key}`, bad!], options)).rejects.toMatchObject({ code: 1 })
    }
    expect(await f.bytes()).toBe(before)
    await pane()
    expect(input('glowWidth').value).toBe('42')
    expect(input('glowColor').value).toBe('#a4c1ff')
    expect(input('showDiscussion').checked).toBe(true)
    expect(resolveBrowserAgentControl(f.owner.current.browser.agentControl).glowBlend).toBe('screen')
    expect(f.owner.current.browser.agentAutomation).toBe(false)
    const result = await executeSettingsControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'exact', operation: 'settings.get', target: 'browser.agentControl.glowWidth' }, f.owner)
    expect(result).toMatchObject({ entries: [{ value: 42 }] })
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }) }
}, 30000)

it('rejects invalid effect values at the durable GUI save boundary and keeps the original bytes', async () => {
  const before = await f.bytes(), expected = f.owner.current
  await expect(f.owner.edit(expected, { ...expected, browser: { ...expected.browser, agentControl: { glowWidth: 1000 } } })).rejects.toThrow()
  expect(await f.bytes()).toBe(before)
  expect(f.publish).not.toHaveBeenCalled()
})
