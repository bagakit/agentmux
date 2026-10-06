// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'
import { ConfigStore } from '../src/main/config-store'
import { executeSettingsControl } from '../src/main/settings-control'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { AgentComposerTools } from '../src/renderer/src/components/AgentComposerTools'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'
import { messageToolSettingsModule } from '../src/renderer/src/components/settings/modules/message-tool'
import { AgentMuxControlServer } from '../../../packages/core/dist/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/dist/public-rpc-client.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { dirname, join, resolve } from 'node:path'

const dom = composerDOM()
const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'layout-preference' } as const
const entry = { key: 'messageToolInitialLayout', kind: 'string', value: 'one-line', default: 'one-line', enum: ['one-line', 'two-line'] }
const pane = (section = 'message-tool') => dom.container.querySelector<HTMLElement>(`[data-settings-pane="${section}"]`)!
const choose = async (layout: string) => { await act(async () => pane().querySelector<HTMLInputElement>(`input[value="${layout}"]`)!.click()) }
const save = async (section = 'message-tool') => { await act(async () => pane(section).querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!.click()) }
const phase = () => dom.container.querySelector('.composer-tools')?.getAttribute('data-mode')

it('discovers the effective default without writing it, persists the choice and reads it after reopening the config', async () => {
  const f = await configOwnerFixture()
  const original = await f.bytes()
  expect(await executeSettingsControl({ ...envelope, operation: 'settings.get', target: entry.key }, f.owner))
    .toEqual({ operation: 'settings.get', partial: true, entries: [entry] })
  await executeSettingsControl({ ...envelope, operation: 'settings.set', key: entry.key, value: 'one-line' }, f.owner)
  expect(await f.bytes()).toBe(original)
  expect(f.save).not.toHaveBeenCalled()
  const before = f.owner.current
  expect(await executeSettingsControl({ ...envelope, operation: 'settings.set', key: entry.key, value: 'two-line' }, f.owner))
    .toEqual({ operation: 'settings.set', entry: { ...entry, value: 'two-line' } })
  expect(await f.disk()).toEqual({ ...before, messageToolInitialLayout: 'two-line' })
  const reopened = new ConfigStore(f.store.filePath)
  expect((await reopened.get()).messageToolInitialLayout).toBe('two-line')
  for (const value of ['expanded', 'two-lines', 'TWO-LINE', 'two-line ']) {
    await expect(executeSettingsControl({ ...envelope, operation: 'settings.set', key: entry.key, value }, f.owner))
      .rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  }
  expect(() => f.store.validate({ ...before, messageToolInitialLayout: 'expanded' as never })).toThrow()
})

it('consumes the same Main preference through public RPC and the compiled CLI', async () => {
  const f = await configOwnerFixture(), path = join(dirname(f.store.filePath), 'settings.sock')
  const server = new AgentMuxControlServer({ socketPath: path, execute: async request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Unexpected non-settings operation')
    return executeSettingsControl(request, f.owner)
  } })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
  try {
    await expect(rpc.call('settings.inspect', { target: entry.key })).resolves.toEqual({ partial: true, entries: [entry] })
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
    const cli = spawn(process.execPath, [resolve('packages/core/bin/amux'), '--endpoint', `unix://${path}`,
      'settings', 'set', entry.key, 'two-line'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    cli.stdout.on('data', bytes => { output += bytes }); cli.stderr.on('data', bytes => { errors += bytes })
    const [code] = await once(cli, 'close')
    expect(code, errors).toBe(0)
    expect(JSON.parse(output).result).toEqual({ entry: { ...entry, value: 'two-line' } })
    await expect(rpc.call('settings.inspect', { target: entry.key })).resolves.toEqual({ partial: true, entries: [{ ...entry, value: 'two-line' }] })
    expect((await f.disk()).messageToolInitialLayout).toBe('two-line')
  } finally { rpc.dispose(); await server.stop() }
})

it('saves the first two-line edit through the real Message Tool adapter and ConfigOwner, preserving an unrelated concurrent change', async () => {
  const f = await configOwnerFixture()
  useAppStore.setState({ config: f.owner.current })
  const ipc = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => {
    const committed = await f.owner.edit(expected!, next)
    useAppStore.getState().setConfig(committed)
  })
  await dom.render(<SettingsPanel initialSection="message-tool" onClose={() => {}} />)
  expect(pane().querySelector<HTMLInputElement>('input[value="one-line"]')!.checked).toBe(true)
  await choose('two-line')
  expect(pane().textContent).toContain('Saved: One line')
  await f.owner.update(current => ({ ...current, copyPathsAsAbsolute: true }))
  await save()
  await act(async () => { expect((await Promise.allSettled([ipc.mock.results[0].value])).map(result => result.status)).toEqual(['fulfilled']) })
  await vi.waitFor(async () => expect((await f.disk()).messageToolInitialLayout).toBe('two-line'))
  expect((await f.disk()).messageToolInitialLayout).toBe('two-line')
  expect((await f.disk()).copyPathsAsAbsolute).toBe(true)
  expect(ipc).toHaveBeenCalledTimes(1)
  expect(pane().textContent).toContain('Saved: Two lines')
  expect(pane().querySelector('[data-settings-save-bar]')!.textContent).toContain('Changes saved')
  expect(messageToolSettingsModule.savedSummary(f.owner.current)).toContain('Two-line input')
})

