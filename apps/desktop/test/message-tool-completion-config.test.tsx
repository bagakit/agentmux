// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { DEFAULT_COMPOSER_INPUT_CONFIG, resolveComposerInputConfig, validateComposerInputConfig } from '@agentmux/client-ui/composer-input-config'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { ObjectCliProbe } from '../../../packages/core/test/helpers/object-cli-rpc'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'
import { ConfigStore } from '../src/main/config-store'
import { executeSettingsControl } from '../src/main/settings-control'
import type { AppConfig } from '../src/shared/contracts'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'completion-preference' } as const
const pane = () => dom.container.querySelector<HTMLElement>('[data-message-tool-completion]')!
const field = (name: string) => pane().querySelector<HTMLInputElement>(`[aria-label="${name} prefix"]`)!
async function fill(name: string, value: string) {
  const input = field(name)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function save() { await act(async () => pane().querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!.click()) }
function connectConfig(f: Awaited<ReturnType<typeof configOwnerFixture>>) {
  useAppStore.setState({ config: f.owner.current })
  return vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => {
    const saved = await f.owner.edit(expected!, next)
    useAppStore.getState().setConfig(saved)
    return saved
  })
}

it('keeps stable default and authored identities; validates literal unambiguous prefixes', () => {
  expect(resolveComposerInputConfig()).toBe(DEFAULT_COMPOSER_INPUT_CONFIG)
  expect(resolveComposerInputConfig(null)).toBe(DEFAULT_COMPOSER_INPUT_CONFIG)
  const authored = { command: '::', skill: null, reference: '#', keywords: false }
  expect(resolveComposerInputConfig(authored)).toBe(authored)
  expect(validateComposerInputConfig(authored)).toBeNull()
  for (const value of [null, [], {}, { ...authored, command: '' }, { ...authored, command: 'say' }, { ...authored, command: '\n' }, { ...authored, command: ' # ' }, { ...authored, skill: '#' }, { ...authored, skill: ':::' }, { ...authored, keywords: 'false' }, { ...authored, extra: true }]) {
    expect(validateComposerInputConfig(value), JSON.stringify(value)).toEqual(expect.any(String))
  }
})

it('discovers defaults without a write, persists explicit disable and custom symbols through public settings, and reopens original config', async () => {
  const f = await configOwnerFixture(), original = f.owner.current, bytes = await f.bytes()
  const result = await executeSettingsControl({ ...envelope, operation: 'settings.get', target: 'messageToolCompletion' }, f.owner)
  expect(result).toEqual({ operation: 'settings.get', partial: true, entries: [
    { key: 'messageToolCompletion.command', kind: 'string', value: '/', default: '/' },
    { key: 'messageToolCompletion.skill', kind: 'string', value: '$', default: '$' },
    { key: 'messageToolCompletion.reference', kind: 'string', value: '@', default: '@' },
    { key: 'messageToolCompletion.keywords', kind: 'boolean', value: true, default: true }
  ] })
  if (result.operation !== 'settings.get') throw new Error('Expected inspection')
  for (const entry of result.entries) await executeSettingsControl({ ...envelope, operation: 'settings.set', key: entry.key, value: String(entry.value) }, f.owner)
  expect(await f.bytes()).toBe(bytes)
  expect(f.save).not.toHaveBeenCalled()
  expect(f.owner.current).toBe(original)
  for (const [key, value] of [['command', '::'], ['skill', ''], ['reference', '#'], ['keywords', 'false']]) {
    await executeSettingsControl({ ...envelope, operation: 'settings.set', key: `messageToolCompletion.${key}`, value: value! }, f.owner)
  }
  const authored = { command: '::', skill: null, reference: '#', keywords: false }
  expect(await f.disk()).toEqual({ ...original, messageToolCompletion: authored })
  expect((await new ConfigStore(f.store.filePath).get()).messageToolCompletion).toEqual(authored)
  const saved = await f.bytes()
  for (const value of ['#', ':::', ' ', 'abc', '\0']) {
    await expect(executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'messageToolCompletion.skill', value }, f.owner)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  }
  await expect(f.store.save({ ...f.owner.current, messageToolCompletion: { ...authored, skill: '#' } })).rejects.toThrow('Shortcut prefixes')
  expect(await f.bytes()).toBe(saved)
})

