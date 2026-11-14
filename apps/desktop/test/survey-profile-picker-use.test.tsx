// @vitest-environment happy-dom
import {act}from'react'
import {createRoot,type Root}from'react-dom/client'
import {afterEach,beforeEach,expect,it,vi}from'vitest'
import {SurveyProfilePicker}from'../src/renderer/src/components/SurveyProfilePicker'
import {SettingsNavigation}from'../src/renderer/src/components/SettingsNavigation'
import {api}from'../src/renderer/src/lib/api'
import {browserProfiles}from'../src/renderer/src/lib/browser-profiles'
import type {BrowserProfilesState}from'../src/renderer/src/lib/browser-profiles'
import type {AgentMuxBrowserTarget}from'@agentmux/core'
const profiles:BrowserProfilesState={revision:1,sequence:1,folders:[],views:[],reading:false,error:null,profiles:[
  {id:'personal',revision:'r1',label:'Default',createdAt:1,isDefault:true,source:null},
  {id:'work',revision:'r2',label:'工作环境',createdAt:2,isDefault:false,source:null,notes:'客户与项目',environment:{acceptLanguages:['zh-CN'],timeZone:'Asia/Shanghai',screen:{width:1440,height:900}}}
]}
let root:Root,element:HTMLDivElement
const settle=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,40))})
const target=(id:string,state:'live'|'released'|'cold'|'unknown',profileId='work'):AgentMuxBrowserTarget=>({id,workspaceId:'workspace',source:'embedded',mode:'normal',status:'ready',url:'https://example.test/',title:id,capabilities:[],profile:{id:profileId,label:profileId},resource:{state,locations:[{workspaceId:'workspace',tabId:'tab',regionId:'region'},{workspaceId:'other',tabId:'tab',regionId:'region'}],processes:[]}})
const trigger=()=>element.querySelector<HTMLButtonElement>('[aria-label="Survey environment"]')!
const option=(value:string)=>document.querySelector<HTMLElement>(`[role="menuitemradio"][data-value="${value}"]`)!
async function open(){await act(async()=>{trigger().focus();trigger().dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))});await settle()}
async function escape(){await act(async()=>document.activeElement?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));await settle()}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);browserProfiles.reset();element=document.createElement('div');document.body.append(element);root=createRoot(element)})
afterEach(async()=>{await act(async()=>root.unmount());element.remove();vi.restoreAllMocks();browserProfiles.reset();vi.unstubAllGlobals()})
it('[profile-picker] uses one visible Main directory for all choices and renders saved environment fields',async()=>{
  const read=vi.spyOn(api.browser,'listTargets').mockResolvedValue({coverage:'complete',targets:[target('open','live'),target('released','released'),target('cold','cold')]})
  const release=vi.fn(),subscribe=vi.spyOn(api.browser,'onTargetsChanged').mockImplementation(()=>release),changed=vi.fn()
  await act(async()=>root.render(<SurveyProfilePicker value={{kind:'default'}} profiles={profiles} collapsed={false} onExpand={()=>{}} onChange={changed} onRefresh={()=>{}}/>))
  expect(read).not.toHaveBeenCalled();expect(trigger().querySelector('.selection-field__choice > span:last-child')?.textContent).toBe('Default')
  await open();expect(read).toHaveBeenCalledTimes(1);expect(subscribe).toHaveBeenCalledTimes(1)
  expect(option('profile:work').textContent).toContain('1 open · 2 saved')
  expect(option('profile:work').textContent).toContain('Configured: Languages zh-CN · Time zone Asia/Shanghai · Screen 1440×900')
  expect(option('default').textContent).toContain('No open or saved Browsers')
  expect(document.querySelectorAll('[role="menuitemradio"][data-value="default"]')).toHaveLength(1)
  await escape();expect(release).toHaveBeenCalledTimes(1);expect(read).toHaveBeenCalledTimes(1);expect(changed).not.toHaveBeenCalled()
})
it('[profile-picker] partial, stale and unattributed pages never turn into precise zero or default use',async()=>{
  let changedTargets=()=>{}
  let current:{coverage:'complete'|'partial';targets:AgentMuxBrowserTarget[]}={coverage:'complete',targets:[target('before','live')]}
  vi.spyOn(api.browser,'onTargetsChanged').mockImplementation(callback=>{changedTargets=callback;return()=>{}})
  vi.spyOn(api.browser,'listTargets').mockImplementation(async()=>current)
  await act(async()=>root.render(<SurveyProfilePicker value={{kind:'default'}} profiles={profiles} collapsed={false} onExpand={()=>{}} onChange={()=>{}} onRefresh={()=>{}}/>));await open()
  const unknown=target('unattributed','cold');delete unknown.profile
  current={coverage:'partial',targets:[target('now','live'),unknown]};await act(async()=>changedTargets());await settle()
  expect(option('profile:work').textContent).toContain('1 observed open · 1 unconfirmed')
  expect(option('default').textContent).toContain('Browser use unconfirmed')
  expect(option('default').textContent).not.toContain('open or saved')
})
it('[profile-picker] directory failure retains original choices and retries only the original observation',async()=>{
  const read=vi.spyOn(api.browser,'listTargets').mockRejectedValue(new Error('Native directory unavailable'))
  const changed=vi.fn();await act(async()=>root.render(<SurveyProfilePicker value={{kind:'default'}} profiles={profiles} collapsed={false} onExpand={()=>{}} onChange={changed} onRefresh={()=>{}}/>));await open()
  expect(option('profile:work').getAttribute('aria-disabled')).not.toBe('true')
  expect(option('profile:work').textContent).toContain('Browser use unconfirmed')
  expect(document.querySelector('.survey-profile-picker__observation')?.textContent).toContain('Native directory unavailable')
  read.mockResolvedValue({coverage:'complete',targets:[target('recovered','live')]})
  await act(async()=>[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==='Refresh browser use')!.click());await settle()
  expect(read).toHaveBeenCalledTimes(2);expect(option('profile:work').textContent).toContain('1 open');expect(changed).not.toHaveBeenCalled()
  await act(async()=>option('profile:work').click());await settle()
  expect(changed).toHaveBeenCalledExactlyOnceWith({kind:'profile',profileId:'work'})
})
it('[profile-picker] management is an action, search is local, and hiding ends observation without reopening',async()=>{
  const read=vi.spyOn(api.browser,'listTargets').mockResolvedValue({coverage:'complete',targets:[]}),release=vi.fn()
  vi.spyOn(api.browser,'onTargetsChanged').mockImplementation(()=>release)
  const changed=vi.fn(),manage=vi.fn()
  const render=(active:boolean)=>root.render(<SettingsNavigation.Provider value={{open:manage,openToolkit:()=>{},openHost:()=>{},openChannel:()=>{},channelEntries:[],channelPresentation:()=>null,openMoteLark:()=>{},chooseAgent:()=>{}}}><SurveyProfilePicker value={{kind:'default'}} profiles={profiles} collapsed={false} active={active} onExpand={()=>{}} onChange={changed} onRefresh={()=>{}}/></SettingsNavigation.Provider>)
  await act(async()=>render(true));await open()
  const search=document.querySelector<HTMLInputElement>('[aria-label="Find survey environment"]')!
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'Shanghai');search.dispatchEvent(new Event('input',{bubbles:true}))})
  expect(document.querySelectorAll('[role="menuitemradio"][data-value]')).toHaveLength(1)
  expect(option('profile:work')).not.toBeNull();expect(read).toHaveBeenCalledTimes(1)
  const action=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==='Manage environments…')!
  await act(async()=>action.click());await settle();expect(manage).toHaveBeenCalledExactlyOnceWith('browser-profiles');expect(changed).not.toHaveBeenCalled()
  await open();await act(async()=>render(false));await settle();expect(document.querySelector('[role="menu"]')).toBeNull()
  const last=read.mock.calls.length;await act(async()=>render(true));await settle();expect(read).toHaveBeenCalledTimes(last);expect(document.querySelector('[role="menu"]')).toBeNull();expect(release).toHaveBeenCalledTimes(2)
})