it('saving only copied paths leaves the absent layout preference absent', async () => {
  const f = await configOwnerFixture()
  useAppStore.setState({ config: f.owner.current })
  const ipc = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => { await f.owner.edit(expected!, next) })
  await dom.render(<SettingsPanel initialSection="general" onClose={() => {}} />)
  await act(async () => pane('general').querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  await save('general')
  await act(async () => { expect((await Promise.allSettled([ipc.mock.results[0].value])).map(result => result.status)).toEqual(['fulfilled']) })
  await vi.waitFor(async () => expect((await f.disk()).copyPathsAsAbsolute).toBe(true))
  expect((await f.disk()).copyPathsAsAbsolute).toBe(true)
  expect(Object.hasOwn(await f.disk(), 'messageToolInitialLayout')).toBe(false)
})

it.each([['one-line', 'collapsed'], ['two-line', 'current']] as const)(
  'initializes the real Agent composer from %s and keeps the mounted mode and draft after a later preference change', async (layout, initial) => {
    useAppStore.setState({ config: { ...composerConfig, messageToolInitialLayout: layout } })
    await dom.render(<AgentSessionComposer sessionId="agent-1" />)
    expect(phase()).toBe(initial)
    const input = dom.container.querySelector('.composer__editor')
    const originalDraft = dom.draft()
    await dom.click('.composer-tool--mode')
    const manual = phase()
    await act(async () => useAppStore.getState().setConfig({ ...composerConfig, messageToolInitialLayout: layout === 'one-line' ? 'two-line' : 'one-line' }))
    expect(phase()).toBe(manual)
    expect(dom.container.querySelector('.composer__editor')).toBe(input)
    expect(dom.draft()).toBe(originalDraft)
    await dom.render(<AgentSessionComposer key="new-mount" sessionId="agent-1" />)
    expect(phase()).toBe(layout === 'one-line' ? 'current' : 'collapsed')
    expect(dom.draft()).toBe(originalDraft)
  })

it('keeps launcher tools available without a layout toggle', async () => {
  await dom.render(<AgentComposerTools layoutControl={false} disabled={false} commands={[]}
    loadSkills={async () => []} onChooseSkill={() => {}} onCommand={() => {}} runAction={async action => { await action() }} />)
  expect(phase()).toBe('current')
  expect(dom.container.querySelector('.composer-tool--mode')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Choose a skill"]')).not.toBeNull()
})

it('finds the initial layout through the actual settings search and retains the dirty choice', async () => {
  await dom.render(<SettingsPanel initialSection="message-tool" onClose={() => {}} />)
  const original = pane()
  await choose('two-line')
  const search = dom.container.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!
  for (const query of ['Message Tool', 'two lines', '一行', '两行']) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, query)
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(pane()).toBe(original)
    expect(original.hidden).toBe(false)
    expect(original.querySelector<HTMLInputElement>('input[value="two-line"]')!.checked).toBe(true)
  }
})

it('preserves a later edit while the original save is pending', async () => {
  const pending = deferred<void>()
  vi.spyOn(api.config, 'save').mockImplementation(() => pending.promise)
  await dom.render(<SettingsPanel initialSection="message-tool" onClose={() => {}} />)
  await choose('two-line'); await save(); await choose('one-line')
  await act(async () => pending.resolve())
  expect(pane().querySelector<HTMLInputElement>('input[value="one-line"]')!.checked).toBe(true)
  expect(pane().querySelector('[data-settings-save-bar]')!.textContent).toContain('Unsaved changes')
})
