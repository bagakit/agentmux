import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig, HostConfig, HostCheckResult, SshHostConfig } from '../src/shared/contracts'
import type { SettingsNavigationRequest } from '../src/renderer/src/components/SettingsNavigation'
import { AgentSettingsPane } from '../src/renderer/src/components/settings/AgentSettingsPane'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { agentsSettingsModule } from '../src/renderer/src/components/settings/modules/agents'
import { hostsSettingsModule } from '../src/renderer/src/components/settings/modules/hosts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const section = process.env.AGENTMUX_RESOURCE_LIBRARY_SECTION
const originalCheckHost = useAppStore.getState().checkHost
let config: AppConfig, unsubscribe: (() => void) | undefined
const A = 'executor-001', B = 'executor-002', H = 'host-01', J = 'host-02'
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(async () => {
  const before = await api.config.get(), templates = Object.values(before.executors)
  config = await api.config.save({ ...before,
    executors: Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`executor-${String(index + 1).padStart(3, '0')}`, {
      ...templates[0]!, label: `Executor ${String(index + 1).padStart(3, '0')}`, args: ['--model', 'literal model'], env: { LITERAL: '$HOME remains literal' }
    }])),
    hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }, ...Array.from({ length: 23 }, (_, index) => ({
      id: `host-${String(index + 1).padStart(2, '0')}`, kind: 'ssh' as const, label: `Remote ${String(index + 1).padStart(2, '0')}`,
      hostname: `controlled-${index + 1}.invalid`, user: 'author', port: 2222, identityFile: '~/.ssh/literal key',
      remoteCommand: (_hygiene_fixturePath("opt/agentmux") + " --literal"), remoteSocketPath: _hygiene_fixturePath("srv/literal.sock"), runtimeId: 'bound-runtime'
    }))],
    workspaces: [{ id: 'project-a', name: 'A', kind: 'folder', hostId: H, path: _hygiene_fixturePath("controlled/a") },
      { id: 'project-b', name: 'B', kind: 'folder', hostId: H, path: _hygiene_fixturePath("controlled/b") }]
  }, before)
  useAppStore.setState({ config, sessions: [], sessionSnapshots: {}, activeWorkspaceId: 'project-a',
    providerCatalog: await api.providers.list(), executorDetections: {}, hostChecks: {},
    detectExecutors: vi.fn(async () => {}), checkHost: originalCheckHost })
  unsubscribe = api.config.onChange(next => useAppStore.setState({ config: next }))
})
afterEach(() => unsubscribe?.())