it('the actual compiled CLI and original RPC service inspect and set the same durable preferences', async () => {
  const f = await configOwnerFixture(), service = new AgentMuxRpcService({ execute: request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Unexpected non-settings request')
    return executeSettingsControl(request, f.owner)
  } })
  const principal = { transport: 'unix', principal: { kind: 'user', id: 'completion-settings-test' } } as const
  const probe = new ObjectCliProbe(request => service.call(request.method as never, request.params as never, principal))
  await probe.start()
  try {
    const inspection = await probe.run(['settings', 'inspect', 'messageToolCompletion'])
    expect(inspection.code, inspection.stderr).toBe(0)
    expect(JSON.parse(inspection.stdout).result.entries).toHaveLength(4)
    const disabled = await probe.run(['settings', 'set', 'messageToolCompletion.skill', ''])
    expect(disabled.code, disabled.stderr).toBe(0)
    expect(JSON.parse(disabled.stdout).result.entry).toEqual({ key: 'messageToolCompletion.skill', kind: 'string', value: '', default: '$' })
    expect((await new ConfigStore(f.store.filePath).get()).messageToolCompletion?.skill).toBeNull()
    const changed = await probe.run(['settings', 'set', 'messageToolCompletion.command', '::'])
    expect(changed.code, changed.stderr).toBe(0)
    expect((await f.disk()).messageToolCompletion).toEqual({ ...DEFAULT_COMPOSER_INPUT_CONFIG, command: '::', skill: null })
    expect(probe.requests.map(request => request.method)).toEqual(['settings.inspect', 'settings.set', 'settings.set'])
  } finally { await probe.stop() }
})

it('saves through the actual Settings adapter, preserves unrelated concurrent changes and reloads the selected values', async () => {
  const f = await configOwnerFixture(), ipc = connectConfig(f)
  await dom.render(<SettingsPanel initialSection="message-tool" onClose={() => {}} />)
  expect(field('Commands').value).toBe('/')
  await fill('Commands', '::'); await fill('Skills', '')
  await act(async () => pane().querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  await f.owner.update(current => ({ ...current, copyPathsAsAbsolute: true }))
  await save()
  await vi.waitFor(() => expect(pane().textContent).toContain('Changes saved'))
  expect(ipc).toHaveBeenCalledTimes(1)
  expect((await f.disk()).workspaces).toEqual(f.owner.current.workspaces)
  const reopened = await new ConfigStore(f.store.filePath).get()
  expect(reopened.messageToolCompletion).toEqual({ command: '::', skill: null, reference: '@', keywords: false })
  expect(reopened.copyPathsAsAbsolute).toBe(true)
  await dom.render(<SettingsPanel key="reopened" initialSection="message-tool" onClose={() => {}} />)
  expect(field('Commands').value).toBe('::')
  expect(field('Skills').value).toBe('')
  expect(pane().querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false)
})

it('keeps malformed choices local and preserves a genuine same-field conflict without publishing a success', async () => {
  const f = await configOwnerFixture(), ipc = connectConfig(f), bytes = await f.bytes()
  await dom.render(<SettingsPanel initialSection="message-tool" onClose={() => {}} />)
  await fill('Commands', '@')
  expect(pane().textContent).toContain('cannot begin with one another')
  expect(pane().querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!.disabled).toBe(true)
  expect(await f.bytes()).toBe(bytes)
  expect(ipc).not.toHaveBeenCalled()
  await fill('Commands', '::')
  const current = f.owner.current
  await act(async () => {
    const changed = await f.owner.edit(current, { ...current, messageToolCompletion: { ...DEFAULT_COMPOSER_INPUT_CONFIG, command: '!' } })
    useAppStore.getState().setConfig(changed)
  })
  expect(field('Commands').value).toBe('::')
  await save()
  await vi.waitFor(() => expect(pane().textContent).toContain('changed since you started editing'))
  expect(field('Commands').value).toBe('::')
  expect((await f.disk()).messageToolCompletion?.command).toBe('!')
  expect(pane().querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!.disabled).toBe(false)
})

it('merges different concurrent first edits while retaining an explicit null as the authored choice', async () => {
  const f = await configOwnerFixture(), original = f.owner.current
  const baseline = { ...original, messageToolCompletion: { ...DEFAULT_COMPOSER_INPUT_CONFIG } }
  await f.owner.edit(baseline, { ...baseline, messageToolCompletion: { ...DEFAULT_COMPOSER_INPUT_CONFIG, skill: null } })
  const saved = await f.owner.edit(baseline, { ...baseline, messageToolCompletion: { ...DEFAULT_COMPOSER_INPUT_CONFIG, reference: '#' } })
  expect(saved.messageToolCompletion).toEqual({ command: '/', skill: null, reference: '#', keywords: true })
  expect((await new ConfigStore(f.store.filePath).get()).messageToolCompletion).toEqual(saved.messageToolCompletion)
})

it('retains edits made while the original save is pending', async () => {
  const f = await configOwnerFixture(), pending = deferred<AppConfig>()
  useAppStore.setState({ config: f.owner.current })
  vi.spyOn(api.config, 'save').mockImplementation(() => pending.promise)
  await dom.render(<SettingsPanel initialSection="message-tool" onClose={() => {}} />)
  await fill('Commands', '::'); await save(); await fill('Commands', '!')
  await act(async () => pending.resolve(f.owner.current))
  expect(field('Commands').value).toBe('!')
  expect(pane().textContent).toContain('Unsaved changes')
})
