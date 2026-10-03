// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'

const dom = composerDOM(), openHost = vi.fn()
beforeEach(() => {
  openHost.mockClear()
  useAppStore.setState({ config: { ...composerConfig, hosts: [...composerConfig.hosts,
    { id: 'remote-id', kind: 'ssh', label: 'Build server', hostname: 'literal.invalid' }] },
    runtimeEndpointWarnings: [{ hostId: 'remote-id', step: 'Connecting to Runtime', code: 'REMOTE_CORE_UPGRADE_REQUIRED',
      message: 'Original technical receipt problem', recovery: 'Original recovery facts', availability: 'unverified' }],
    runtimeOwnershipWarnings: [], environmentWarning: undefined, loading: false, displacedAgentSessionIds: [],
    sessions: [], workbenchSaveWarning: null, nameSaveUnconfirmed: null, nameEditFailure: null,
    error: null, lastError: null, desktopNavigationNotice: null })
})
const mount = () => dom.render(<SettingsNavigation.Provider value={{ open: vi.fn(), openToolkit: vi.fn(), openHost }}><GlobalSystemNotices /></SettingsNavigation.Provider>)
it('explains the exact Host on the first surface and uses real settings navigation without changing healthy inputs', async () => {
  const drafts = useAppStore.getState().agentComposerDrafts, tabs = useAppStore.getState().tabs
  await mount()
  const notice = dom.container.querySelector('.service-window')!
  expect(notice.querySelector('.service-window__step')!.textContent).toBe('Build server: Remote service needs an update')
  expect(notice.querySelector('.service-window__mode')!.textContent).toContain('older Core interface')
  expect(notice.querySelector('details')!.textContent).toContain('Original technical receipt problem')
  await dom.click('.global-system-notices__action')
  expect(openHost).toHaveBeenCalledExactlyOnceWith('remote-id')
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect(useAppStore.getState().tabs).toBe(tabs)
})
it('keeps an unknown handshake distinct from a version update and retains its original reason', async () => {
  useAppStore.setState({ runtimeEndpointWarnings: [{ hostId: 'remote-id', step: 'Connecting to Runtime',
    code: 'CONTROL_PROTOCOL_ERROR', message: 'Arbitrary malformed result', recovery: 'Retry observation' }] })
  await mount()
  const notice = dom.container.querySelector('.service-window')!
  expect(notice.querySelector('.service-window__step')!.textContent).toBe('Build server: Connection could not be verified')
  expect(notice.querySelector('.service-window__mode')!.textContent).toContain('unconfirmed')
  expect(notice.querySelector('.service-window__mode')!.textContent).not.toContain('older')
  expect(notice.querySelector('details')!.textContent).toContain('Arbitrary malformed result')
})