function LivePane({ kind, active = true }: { kind: 'agents' | 'hosts'; active?: boolean }) {
  const current = useAppStore(state => state.config)!
  const Pane = kind === 'agents' ? agentsSettingsModule.Pane : hostsSettingsModule.Pane
  return <div className="settings-page"><Pane config={current} active={active} onClose={() => {}} /></div>
}
const editor = () => dom.container.querySelector<HTMLElement>('[data-resource-editor]')!
const name = () => editor().querySelector<HTMLInputElement>('[data-executor-name],[data-host-name]')!
function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const labelNode = [...editor().querySelectorAll('label')].find(node => node.querySelector('span')?.textContent?.startsWith(label))!
  expect(labelNode, `Actual field ${label} exists`).toBeDefined()
  return labelNode.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')!
}
async function fill(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function select(id: string) { await dom.click(`[data-resource-row="${id}"]`) }
async function toggle(selector: string, open: boolean) {
  const node = editor().querySelector<HTMLDetailsElement>(selector)!
  expect(node).not.toBeNull()
  // Happy DOM has no native summary activation. Trusted disclosure/visibility belongs to Chromium capture.
  await act(async () => { node.open = open; node.dispatchEvent(new Event('toggle')) })
}
async function save() { await dom.click('[data-settings-save-bar] button'); await act(async () => {}) }

describe.skipIf(section !== 'agents')('Agents resource library', () => {
  it('single: only mounts the accurate selected field subtree among 128 real records', async () => {
    await dom.render(<LivePane kind="agents" />)
    expect(dom.container.querySelectorAll('[data-resource-row]')).toHaveLength(128)
    expect(dom.container.querySelectorAll('[data-resource-editor]'), 'Only the selected Executor owns a field subtree').toHaveLength(1)
    expect(editor().dataset.resourceEditor).toBe(A)
    await select(B)
    expect(dom.container.querySelectorAll('[data-resource-editor]')).toHaveLength(1)
    expect(editor().dataset.resourceEditor).toBe(B)
    expect(editor().querySelector('.settings-executor-identity')!.textContent).toContain(B)
    expect([...editor().querySelectorAll('label')].some(node => node.querySelector('span')?.textContent === 'Provider')).toBe(false)
    await dom.render(<AgentSettingsPane config={config} executorId="missing-executor" onSave={async () => {}} />)
    expect(dom.container.querySelectorAll('[data-resource-editor]')).toHaveLength(0)
    expect(dom.container.textContent).toContain('Executor unavailable')
    await dom.render(<AgentSettingsPane config={{ ...config, executors: {} }} onSave={async () => {}} />)
    expect(dom.container.querySelectorAll('[data-resource-editor]')).toHaveLength(0)
  })
  it('drafts: selected-only mounting keeps the complete authored library and per-ID disclosure', async () => {
    await dom.render(<LivePane kind="agents" />)
    await toggle('.settings-launch-config', true)
    await fill(name(), 'Authored custom name')
    await fill(field('Arguments'), '--model "authored literal"')
    await fill(field('Environment'), '{"AUTHORED":"$HOME"}')
    await select(B)
    await fill(name(), 'Second authored name')
    await select(A)
    expect(name().value, 'Changing selection preserves the original authored Executor draft').toBe('Authored custom name')
    expect(editor().querySelector<HTMLDetailsElement>('.settings-launch-config')!.open).toBe(true)
    expect(field('Arguments').value).toBe('--model "authored literal"')
    expect(field('Environment').value).toBe('{"AUTHORED":"$HOME"}')
    await dom.click('.settings-resource-back')
    expect(document.activeElement).toBe(dom.container.querySelector(`[data-resource-row="${A}"]`))
    await select(A); await save()
    const current = await api.config.get()
    expect(current.executors[A]!.args).toEqual(['--model', 'authored literal'])
    expect(current.executors[A]!.env).toEqual({ AUTHORED: '$HOME' })
    expect(current.executors[B]!.label).toBe('Second authored name')
  })
  it('navigation: a new same-ID request clears filtering without replacing its draft', async () => {
    const render = (navigationRequest: SettingsNavigationRequest) => dom.render(<AgentSettingsPane config={config} navigationRequest={navigationRequest} active={true} onSave={async () => {}} />)
    await render({ section: 'agents', executorId: A })
    await fill(name(), 'Retained authored name')
    const search = dom.container.querySelector<HTMLInputElement>('[aria-label="Filter executors"]')!
    await fill(search, 'Executor 002')
    expect(dom.container.querySelectorAll('[data-resource-row]')).toHaveLength(1)
    await render({ section: 'agents', executorId: A })
    expect(search.value, 'New same-ID navigation request clears resource filtering').toBe('')
    expect(dom.container.querySelectorAll('[data-resource-row]')).toHaveLength(128)
    expect(editor().dataset.resourceEditor).toBe(A); expect(name().value).toBe('Retained authored name')
    expect(document.activeElement).toBe(name())
  })
  it('keeps a stable search snapshot during each rename prefix and an explicit inactive probe boundary', async () => {
    await dom.render(<LivePane kind="agents" />)
    await fill(dom.container.querySelector<HTMLInputElement>('[aria-label="Filter executors"]')!, 'Executor 001')
    const input = name(); input.focus()
    for (const value of ['X', 'XY', 'XYZ']) {
      await fill(input, value)
      expect(name()).toBe(input); expect(input.isConnected).toBe(true); expect(document.activeElement).toBe(input)
      expect(dom.container.querySelector(`[data-resource-row="${A}"]`)).not.toBeNull()
    }
    const detect = vi.mocked(useAppStore.getState().detectExecutors)
    const calls = detect.mock.calls.length
    await dom.render(<LivePane kind="agents" active={false} />)
    await act(async () => useAppStore.setState({ config: { ...config, executors: { ...config.executors, extra: config.executors[A]! } } }))
    expect(detect.mock.calls).toHaveLength(calls)
    expect(name().value).toBe('XYZ')
  })
  it('uses manual keyboard focus, accurate creation focus and a connected legal target after filtered deletion', async () => {
    await dom.render(<LivePane kind="agents" />)
    const row = dom.container.querySelector<HTMLButtonElement>(`[data-resource-row="${A}"]`)!
    row.focus()
    await act(async () => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement).toBe(dom.container.querySelector(`[data-resource-row="${B}"]`))
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement?.getAttribute('tabindex')).toBe('0')
    await select(B); expect(document.activeElement).toBe(name())
    await act(async () => [...dom.container.querySelectorAll<HTMLButtonElement>('.settings-pane-toolbar button')].find(node => node.textContent?.includes('Add executor'))!.click())
    const created = editor().dataset.resourceEditor!
    expect(Object.hasOwn(config.executors, created)).toBe(false)
    expect(name().isConnected).toBe(true); expect(document.activeElement).toBe(name())
    expect(name().selectionStart).toBe(0); expect(name().selectionEnd).toBe(name().value.length)
    expect([...editor().querySelectorAll('label')].some(node => node.querySelector('span')?.textContent === 'Provider')).toBe(true)
    await select(A)
    await fill(dom.container.querySelector<HTMLInputElement>('[aria-label="Filter executors"]')!, 'Executor 001')
    await dom.click('.settings-executor-remove button')
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Filter executors"]')!.value).toBe('')
    expect(editor().dataset.resourceEditor).toBe(B)
    expect(document.activeElement).toBe(dom.container.querySelector(`[data-resource-row="${B}"]`))
    await dom.render(<AgentSettingsPane config={{ ...config, executors: { [A]: config.executors[A]! } }} onSave={async () => {}} />)
    await dom.click('.settings-executor-remove button')
    expect(dom.container.querySelectorAll('[data-resource-editor]')).toHaveLength(0)
    expect(document.activeElement).toBe(dom.container.querySelector('[aria-label="Filter executors"]'))
  })
  it('preserves pending edits, clean external fields, authored conflicts and external-delete failures', async () => {
    await dom.render(<LivePane kind="agents" />)
    await fill(name(), 'First submission')
    const held = deferred<void>(), realSave = api.config.save.bind(api.config)
    const spy = vi.spyOn(api.config, 'save').mockImplementationOnce(async (next, expected) => { const result = await realSave(next, expected); await held.promise; return result })
    await dom.click('[data-settings-save-bar] button'); await fill(name(), config.executors[A]!.label)
    await act(async () => held.resolve()); await act(async () => {})
    expect(name().value).toBe(config.executors[A]!.label)
    await save()
    expect(spy.mock.calls[1]![1]!.executors[A]!.label).toBe('First submission')
    await fill(name(), 'Local authored name')
    let current = await api.config.get()
    await act(async () => realSave({ ...current, executors: { ...current.executors, [A]: { ...current.executors[A]!, command: 'external-command' } } }, current))
    await save()
    expect(spy.mock.calls.at(-1)![1]!.executors[A]!.command).toBe('external-command')
    expect((await api.config.get()).executors[A]!.label).toBe('Local authored name')
    await fill(name(), 'Local conflict')
    current = await api.config.get()
    await act(async () => realSave({ ...current, executors: { ...current.executors, [A]: { ...current.executors[A]!, label: 'External conflict' } } }, current))
    await save()
    expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain(`executors.${A}.label`)
    expect(name().value).toBe('Local conflict')
    current = await api.config.get()
    const remaining = { ...current.executors }; delete remaining[A]
    await act(async () => realSave({ ...current, executors: remaining }, current))
    await save()
    expect(name().value).toBe('Local conflict')
    expect(editor().querySelector('.settings-executor-identity')).not.toBeNull()
    expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain(`executors.${A}`)
  })
})

