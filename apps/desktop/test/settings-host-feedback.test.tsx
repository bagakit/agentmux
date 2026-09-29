// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AppConfig, HostCheckResult, SshHostConfig } from '../src/shared/contracts'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { WorkspaceSettingsPane } from '../src/renderer/src/components/settings/WorkspaceSettingsPane'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const checkHost = useAppStore.getState().checkHost
const dom = composerDOM()
const remote: SshHostConfig = { id: 'remote', kind: 'ssh', label: 'Saved remote', hostname: 'private.invalid' }
const config: AppConfig = { ...composerConfig, hosts: [composerConfig.hosts[0]!, remote] }
const unavailable = 'Remote AgentMux Runs are not available until the ctxmux Remote contract is delivered.'
const ready = 'Runtime private-build · protocol 1'
const onSave = vi.fn(async () => {})

beforeEach(() => {
  useAppStore.setState({ sessions: [], hostChecks: {}, checkHost })
  onSave.mockClear()
})
const mount = () => dom.render(<HostSettingsPane active={true} config={config} onSave={onSave} />)
function card(index: number) {
  const found = [...dom.container.querySelectorAll<HTMLElement>('.host-settings-card')]
  expect(found).toHaveLength(2)
  return found[index]!
}
function testButton(index: number) {
  const found = [...card(index).querySelectorAll<HTMLButtonElement>('button')].filter(node => node.textContent === 'Test')
  expect(found).toHaveLength(1)
  return found[0]!
}
const status = (index: number) => card(index).querySelector('[role="status"]')?.textContent

it('projects real checkHost pending and ready facts, retaining technical detail in a native disclosure', async () => {
  let resolve!: (value: HostCheckResult) => void
  const pending = new Promise<HostCheckResult>(done => { resolve = done })
  const check = vi.spyOn(api.hosts, 'check').mockReturnValue(pending)
  await mount()
  await act(async () => testButton(0).click())
  expect(check).toHaveBeenCalledExactlyOnceWith(config.hosts[0])
  expect(status(0)).toBe('Testing')
  expect(testButton(0).disabled).toBe(true)
  await act(async () => resolve({ input: config.hosts[0]!, outcome: 'ready', detail: ready }))
  expect(status(0)).toBe('Ready')
  expect(testButton(0).disabled).toBe(false)
  const details = card(0).querySelector<HTMLDetailsElement>('.host-check-details')
  expect(details).not.toBeNull()
  expect(details!.open).toBe(false)
  expect(details!.querySelector('summary')?.textContent?.trim()).toBe('Test details')
  await act(async () => { details!.open = true; details!.dispatchEvent(new Event('toggle')) })
  expect(details!.querySelector('.host-check-detail')?.textContent).toBe(ready)
  expect(card(0).querySelector('header')?.textContent).not.toContain(ready)
  expect(useAppStore.getState().hostChecks.local?.result).toEqual({ input: config.hosts[0]!, outcome: 'ready', detail: ready })
})

it('keeps the complete refusal visible outside connection editing and states the current saving limit honestly', async () => {
  vi.spyOn(api.hosts, 'check').mockResolvedValue({ input: remote, outcome: 'unsupported', detail: unavailable })
  await mount()
  const connection = card(1).querySelector<HTMLDetailsElement>('.host-edit-disclosure')!
  expect(connection.open).toBe(false)
  await act(async () => testButton(1).click())
  expect(status(1)).toBe('Not supported')
  const detail = card(1).querySelector('.host-check-detail')
  expect(detail).not.toBeNull()
  expect(detail!.textContent).toBe(unavailable)
  expect(detail!.closest('details')).toBeNull()
  expect(connection.open).toBe(false)
  const hint = card(1).querySelector('.host-edit-grid .field-hint')?.textContent
  expect(hint).toContain('saving SSH connections are unavailable')
  expect(hint).toContain('draft')
  expect(hint).not.toContain('can save and test')
  expect(useAppStore.getState().hostChecks.remote?.result).toEqual({ input: remote, outcome: 'unsupported', detail: unavailable })
  expect(onSave).not.toHaveBeenCalled()
})

