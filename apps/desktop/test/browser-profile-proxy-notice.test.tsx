// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()

it('shows an idle Profile notice in the real Pane and never carries Dismiss to another same-named Profile', async () => {
  const page = await api.browser.create('proxy-notice-page', 'https://example.invalid/auth', 'workspace')
  const activity = { operation: null, control: 'human' as const,
    warning: 'Profile “Work”: The proxy asks for a sign-in. Browser controls remain available. Open Settings → Browser Profiles → Work → Proxy sign-in.' }
  const region = { ...page, kind: 'browser' as const, browserId: page.id, regionId: 'notice-region', workspaceId: 'workspace', profileId: 'profile-one' }
  useAppStore.setState({ toolsOpen: false, browserOpinionDrafts: {}, tabs: { 'notice-tab': createWorkbenchTab('notice-tab', region) } })
  function CurrentPane() {
    const surface = useAppStore(state => state.tabs['notice-tab']!.regions['notice-region']!)
    return surface.kind === 'browser' ? <BrowserPane tab={surface} visible /> : null
  }
  await dom.render(<CurrentPane />)
  const update = (profileId: string) => act(async () => useAppStore.getState().applyBrowserEvent({
    type: 'updated', browser: { ...page, profileId, activity }
  }))
  await update('profile-one')
  expect(dom.container.querySelector('.browser-operation-warning')?.textContent).toContain('Settings → Browser Profiles')
  await dom.click('[aria-label="Dismiss this Browser notice"]')
  expect(dom.container.querySelector('.browser-operation-warning')).toBeNull()
  await update('profile-two')
  expect(dom.container.querySelector('.browser-operation-warning')?.textContent).toContain('proxy asks for a sign-in')
  expect(dom.container.querySelector('.browser-rsi-timeline')).toBeNull()
})