describe.skipIf(section !== 'hosts')('Hosts resource library', () => {
  it('single: only mounts the exact SSH field subtree among 24 real connections', async () => {
    await dom.render(<LivePane kind="hosts" />)
    expect(dom.container.querySelectorAll('[data-resource-row]')).toHaveLength(24)
    expect(dom.container.querySelectorAll('.host-connection-fields'), 'Local detail has no SSH field subtree').toHaveLength(0)
    await select(H)
    expect(dom.container.querySelectorAll('.host-connection-fields'), 'Only the selected Host owns an SSH field subtree').toHaveLength(1)
    expect(dom.container.querySelectorAll('[data-resource-editor]')).toHaveLength(1)
    expect(editor().dataset.resourceEditor).toBe(H)
    const basic = [...editor().querySelectorAll('.host-edit-grid--basic label > span')].map(node => node.textContent)
    expect(basic).toEqual(['Name', 'Host or SSH alias'])
    expect(field('Bound Runtime ID').readOnly).toBe(true)
  })
  it('disclosure: remembers every selected Host field and its independent advanced choice', async () => {
    await dom.render(<LivePane kind="hosts" />); await select(H)
    await toggle('.host-edit-disclosure', true)
    await fill(name(), 'Authored Host')
    await fill(field('Host or SSH alias'), 'literal-alias')
    await fill(field('User'), 'authored-user')
    await fill(field('Port'), '2201')
    await fill(field('Identity file path'), '~/.ssh/authored key')
    await fill(field('Service command'), (_hygiene_fixturePath("opt/custom") + " --literal"))
    await fill(field('Service socket path'), _hygiene_fixturePath("srv/authored.sock"))
    await select(J)
    expect(editor().querySelector<HTMLDetailsElement>('.host-edit-disclosure')!.open).toBe(false)
    await select(H)
    expect(editor().querySelector<HTMLDetailsElement>('.host-edit-disclosure')!.open, 'Switching away and back preserves this Host advanced disclosure').toBe(true)
    expect(name().value).toBe('Authored Host'); expect(field('Host or SSH alias').value).toBe('literal-alias')
    const input = field('User'); input.focus()
    for (const value of ['a', 'ab', 'abc']) {
      await fill(input, value)
      expect(field('User')).toBe(input); expect(document.activeElement).toBe(input); expect(input.isConnected).toBe(true)
      expect(editor().querySelector<HTMLDetailsElement>('.host-edit-disclosure')!.open).toBe(true)
    }
    await save()
    expect((await api.config.get()).hosts.find(host => host.id === H)).toMatchObject({ hostname: 'literal-alias', user: 'abc', port: 2201,
      identityFile: '~/.ssh/authored key', remoteCommand: (_hygiene_fixturePath("opt/custom") + " --literal"), remoteSocketPath: _hygiene_fixturePath("srv/authored.sock"), runtimeId: 'bound-runtime' })
  })
  it('captured: Test captures all edited fields and a later field never inherits its Ready', async () => {
    await dom.render(<LivePane kind="hosts" />); await select(H); await toggle('.host-edit-disclosure', true)
    const held = deferred<HostCheckResult>()
    const check = vi.spyOn(api.hosts, 'check').mockReturnValueOnce(held.promise)
    await fill(field('Host or SSH alias'), 'controlled-alias'); await fill(field('User'), 'typed-user')
    await fill(field('Port'), '2301'); await fill(field('Identity file path'), '~/.ssh/captured')
    await fill(field('Service command'), _hygiene_fixturePath("opt/captured")); await fill(field('Service socket path'), _hygiene_fixturePath("srv/captured.sock"))
    await act(async () => [...editor().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Test')!.click())
    const captured: SshHostConfig = { ...(config.hosts.find(host => host.id === H) as SshHostConfig), hostname: 'controlled-alias', user: 'typed-user',
      port: 2301, identityFile: '~/.ssh/captured', remoteCommand: _hygiene_fixturePath("opt/captured"), remoteSocketPath: _hygiene_fixturePath("srv/captured.sock") }
    expect(check.mock.calls[0]![0], 'Test captures the complete authored Host configuration').toEqual(captured)
    await fill(field('Service socket path'), _hygiene_fixturePath("srv/later.sock"))
    await act(async () => held.resolve({ input: captured, outcome: 'ready', detail: 'Controlled service readback' }))
    expect(editor().querySelector('[role="status"]')!.textContent).toBe('Not tested')
    expect(useAppStore.getState().hostChecks[H]!.input).toEqual(captured)
    expect(field('Service socket path').value).toBe(_hygiene_fixturePath("srv/later.sock"))
  })
  it('keeps device access separate and inactive until opened; ordinary selection does not read authorization', async () => {
    const devices = vi.spyOn(api.deviceManagement, 'ls')
    await dom.render(<LivePane kind="hosts" />)
    await select(H); await select(J)
    expect(devices).not.toHaveBeenCalled()
    const disclosure = dom.container.querySelector<HTMLDetailsElement>('.settings-device-access')!
    await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')) })
    expect(devices).toHaveBeenCalledExactlyOnceWith({})
    await dom.render(<LivePane kind="hosts" active={false} />)
    expect(devices).toHaveBeenCalledTimes(1)
  })
  it('focuses accurate new Host fields and preserves original workspace confirmation with a legal deletion target', async () => {
    await dom.render(<LivePane kind="hosts" />)
    await act(async () => [...dom.container.querySelectorAll<HTMLButtonElement>('.settings-pane-toolbar button')].find(node => node.textContent?.includes('Add SSH host'))!.click())
    const created = editor().dataset.resourceEditor!
    expect(config.hosts.some(host => host.id === created)).toBe(false)
    expect(name().isConnected).toBe(true); expect(document.activeElement).toBe(name())
    expect(name().selectionStart).toBe(0); expect(name().selectionEnd).toBe(name().value.length)
    await select(H)
    await fill(dom.container.querySelector<HTMLInputElement>('[aria-label="Filter hosts"]')!, 'Remote 01')
    await dom.click(`[aria-label="Remove ${config.hosts.find(host => host.id === H)!.label}"]`)
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('2 linked workspace registrations')
    expect((await api.config.get()).hosts.some(host => host.id === H)).toBe(true)
    await act(async () => document.querySelector<HTMLButtonElement>('.confirmation-dialog__cancel')!.click())
    expect(editor().dataset.resourceEditor).toBe(H)
    // Delete a saved, non-current neighbor so this step does not silently save the invalid new draft.
    await fill(field('Host or SSH alias'), 'controlled-host')
    const first = config.hosts.find(host => host.id === H)!
    await dom.render(<HostSettingsPane config={{ ...config, hosts: [config.hosts[0]!, first], workspaces: config.workspaces }} active={true} onSave={async () => {}} />)
    await select(H)
    await fill(dom.container.querySelector<HTMLInputElement>('[aria-label="Filter hosts"]')!, 'Remote 01')
    await dom.click(`[aria-label="Remove ${first.label}"]`)
    await act(async () => document.querySelector<HTMLButtonElement>('[data-confirm-label="Remove Host"]')!.click())
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Filter hosts"]')!.value).toBe('')
    expect(dom.container.querySelectorAll('.host-connection-fields')).toHaveLength(0)
    expect(editor().dataset.resourceEditor).toBe('local')
    expect(document.activeElement).toBe(dom.container.querySelector('[data-resource-row="local"]'))
  })
  it('preserves pending/clean/conflict/delete authored baselines through the original module save', async () => {
    await dom.render(<LivePane kind="hosts" />); await select(H)
    await fill(name(), 'First Host submission')
    const held = deferred<void>(), realSave = api.config.save.bind(api.config)
    const spy = vi.spyOn(api.config, 'save').mockImplementationOnce(async (next, expected) => { const accepted = await realSave(next, expected); await held.promise; return accepted })
    await dom.click('[data-settings-save-bar] button'); await fill(name(), 'Remote 01')
    await act(async () => held.resolve()); await act(async () => {})
    expect(name().value).toBe('Remote 01'); await save()
    expect(spy.mock.calls[1]![1]!.hosts.find(host => host.id === H)!.label).toBe('First Host submission')
    await fill(name(), 'Local authored Host')
    let current = await api.config.get()
    const change = (host: HostConfig): HostConfig => host.id === H && host.kind === 'ssh' ? { ...host, user: 'external-clean' } : host
    await act(async () => realSave({ ...current, hosts: current.hosts.map(change) }, current)); await save()
    expect(spy.mock.calls.at(-1)![1]!.hosts.find(host => host.id === H)).toMatchObject({ user: 'external-clean' })
    await fill(name(), 'Local Host conflict')
    current = await api.config.get()
    await act(async () => realSave({ ...current, hosts: current.hosts.map(host => host.id === H ? { ...host, label: 'External Host conflict' } : host) }, current)); await save()
    expect(name().value).toBe('Local Host conflict'); expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain(`hosts.${H}.label`)
    current = await api.config.get()
    await act(async () => realSave({ ...current, hosts: current.hosts.filter(host => host.id !== H) }, current)); await save()
    expect(name().value).toBe('Local Host conflict'); expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain(`hosts.${H}`)
  })
})
