// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__',true))
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({TerminalView:()=>null}))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({SurfaceToolDock:()=>null}))
import { App } from '../src/renderer/src/App'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
const dom = composerDOM()
it('opens visible Host settings from the real no-workspace welcome action and returns to that surface', async () => {
  useAppStore.setState({ config:{...composerConfig,workspaces:[]}, loading:false, activeWorkspaceId:null, mainSurface:'workbench',
    sessions:[],tabs:{},layouts:{},initialize:async()=>()=>{},detectExecutors:vi.fn(async()=>{}),checkHost:vi.fn(async()=>{}),toolsOpen:false })
  await dom.render(<App />)
  const welcome = dom.container.querySelector('.welcome')!
  expect(welcome).not.toBeNull()
  const button = welcome.querySelector<HTMLButtonElement>('button')!
  expect(button.textContent).toBe('Configure a host')
  await act(async()=>button.click())
  const settings=dom.container.querySelector<HTMLElement>('.settings-page')!
  expect(settings).not.toBeNull();expect(settings.hidden).toBe(false);expect(settings.inert).toBe(false)
  expect(settings.dataset.settingsPage).toBe('hosts')
  expect(settings.querySelector('[data-settings-pane="hosts"]')!.closest('[hidden],[inert]')).toBeNull()
  await dom.click('[aria-label="Close settings"]')
  expect(dom.container.querySelector('.settings-page')?.hasAttribute('hidden') ?? true).toBe(true)
  expect(dom.container.querySelector('.welcome')).toBe(welcome)
  expect(useAppStore.getState().sessions).toEqual([])
})
