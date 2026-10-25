// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentExecutionInspection } from '@agentmux/core'
import type { AppConfig } from '../src/shared/contracts'
import { RemoteExecutionSettingsPane } from '../src/renderer/src/components/settings/RemoteExecutionSettingsPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const sessions = Array.from({ length: 26 }, (_, index) => ({ ...composerSession(`retained-${index}`),
  toolExecution: { bindingId: `binding-${index}`, resourceHostId: index === 25 ? 'remote' : 'local', workspacePath: '/original/project' } }))
let config: AppConfig
let width = 600
let resize: () => void
beforeEach(() => {
  width = 600
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width } as DOMRect))
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} })
  config = { ...composerConfig, hosts: [{ id: 'local', kind: 'local', label: 'Studio' }, { id: 'remote', kind: 'ssh', label: 'Studio', hostname: 'controlled.invalid' }],
    workspaces: [{ id: 'local-project', name: 'Local unrelated project', hostId: 'local', path: '/original/project', kind: 'folder' },
      { id: 'remote-project', name: 'Unique resource project', hostId: 'remote', path: '/original/project', kind: 'folder' }] }
  useAppStore.setState({ config, sessions, activeWorkspaceId: 'remote-project' })
})
async function pane(active = true) {
  await dom.render(<RemoteExecutionSettingsPane config={config} active={active} onClose={() => {}} onNavigate={() => {}} />)
}
async function search(value: string) {
  const input = dom.container.querySelector<HTMLInputElement>('input[type="search"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function fact(): AgentExecutionInspection {
  const session = sessions[25]!
  return { bindingId: session.toolExecution.bindingId, agentSessionId: session.control.agentSessionId, agentHostId: session.control.hostId,
    resourceHostId: session.toolExecution.resourceHostId, resourceWorkspacePath: session.toolExecution.workspacePath, state: 'connected',
    notices: [{ providerId: 'codex', role: 'executor', capability: 'hooks', state: 'unqualified', code: 'UNQUALIFIED', message: 'Original Hooks qualification', action: 'Inspect original Provider' }] }
}

describe('Remote execution reading and navigation', () => {
  it('enters detail among 26 bindings and returns to exact row with the original query and focus', async () => {
    const observe = vi.spyOn(api.sessions, 'observeExecutionBinding').mockReturnValue(vi.fn())
    await pane()
    expect(dom.container.querySelectorAll('[data-resource-row]')).toHaveLength(26)
    await search('original/project')
    await dom.click('[data-resource-row="retained-25"]')
    const library = dom.container.querySelector<HTMLElement>('.remote-execution-library')!
    const detail = dom.container.querySelector<HTMLElement>('.remote-execution-detail')!
    expect(library.hidden).toBe(true)
    expect(detail.hidden).toBe(false)
    expect(document.activeElement).toBe(detail.querySelector('h3'))
    expect(observe).toHaveBeenCalledExactlyOnceWith('binding-25', expect.any(Function), expect.any(Function))
    await dom.click('.remote-execution-back')
    expect(library.hidden).toBe(false)
    expect(detail.hidden).toBe(true)
    expect(dom.container.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('original/project')
    expect(document.activeElement).toBe(dom.container.querySelector('[data-resource-row="retained-25"]'))
  })

  it('releases the hidden reader while retaining the exact detail DOM, inspection and disclosure state', async () => {
    let emit!: (value: AgentExecutionInspection | null) => void
    const stop = vi.fn()
    const observe = vi.spyOn(api.sessions, 'observeExecutionBinding').mockImplementation((_id, listener) => { emit = listener; return stop })
    await pane(); await dom.click('[data-resource-row="retained-25"]')
    await act(async () => emit(fact()))
    const detail = dom.container.querySelector<HTMLElement>('.remote-execution-detail')!
    const identities = detail.querySelector<HTMLDetailsElement>('details')!
    identities.open = true
    await pane(false)
    expect(stop).toHaveBeenCalledOnce()
    expect(dom.container.querySelector('.remote-execution-detail')).toBe(detail)
    expect(identities.open).toBe(true)
    await pane(true)
    await act(async () => emit(null))
    expect(observe).toHaveBeenCalledTimes(2)
    expect(dom.container.querySelector('.remote-execution-detail')).toBe(detail)
    expect(identities.open).toBe(true)
    expect(detail.textContent).toContain('Last confirmed tool connection: connected.')
    expect(detail.textContent).toContain('Original Hooks qualification')
    expect(detail.dataset.remoteBinding).toBe('binding-25')
    expect(useAppStore.getState().sessions).toBe(sessions)
  })

  it('uses current retained Sessions after return and keeps Back available when the old reference is absent', async () => {
    vi.spyOn(api.sessions, 'observeExecutionBinding').mockReturnValue(vi.fn())
    await pane(); await dom.click('[data-resource-row="retained-25"]'); await pane(false)
    await act(async () => useAppStore.setState({ sessions: sessions.slice(0, 25) }))
    await pane(true)
    expect(dom.container.querySelector('[data-remote-open]')).toBeNull()
    expect(dom.container.textContent).toContain('Binding not observed')
    await dom.click('.remote-execution-back')
    expect(dom.container.querySelector<HTMLElement>('.remote-execution-library')!.hidden).toBe(false)
    expect(document.activeElement).toBe(dom.container.querySelector('input[type="search"]'))
  })

  it('searches the exact resource project and includes its path in the row', async () => {
    await pane(); await search('Unique resource project')
    const rows = dom.container.querySelectorAll('[data-resource-row]')
    expect(rows).toHaveLength(1)
    expect((rows[0] as HTMLElement).dataset.resourceRow).toBe('retained-25')
    expect(rows[0]!.textContent).toContain('Unique resource project')
    expect(rows[0]!.textContent).toContain('/original/project')
    expect(rows[0]!.textContent).not.toContain('Local unrelated project')
  })

  it('shows the full selected Host ID and absolute path outside the native select', async () => {
    config = { ...config, workspaces: config.workspaces.map(project => project.id !== 'remote-project' ? project : { ...project,
      name: 'An exceptionally long project name for the resource workstation', path: '/original/project/with/a/long/unambiguous/resource/location' }) }
    await pane()
    const target = dom.container.querySelector('[aria-label="Selected project identity"]')!
    expect(target.textContent).toContain('An exceptionally long project name for the resource workstation')
    expect([...target.querySelectorAll('code')].map(node => node.textContent)).toEqual(['remote', '/original/project/with/a/long/unambiguous/resource/location'])
    expect(dom.container.querySelector<HTMLButtonElement>('[data-remote-prepare]')!.disabled).toBe(false)
    width = 1000; await act(async () => resize())
    await dom.click('[data-resource-row="retained-25"]')
    expect(dom.container.querySelector<HTMLElement>('.remote-execution-library')!.hidden).toBe(false)
  })
})
