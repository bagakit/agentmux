// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.hoisted(()=>vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__',true))
vi.mock('electron',()=>({app:{getPath:()=>tmpdir()}}))
import { WorkspaceSettingsPane } from '../src/renderer/src/components/settings/WorkspaceSettingsPane'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { registerWorkspace } from '../src/main/settings-workspace-add-control'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
const dom=composerDOM()
let f:Awaited<ReturnType<typeof configOwnerFixture>>
const close=vi.fn()
function View(){const config=useAppStore(state=>state.config)!;return <WorkspaceSettingsPane config={config} onClose={close}/>}
beforeEach(async()=>{
 f=await configOwnerFixture({executors:{},workspaces:[{id:'original',name:'Original',hostId:'local',path:'/owned-original',kind:'folder'}]})
 const publish=f.publish.getMockImplementation()!
 f.publish.mockImplementation(saved=>{publish(saved);useAppStore.getState().setConfig(saved)})
 useAppStore.setState({config:f.owner.current,activeWorkspaceId:'original',layouts:{original:createWorkspaceLayout('original-group')},
  hostChecks:{local:{state:'ready',result:{ok:true,detail:'Owned connected host'}}},checkHost:vi.fn(async()=>{}),detectExecutors:vi.fn(async()=>{})})
 vi.spyOn(api.workspaces,'add').mockImplementation(async input=>(await registerWorkspace(input,f.owner,()=>({}))).workspace)
 close.mockClear()
})
const input=(placeholder:string)=>dom.container.querySelector<HTMLInputElement>(`[placeholder="${placeholder}"]`)!
async function fill(placeholder:string,value:string){const node=input(placeholder);expect(node).not.toBeNull();await act(async()=>{
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}))})}
async function show(){await dom.render(<View/>);await dom.click('.settings-pane-toolbar button')}
async function settle(){for(let tries=0;tries<100;tries++){await act(async()=>{await new Promise(done=>setTimeout(done,5))});if(!dom.container.querySelector('.workspace-composer .spin'))return}throw new Error('Workspace registration did not settle')}

describe('actual Settings project form consumes the committed owner without stale pulls',()=>{
 it('rejects Main-owned registration at the Renderer Control bridge without changing configuration or the workbench',async()=>{
  const config=structuredClone(useAppStore.getState().config),layouts=structuredClone(useAppStore.getState().layouts)
  await expect(useAppStore.getState().executeControl({schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,
   requestId:'wrong-renderer-route',operation:'settings.workspaces.add',input:{hostId:'local',path:'/owned-new'}})).rejects.toMatchObject({code:'CONTROL_FAILED'})
  expect(api.workspaces.add).not.toHaveBeenCalled();expect(useAppStore.getState().config).toEqual(config)
  expect(useAppStore.getState().layouts).toEqual(layouts);expect(useAppStore.getState().activeWorkspaceId).toBe('original')
 })
 it('keeps existing form trim/name semantics, registers through the owner and selects only its returned identity',async()=>{
  await show();await fill('/path/to/project','  /owned-new  ');await fill('Project name','  Authored project  ')
  const original=structuredClone(useAppStore.getState().layouts.original),drafts=structuredClone(useAppStore.getState().agentComposerDrafts)
  const get=vi.spyOn(api.config,'get')
  await dom.click('.workspace-composer .primary-button');await settle()
  expect(api.workspaces.add).toHaveBeenCalledExactlyOnceWith({hostId:'local',path:'/owned-new',name:'Authored project'})
  const committed=f.owner.current.workspaces.find(item=>item.path==='/owned-new');expect(committed).toBeDefined()
  expect(useAppStore.getState().activeWorkspaceId).toBe(committed!.id);expect(useAppStore.getState().layouts.original).toEqual(original)
  expect(useAppStore.getState().agentComposerDrafts).toEqual(drafts);expect(close).toHaveBeenCalledOnce();expect(get).not.toHaveBeenCalled()
 })
 it('preserves a later disjoint publication while an earlier registration reply is pending rather than replaying a stale get result',async()=>{
  await show();await fill('/path/to/project','/owned-new')
  const old=structuredClone(f.owner.current),pending=deferred<void>(),entered=deferred<void>(),add=vi.mocked(api.workspaces.add).getMockImplementation()!
  const get=vi.spyOn(api.config,'get').mockResolvedValue(old)
  vi.mocked(api.workspaces.add).mockImplementationOnce(async input=>{const result=await add(input);entered.resolve();await pending.promise;return result})
  await act(async()=>{await dom.click('.workspace-composer .primary-button');await entered.promise})
  await act(async()=>{await f.owner.update(current=>({...current,copyPathsAsAbsolute:true}))})
  await act(async()=>pending.resolve());await settle()
  expect(useAppStore.getState().config!.copyPathsAsAbsolute).toBe(true)
  expect(useAppStore.getState().config!.workspaces).toEqual(f.owner.current.workspaces)
  expect(get).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce()
 })
 it('shows registration failure while keeping the original fields/workspace/config for an explicit retry',async()=>{
  await show();await fill('/path/to/project','/owned-new');await fill('Project name','My project')
  const bytes=await f.bytes(),before=structuredClone(useAppStore.getState().layouts)
  f.save.mockRejectedValueOnce(new Error('Owned durable failure'))
  await dom.click('.workspace-composer .primary-button');await settle()
  expect(dom.container.querySelector('.dialog-error')?.textContent).toContain('Owned durable failure')
  expect(input('/path/to/project').value).toBe('/owned-new');expect(input('Project name').value).toBe('My project')
  expect(await f.bytes()).toBe(bytes);expect(useAppStore.getState().activeWorkspaceId).toBe('original');expect(useAppStore.getState().layouts).toEqual(before)
  expect(close).not.toHaveBeenCalled();expect(f.publish).not.toHaveBeenCalled()
  await dom.click('.workspace-composer .primary-button');await settle();expect(close).toHaveBeenCalledOnce()
 })
})