it('preserves literal long diagnostics and per-Host results without replacing the draft or check owner', async () => {
  const detail = `/private/${'unbrokendiagnostic'.repeat(15)}\nOriginal detail <kept> & unchanged.`
  vi.spyOn(api.hosts, 'check').mockImplementation(async host => ({ input: structuredClone(host), outcome: host.kind === 'local' ? 'ready' : 'unsupported', detail: host.kind === 'local' ? ready : detail }))
  await mount()
  const connection = card(1).querySelector<HTMLDetailsElement>('.host-edit-disclosure')!
  await act(async () => { connection.open = true; connection.dispatchEvent(new Event('toggle')) })
  const input = connection.querySelectorAll('input')[1]!
  input.focus()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'authored.invalid')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { testButton(1).click(); testButton(0).click() })
  expect([status(0), status(1)]).toEqual(['Ready', 'Not supported'])
  expect(card(1).querySelector('.host-check-detail')?.textContent).toBe(detail)
  expect(useAppStore.getState().hostChecks.remote?.detail).toBe(detail)
  expect(useAppStore.getState().hostChecks.local?.detail).toBe(ready)
  expect(card(1).querySelector('.host-edit-disclosure')).toBe(connection)
  expect(connection.open).toBe(true)
  expect(connection.querySelectorAll('input')[1]).toBe(input)
  expect(input.value).toBe('authored.invalid')
  expect(onSave).not.toHaveBeenCalled()
})

it('shows a thrown check reason without interpreting idle or missing facts as ready', async () => {
  vi.spyOn(api.hosts, 'check').mockRejectedValue(new Error('Check facts could not be read.'))
  await mount()
  expect(status(0)).toBeUndefined()
  await act(async () => useAppStore.setState({ hostChecks: { local: { state: 'idle' } } }))
  expect(status(0)).toBe('Not tested')
  await act(async () => testButton(1).click())
  expect(status(1)).toBe('Check failed')
  expect(useAppStore.getState().hostChecks.remote?.state).toBe('error')
  expect(useAppStore.getState().hostChecks.remote?.result).toBeUndefined()
  expect(card(1).querySelector('.host-check-detail')?.textContent).toContain('Check facts could not be read.')
  expect(status(0)).toBe('Not tested')
})

async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it.each([
  ['Hostname', 'changed.invalid'], ['User', 'dev'], ['Port', '23'], ['Identity file path', '/private/key']
])('invalidates Ready through every authored %s prefix without dropping focus or disclosure', async (field, value) => {
  useAppStore.setState({ hostChecks: { remote: { state: 'ready', input: remote,
    result: { input: remote, outcome: 'ready', detail: ready }, detail: ready } } })
  await mount()
  expect(status(1)).toBe('Ready')
  const connection = card(1).querySelector<HTMLDetailsElement>('.host-edit-disclosure')!
  await act(async () => { connection.open = true; connection.dispatchEvent(new Event('toggle')) })
  const labels = [...connection.querySelectorAll('label')]
  expect(labels).toHaveLength(5)
  const input = labels.find(label => label.querySelector('span')!.textContent!.startsWith(field))!.querySelector('input')!
  input.focus()
  for (let length = 1; length <= value.length; length++) {
    await fill(input, value.slice(0, length))
    expect(status(1)).toBe('Not tested')
    expect(card(1).querySelector('.host-check-detail')).toBeNull()
    expect(connection.open).toBe(true); expect(input.isConnected).toBe(true)
    expect(document.activeElement).toBe(input); expect(input.value).toBe(value.slice(0, length))
  }
  expect(onSave).not.toHaveBeenCalled()
})

