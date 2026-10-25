import { expect, it } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { executeSettingsControl } from '../src/main/settings-control'
import { DEFAULT_BROWSER_START_PAGE } from '../src/shared/browser-start-page'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { parseSettingsCommand } from '../../../packages/core/src/settings-cli.js'
import { ConfigStore } from '../src/main/config-store.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'

const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'start-page-settings' } as const
const principal = { transport: 'unix', principal: { kind: 'user', id: 'start-page-settings-proof' } } as const
function publicSettings(f: Awaited<ReturnType<typeof configOwnerFixture>>) {
  const service = new AgentMuxRpcService({ execute: request => executeSettingsControl(request as never, f.owner) })
  return async (parts: string[]) => { const command = await parseSettingsCommand(parts); return service.call(command.method, command.params, principal) }
}

it('discovers effective start-page fields and persists them through the public Settings owner', async () => {
  const f = await configOwnerFixture()
  const before = await f.bytes()
  const found = await executeSettingsControl({ ...envelope, operation: 'settings.get', target: 'browser.startPage' }, f.owner)
  if (found.operation !== 'settings.get') throw new Error('Expected the original settings.get receipt')
  expect(found.entries.map(entry => [entry.key, entry.value, entry.default])).toEqual(Object.entries(DEFAULT_BROWSER_START_PAGE).map(([key, value]) => [`browser.startPage.${key}`, value, value]))
  expect(await f.bytes()).toBe(before)
  const values = { title: 'My research', subtitle: 'Keep your sources close', icon: 'https://images.example.test/mark.png', backgroundImage: 'https://images.example.test/background.jpg', showHistory: false, historyLimit: 18, interactiveBackground: false }
  for (const [key, value] of Object.entries(values)) {
    const receipt = await executeSettingsControl({ ...envelope, operation: 'settings.set', key: `browser.startPage.${key}`, value: String(value) }, f.owner)
    if (receipt.operation !== 'settings.set') throw new Error('Expected the original settings.set receipt')
    expect(receipt.entry.value).toBe(value)
  }
  expect((await f.disk()).browser.startPage).toEqual(values)
  expect(f.publish).toHaveBeenCalledTimes(7)
})

it('merges a first GUI edit against effective defaults and preserves concurrent unrelated edits', async () => {
  const f = await configOwnerFixture(), before = f.owner.current
  await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'browser.agentAutomation', value: 'true' }, f.owner)
  await f.owner.edit({ ...before, browser: { ...before.browser, startPage: DEFAULT_BROWSER_START_PAGE } },
    { ...before, browser: { ...before.browser, startPage: { ...DEFAULT_BROWSER_START_PAGE, title: 'Personal start page' } } })
  expect((await f.disk()).browser.startPage).toEqual({ title: 'Personal start page' })
  expect(f.owner.current.browser.agentAutomation).toBe(true)
  await expect(f.owner.edit({ ...before, browser: { ...before.browser, startPage: DEFAULT_BROWSER_START_PAGE } },
    { ...before, browser: { ...before.browser, startPage: { ...DEFAULT_BROWSER_START_PAGE, title: 'Conflicting title' } } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
  expect((await f.disk()).browser.startPage?.title).toBe('Personal start page')
})

it('rejects invalid presentation assets without changing configuration or Browser authority', async () => {
  const f = await configOwnerFixture(), before = await f.bytes()
  await expect(executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'browser.startPage.backgroundImage', value: 'javascript:alert(1)' }, f.owner)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  expect(await f.bytes()).toBe(before); expect(f.publish).not.toHaveBeenCalled()
  const receipt = await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'browser.startPage.icon', value: '' }, f.owner)
  if (receipt.operation !== 'settings.set') throw new Error('Expected a settings.set receipt')
  expect(receipt.entry.value).toBe(''); expect(await f.bytes()).toBe(before)
})

