// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { describeLaunchOptions, CLAUDE_LAUNCH_OPTIONS, resolveLaunchOptionArgv } from '@agentmux/core'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'
const dom=composerDOM(), original=useLauncherState.getState(), launch=vi.fn().mockResolvedValue(undefined)
const choices=[{id:'effort',label:'Effort',description:'Original declared effort.',choices:[{id:'default',label:'Explicit default',description:'Pass the declared default argument.'},{id:'high',label:'High',description:'Original high reasoning description.'},{id:'max',label:'Maximum',description:'Original maximum description.'}]}]
beforeEach(()=>{
 useLauncherState.setState({sections:{workspace:{agents:'expanded',terminal:'hidden',browser:'hidden',note:'hidden'}},drafts:{},executors:{}})
 const executor=composerConfig.executors.codex!
 useAppStore.setState({config:{...composerConfig,executors:{first:{...executor,providerId:'first'},second:{...executor,providerId:'second',label:'Second'}}},
  providerCatalog:[{id:'first',launchOptions:choices},{id:'second',launchOptions:choices}] as never,
  tabs:{launcher:createWorkbenchTab('launcher',{regionId:'region',kind:'launcher',workspaceId:'workspace',executorId:'first'})},activeWorkspaceId:'workspace',
  agentComposerDrafts:{region:'Keep original launch prompt'},launcherOptionDrafts:{region:{first:{effort:'legacy',retired:'retained'},second:{effort:'max'}}},launcherNameDrafts:{region:{agentName:'Original Agent',tabName:'Original Tab'}},
  recoveryCandidates:[],executorDetections:{},detectExecutors:vi.fn(),prewarmTerminal:vi.fn(),launchAgent:launch})
 launch.mockClear()
})
afterEach(async()=>{await act(async()=>useLauncherState.setState(original,true))})
const mount=async()=>dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible />)
async function click(selector:string){const n=document.querySelector<HTMLElement>(selector)!;expect(n).not.toBeNull();await act(async()=>n.click())}
async function menu(){const n=document.querySelector<HTMLElement>('.selection-field[aria-label="Effort"]')!;expect(n).not.toBeNull();await act(async()=>n.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse',ctrlKey:false})))}
async function choice(value:string){await menu();await click(`[role=menuitemradio][data-value="${value}"]`)}
it('original Launcher offers declared descriptions before selection and retains unknown values through Escape, hide and remount',async()=>{
 await mount();await click('[aria-label="Launch options"]');await menu()
 expect(document.querySelector('.selection-field__menu')!.textContent).toContain('Original high reasoning description.')
 expect(document.querySelector('.selection-field__menu [data-state=checked]')!.textContent).toContain('Saved selection')
 const item=document.querySelector<HTMLElement>('[role=menuitemradio][data-value=high]')!;await act(async()=>item.focus())
 expect(item.getAttribute('data-state')).toBe('unchecked');expect(useAppStore.getState().launcherOptionDrafts.region!.first!.effort).toBe('legacy')
 await act(async()=>item.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})))
 expect(document.querySelector('.launch-refine__panel')).not.toBeNull();expect(useAppStore.getState().launcherOptionDrafts.region!.first).toEqual({effort:'legacy',retired:'retained'})
 await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={false}/>);await dom.render(null);await mount();await click('[aria-label="Launch options"]')
 expect(document.querySelector<HTMLElement>('.selection-field[aria-label="Effort"]')!.dataset.value).toBe('legacy')
 expect(document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')!.value).toBe('Original Agent');expect(dom.draft('region')).toBe('Keep original launch prompt')
})
it('unset, explicit default and Provider-isolated drafts reach the original launch consumer with their exact values',async()=>{
 await mount();await click('[aria-label="Launch options"]');await choice('default')
 expect(useAppStore.getState().launcherOptionDrafts.region!.first).toEqual({effort:'default',retired:'retained'})
 await click('[aria-label="Close launch options"]');await dom.click('.launcher-launch-button')
 expect(launch).toHaveBeenLastCalledWith('first','Keep original launch prompt','group',{tabId:'launcher',regionId:'region'},{effort:'default',retired:'retained'},{agentName:'Original Agent',tabName:'Original Tab'})
 await dom.click('[data-executor-id=second]');await click('[aria-label="Launch options"]');expect(document.querySelector<HTMLElement>('[aria-label="Effort"].selection-field')!.dataset.value).toBe('max')
 await click('[aria-label="Close launch options"]');await dom.click('[data-executor-id=first]');await click('[aria-label="Launch options"]');await choice('')
 expect(useAppStore.getState().launcherOptionDrafts.region!.first).toEqual({retired:'retained'});expect(useAppStore.getState().launcherOptionDrafts.region!.second).toEqual({effort:'max'})
 expect(dom.draft('region')).toBe('Keep original launch prompt')
})
it('Core declared effort descriptions reach the actual Launcher without changing argument identity or guessing the unset default',async()=>{
 await act(async()=>useAppStore.setState({providerCatalog:[{id:'first',launchOptions:describeLaunchOptions(CLAUDE_LAUNCH_OPTIONS)}] as never,launcherOptionDrafts:{}}))
 await mount();await click('[aria-label="Launch options"]');await menu()
 const menuText=document.querySelector('.selection-field__menu')!.textContent!
 expect(menuText).toContain('Highest reasoning effort');expect(menuText).not.toContain('Recommended');expect(document.querySelector('.launch-refine__panel')!.textContent).toContain('can cap the level')
 expect(document.querySelector('[role=menuitemradio][data-state=checked]')!.getAttribute('data-value')).toBe('')
 await click('[role=menuitemradio][data-value=max]');expect(useAppStore.getState().launcherOptionDrafts.region!.first).toEqual({effort:'max'})
 expect(resolveLaunchOptionArgv('claude',CLAUDE_LAUNCH_OPTIONS,{effort:'max'})).toEqual(['--effort','max']);expect(resolveLaunchOptionArgv('claude',CLAUDE_LAUNCH_OPTIONS,{})).toEqual([])
})