it('ignores a late Ready for the previous draft and preserves latest-wins when a new Test starts', async () => {
  let oldResolve!: (value: HostCheckResult) => void, newResolve!: (value: HostCheckResult) => void
  const old = new Promise<HostCheckResult>(done => { oldResolve = done })
  const next = new Promise<HostCheckResult>(done => { newResolve = done })
  const check = vi.spyOn(api.hosts, 'check').mockReturnValueOnce(old).mockReturnValueOnce(next)
  await mount(); await act(async () => testButton(1).click())
  expect(status(1)).toBe('Testing')
  const connection = card(1).querySelector<HTMLDetailsElement>('.host-edit-disclosure')!
  await act(async () => { connection.open = true; connection.dispatchEvent(new Event('toggle')) })
  const input = connection.querySelectorAll('input')[1]!
  input.focus(); await fill(input, 'new.invalid')
  expect(status(1)).toBe('Not tested'); expect(testButton(1).disabled).toBe(false)
  await act(async () => testButton(1).click())
  expect(status(1)).toBe('Testing')
  const captured = check.mock.calls[1]![0]
  expect(captured).toEqual({ ...remote, hostname: 'new.invalid' })
  await act(async () => oldResolve({ input: remote, outcome: 'ready', detail: 'Old connection' }))
  expect(status(1)).toBe('Testing')
  await act(async () => newResolve({ input: captured, outcome: 'check-failed', detail: 'Current facts could not be read.' }))
  expect(status(1)).toBe('Check failed')
  expect(useAppStore.getState().hostChecks.remote?.input).toEqual(captured)
  expect(input.value).toBe('new.invalid'); expect(connection.open).toBe(true)
  expect(onSave).not.toHaveBeenCalled()
})

it('keeps a late Ready inapplicable after editing when the user has not requested another Test', async () => {
  let resolve!: (value: HostCheckResult) => void
  vi.spyOn(api.hosts, 'check').mockReturnValue(new Promise(done => { resolve = done }))
  await mount(); await act(async () => testButton(1).click())
  const connection = card(1).querySelector<HTMLDetailsElement>('.host-edit-disclosure')!
  await act(async () => { connection.open = true; connection.dispatchEvent(new Event('toggle')) })
  const input = connection.querySelectorAll('input')[1]!
  input.focus(); await fill(input, 'changed.invalid')
  expect(status(1)).toBe('Not tested')
  await act(async () => resolve({ input: remote, outcome: 'ready', detail: 'Old connection' }))
  expect(status(1)).toBe('Not tested'); expect(card(1).querySelector('.host-check-detail')).toBeNull()
  expect(useAppStore.getState().hostChecks.remote?.result?.outcome).toBe('ready')
  expect(input.value).toBe('changed.invalid'); expect(connection.open).toBe(true)
  expect(onSave).not.toHaveBeenCalled()
})

it('does not apply a same-ID committed replacement to old Ready in any of the three mounted consumers', async () => {
  const saved = { ...config, executors: {}, workspaces: [{ ...config.workspaces[0]!, hostId: remote.id }] }
  const changed = { ...saved, hosts: [saved.hosts[0]!, { ...remote, hostname: 'published.invalid' }] }
  useAppStore.setState({ config: saved, hostChecks: { remote: { state: 'ready', input: remote,
    result: { input: remote, outcome: 'ready', detail: ready }, detail: ready },
    local: { state: 'idle' } }, checkHost: vi.fn(async () => {}), detectExecutors: vi.fn(async () => {}),
    activeWorkspaceId: 'workspace',
    tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) },
    agentComposerDrafts: { region: 'Preserved launcher draft' } })
  await dom.render(<HostSettingsPane active={true} config={saved} onSave={onSave} />)
  expect(status(1)).toBe('Ready')
  await dom.render(<HostSettingsPane active={true} config={changed} onSave={onSave} />)
  expect(status(1)).toBe('Not tested')

  await dom.render(<WorkspaceSettingsPane config={saved} onClose={vi.fn()} />)
  const select = () => dom.container.querySelector<HTMLSelectElement>('.workspace-composer select')!
  expect(select()).not.toBeNull(); expect([...select().options].map(option => option.value)).toEqual(['', remote.id])
  await dom.render(<WorkspaceSettingsPane config={changed} onClose={vi.fn()} />)
  expect([...select().options].map(option => option.value)).toEqual([''])

  await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={false} />)
  const badge = () => dom.container.querySelector('.launch-host-health')
  expect(badge()).not.toBeNull(); expect(badge()!.textContent).toBe('Ready')
  await act(async () => useAppStore.setState({ config: changed }))
  expect(badge()!.textContent).toBe('Not tested')
  expect(useAppStore.getState().agentComposerDrafts.region).toBe('Preserved launcher draft')
  expect(onSave).not.toHaveBeenCalled()
})