it('public Settings exposes effective personalization defaults and rejects invalid scalar and schema edits', async () => {
  const f = await configOwnerFixture(), call = publicSettings(f), bytes = await f.bytes()
  expect((await call(['inspect', 'browser.startPage.historyLimit'])).entries).toEqual([
    { key: 'browser.startPage.historyLimit', kind: 'number', value: 12, default: 12, enum: Array.from({ length: 50 }, (_, index) => index + 1) }
  ])
  expect((await call(['inspect', 'browser.startPage.interactiveBackground'])).entries).toEqual([
    { key: 'browser.startPage.interactiveBackground', kind: 'boolean', value: true, default: true }
  ])
  await call(['set', 'browser.startPage.historyLimit', '12'])
  await call(['set', 'browser.startPage.interactiveBackground', 'true'])
  expect(await f.bytes()).toBe(bytes); expect(f.publish).not.toHaveBeenCalled()
  for (const text of ['0', '51', '2.5', '-1', 'NaN', '', '1e1', ' 12', '012']) {
    await expect(call(['set', 'browser.startPage.historyLimit', text])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  }
  await expect(call(['set', 'browser.startPage.interactiveBackground', 'yes'])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  for (const historyLimit of [0, 51, 1.5, '12', null]) expect(() => f.store.validate({ ...f.owner.current,
    browser: { ...f.owner.current.browser, startPage: { historyLimit } } } as never)).toThrow()
  expect(() => f.store.validate({ ...f.owner.current, browser: { ...f.owner.current.browser, startPage: { interactiveBackground: 'false' } } } as never)).toThrow()
  expect(await f.bytes()).toBe(bytes); expect(f.publish).not.toHaveBeenCalled()
  for (const count of [1, 50, 18]) {
    expect((await call(['set', 'browser.startPage.historyLimit', String(count)])).entry.value).toBe(count)
    expect((await new ConfigStore(f.store.filePath).get()).browser.startPage?.historyLimit).toBe(count)
  }
})

it('merges new first-view fields with an original GUI title edit without resetting unrelated preferences', async () => {
  const f = await configOwnerFixture(), before = f.owner.current, call = publicSettings(f)
  await call(['set', 'browser.startPage.historyLimit', '24'])
  await call(['set', 'browser.startPage.interactiveBackground', 'false'])
  await f.owner.edit({ ...before, browser: { ...before.browser, startPage: DEFAULT_BROWSER_START_PAGE } },
    { ...before, browser: { ...before.browser, startPage: { ...DEFAULT_BROWSER_START_PAGE, title: 'My reading room' } } })
  const saved = (await new ConfigStore(f.store.filePath).get()).browser.startPage
  expect(saved).toMatchObject({ title: 'My reading room', historyLimit: 24, interactiveBackground: false })
  expect(f.owner.current.hosts).toEqual(before.hosts); expect(f.owner.current.workspaces).toEqual(before.workspaces)
})

it('the executable CLI discovers and saves personalization through the public socket and original ConfigOwner', async () => {
  const f = await configOwnerFixture()
  const server = new AgentMuxControlServer({ execute: request => executeSettingsControl(request as never, f.owner) }, join(f.store.filePath, '..', 'control.sock'))
  await server.start()
  try {
    const call = async (parts: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
      [resolve('packages/core/bin/amux'), '--endpoint', `unix:${server.path}`, 'settings', ...parts],
      { timeout: 10000, env: { ...process.env, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined, AGENTMUX_ENV: undefined } })).stdout).result
    const observed = await call(['inspect', 'browser.startPage'])
    expect(observed.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'browser.startPage.historyLimit', value: 12, default: 12 }),
      expect.objectContaining({ key: 'browser.startPage.interactiveBackground', value: true, default: true })
    ]))
    expect((await call(['set', 'browser.startPage.historyLimit', '24'])).entry.value).toBe(24)
    expect((await call(['set', 'browser.startPage.interactiveBackground', 'false'])).entry.value).toBe(false)
    expect((await call(['inspect', 'browser.startPage.historyLimit'])).entries[0].value).toBe(24)
    expect((await new ConfigStore(f.store.filePath).get()).browser.startPage).toMatchObject({ historyLimit: 24, interactiveBackground: false })
    const saved = await f.bytes()
    await expect(call(['set', 'browser.startPage.historyLimit', '100'])).rejects.toMatchObject({ code: 1 })
    expect(await f.bytes()).toBe(saved)
  } finally { await server.stop() }
}, 45000)
