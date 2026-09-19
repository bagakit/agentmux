// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.hoisted(()=>vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__',true))
vi.mock('electron',()=>({app:{getPath:()=>tmpdir()}}))
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { BUILT_IN_AGENT_PROVIDER_IDS } from '@agentmux/core/provider-id'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'
import { executeSettingsResourcesControl as execute } from '../src/main/settings-resources-control'
import { composerDOM } from './helpers/composer-dom-fixture'
import type { AppConfig } from '../src/shared/contracts'
const dom=composerDOM()
const prompts=[{id:'one',keyword:'one',label:'One',body:'first'},{id:'two',keyword:'two',label:'Two',body:'second'}]
const template={label:'First',providerId:'codex',command:'cat',args:[],env:{A:'line1\nB=line2'},injectAgentMuxGuide:false}
let f:Awaited<ReturnType<typeof configOwnerFixture>>
beforeEach(async()=>{
 f=await configOwnerFixture({executors:{first:template,second:{...template,label:'Second'}},composerShortcuts:prompts})
 const publish=f.publish.getMockImplementation()!
 f.publish.mockImplementation(saved=>{publish(saved);useAppStore.setState({config:saved})})
 useAppStore.setState({config:f.owner.current,detectExecutors:vi.fn(async()=>{}),providerCatalog:await api.providers.list()})
 vi.spyOn(api.config,'save').mockImplementation(async(next,expected)=>await f.owner.edit(expected!,next))
})
const pane=async(section:'prompts'|'agents')=>dom.render(<SettingsPanel onClose={()=>{}} initialSection={section}/> )
const row=(id:string)=>[...dom.container.querySelectorAll<HTMLDetailsElement>('.prompt-settings-card')].find(node=>node.querySelector('input')?.value===id)!
const field=(label:string,index=0)=>[...dom.container.querySelectorAll<HTMLLabelElement>('[data-settings-pane="prompts"] label')].filter(n=>n.querySelector('span')?.textContent===label)[index]!.querySelector<HTMLInputElement|HTMLTextAreaElement>('input,textarea')!
async function fill(node:HTMLInputElement|HTMLTextAreaElement,value:string){
 expect(node).not.toBeNull()
 await act(async()=>{const prototype=node instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}))})
}
async function settled(){
 for(let tries=0;tries<100;tries++){
  await act(async()=>{await new Promise(done=>setTimeout(done,5))})
  if(!dom.container.querySelector('.settings-pane-actions [role="status"]')?.textContent?.includes('Saving'))return
 }
 throw new Error('durable resource save did not settle')
}
async function save(){await dom.click('.settings-pane-actions button');await settled()}
async function external(id:string,changes:Record<string,string>){await act(async()=>{await execute({requestId:'external',schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,operation:'settings.resource.update',resource:'prompts',id,changes},f.owner)})}
const executorName=()=>dom.container.querySelector<HTMLInputElement>('#executor-settings-first [data-executor-name]')!
const envInput=()=>dom.container.querySelectorAll<HTMLTextAreaElement>('#executor-settings-first .settings-launch-config textarea')[1]!
describe('resource editors keep authored baselines through real SettingsPanel saves',()=>{
 it('displays an accepted additional Provider filter, preserves it through Save and explicitly unbinds it',async()=>{
  const providerId='additional-provider'
  expect([...BUILT_IN_AGENT_PROVIDER_IDS]).not.toContain(providerId)
  await external('one',{providerId});await pane('prompts')
  const cards=dom.container.querySelectorAll('.prompt-settings-card')
  expect(cards).toHaveLength(2)
  const select=cards[0]!.querySelector('select')!
  expect(select).not.toBeNull();expect(select.value).toBe(providerId)
  expect([...select.options].filter(option=>option.value===providerId).map(option=>option.textContent)).toEqual([providerId])
  expect(cards[0]!.querySelector('summary')!.textContent).toContain(`${providerId} only`)
  await fill(field('Name'),'Local');await save()
  expect(f.owner.current.composerShortcuts![0]!.providerId).toBe(providerId)
  expect((await f.disk()).composerShortcuts![0]!.providerId).toBe(providerId)
  await act(async()=>{select.value='';select.dispatchEvent(new Event('change',{bubbles:true}))})
  expect(select.value).toBe('');await save()
  expect(Object.hasOwn(f.owner.current.composerShortcuts![0]!,'providerId')).toBe(false)
  expect(Object.hasOwn((await f.disk()).composerShortcuts![0]!,'providerId')).toBe(false)
 })
 it('refreshes clean Prompt fields while retaining a dirty field and saves against its original expectation',async()=>{
  await pane('prompts');await fill(field('Name'),'Local')
  await external('one',{body:'external body'})
  expect(field('Name').value).toBe('Local');expect(field('Prompt').value).toBe('external body')
  await save()
  expect(f.owner.current.composerShortcuts![0]).toEqual({...prompts[0],label:'Local',body:'external body'})
  const [,expected]=vi.mocked(api.config.save).mock.calls[0]!
  expect(expected!.composerShortcuts![0]).toEqual({...prompts[0],body:'external body'})
 })
 it('keeps a same-field conflict, its raw draft and original expectation for explicit retry',async()=>{
  await pane('prompts');await fill(field('Name'),'Local');await external('one',{label:'External'})
  const bytes=await f.bytes();await save()
  const alert=dom.container.querySelector('[role="alert"]')
  expect(alert).not.toBeNull()
  expect(alert!.textContent).toContain('composerShortcuts.one.label')
  expect(field('Name').value).toBe('Local');expect(await f.bytes()).toBe(bytes)
  await save()
  expect(vi.mocked(api.config.save).mock.calls.map(([,expected])=>expected!.composerShortcuts![0]!.label)).toEqual(['One','One'])
 })
 it('keeps edits back to the old baseline while a save is pending, even when Main publishes before its reply',async()=>{
  await pane('prompts');await fill(field('Name'),'Local')
  const pending=deferred<void>(),realSave=vi.mocked(api.config.save).getMockImplementation()!
  vi.mocked(api.config.save).mockImplementationOnce(async(next,expected)=>{const result=await realSave(next,expected);await pending.promise;return result})
  await dom.click('.settings-pane-actions button');await fill(field('Name'),'One')
  await act(async()=>pending.resolve())
  await settled()
  expect(field('Name').value).toBe('One');expect(dom.container.querySelector<HTMLButtonElement>('.settings-pane-actions button')!.disabled).toBe(false)
  await save();expect(f.owner.current.composerShortcuts![0]!.label).toBe('One')
  expect(vi.mocked(api.config.save).mock.calls[1]![1]!.composerShortcuts![0]!.label).toBe('Local')
 })
 it('undoes a dirty field to its baseline by accepting the newer clean Main value',async()=>{
  await pane('prompts');await fill(field('Name'),'Local');await external('one',{label:'External'});await fill(field('Name'),'One')
  expect(field('Name').value).toBe('External');expect(dom.container.querySelector<HTMLButtonElement>('.settings-pane-actions button')!.disabled).toBe(true)
 })
 it('does not resurrect an externally deleted dirty Prompt and preserves failed removal drafts',async()=>{
  await pane('prompts');await fill(field('Name'),'Local')
  await act(async()=>{await execute({requestId:'delete',schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,operation:'settings.resource.remove',resource:'prompts',id:'one'},f.owner)})
  expect(field('Name').value).toBe('Local');await save()
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('composerShortcuts.one')
  expect(f.owner.current.composerShortcuts).toEqual([prompts[1]])
 })
 it('retains the original Executor env baseline during a disjoint external env update and an unchanged-env Name Save',async()=>{
  await pane('agents');await fill(executorName(),'Local')
  await act(async()=>{await execute({requestId:'env',schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,operation:'settings.resource.update',resource:'executors',id:'first',changes:{env:{NEW:'external'}}},f.owner)})
  expect(executorName().value).toBe('Local');expect(JSON.parse(envInput().value)).toEqual({NEW:'external'})
  await save();expect(f.owner.current.executors.first!.env).toEqual({NEW:'external'})
  expect(vi.mocked(api.config.save).mock.calls[0]![1]!.executors.first!.label).toBe('First')
 })
 it('preserves own keys and multiline literal values through the real JSON editor and durable Main save',async()=>{
  await pane('agents')
  const env=JSON.parse('{"A":"line1\\nB=line2","__proto__":"own","constructor":"literal","odd key":"= value"}')
  await fill(envInput(),JSON.stringify(env,null,2));await save()
  expect(f.owner.current.executors.first!.env).toEqual(env);expect((await f.disk()).executors.first!.env).toEqual(env)
  expect(Object.hasOwn(f.owner.current.executors.first!.env,'__proto__')).toBe(true)
 })
 it('rejects invalid JSON without bytes changing and keeps the editable invalid draft',async()=>{
  await pane('agents');const bytes=await f.bytes();await fill(envInput(),'{unfinished');await save()
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('JSON object')
  expect(envInput().value).toBe('{unfinished');expect(await f.bytes()).toBe(bytes);expect(api.config.save).not.toHaveBeenCalled()
 })
 it('keeps a dirty Executor field and baseline on conflict',async()=>{
  await pane('agents');await fill(executorName(),'Local')
  await act(async()=>{await execute({requestId:'executor',schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,operation:'settings.resource.update',resource:'executors',id:'first',changes:{label:'External'}},f.owner)})
  await save();expect(executorName().value).toBe('Local');expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('executors.first.label')
  expect(vi.mocked(api.config.save).mock.calls[0]![1]!.executors.first!.label).toBe('First')
 })
 it('keeps an authored Executor identity read-only after external deletion and preserves its failed edit',async()=>{
  await pane('agents');await fill(executorName(),'Local name')
  await act(async()=>{await execute({requestId:'remove',schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,operation:'settings.resource.remove',resource:'executors',id:'first'},f.owner)})
  const editor=dom.container.querySelector('#executor-settings-first')!
  expect(editor).not.toBeNull();expect(executorName().value).toBe('Local name')
  const identity=editor.querySelector('.settings-executor-identity')
  expect(identity).not.toBeNull();expect(identity!.textContent).toContain('Codex')
  expect([...editor.querySelectorAll('label')].filter(node=>node.querySelector('span')?.textContent==='Provider')).toHaveLength(0)
  const bytes=await f.bytes();await save()
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('executors.first')
  expect(await f.bytes()).toBe(bytes);expect(Object.hasOwn(f.owner.current.executors,'first')).toBe(false)
  expect(executorName().value).toBe('Local name')
 })
 it('keeps an Executor edit back to its old baseline during a pending commit and saves against the committed value',async()=>{
  await pane('agents');await fill(executorName(),'Local')
  const pending=deferred<void>(),realSave=vi.mocked(api.config.save).getMockImplementation()!
  vi.mocked(api.config.save).mockImplementationOnce(async(next,expected)=>{const result=await realSave(next,expected);await pending.promise;return result})
  await dom.click('.settings-pane-actions button');await fill(executorName(),'First')
  await act(async()=>pending.resolve());await settled()
  expect(executorName().value).toBe('First');expect(dom.container.querySelector<HTMLButtonElement>('.settings-pane-actions button')!.disabled).toBe(false)
  await save();expect(f.owner.current.executors.first!.label).toBe('First')
  expect(vi.mocked(api.config.save).mock.calls[1]![1]!.executors.first!.label).toBe('Local')
 })
 it('keeps local Prompt deletions after a failed durable Save, then retries the same original baseline',async()=>{
  await pane('prompts')
  const buttons=[...dom.container.querySelectorAll<HTMLButtonElement>('.prompt-settings-card button')].filter(node=>node.textContent?.includes('Delete prompt'))
  expect(buttons).toHaveLength(2)
  await act(async()=>buttons[0]!.click())
  vi.mocked(api.config.save).mockRejectedValueOnce(new Error('disk unavailable'))
  await save();expect(dom.container.querySelectorAll('.prompt-settings-card')).toHaveLength(1)
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toBe('disk unavailable')
  await save();expect(f.owner.current.composerShortcuts).toEqual([prompts[1]])
  expect(vi.mocked(api.config.save).mock.calls.map(([,expected])=>expected!.composerShortcuts)).toEqual([prompts,prompts])
 })
 it('resets an effective legacy avatar against the actual persisted Executor baseline and keeps the legacy record',async()=>{
  const legacy={tint:'#abcdef',badge:'spark' as const}
  await f.owner.update(current=>({...current,appearance:{...current.appearance,agentAvatars:{first:legacy}}}))
  await pane('agents')
  expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="Reset First avatar"]')!.disabled).toBe(false)
  await dom.click('[aria-label="Reset First avatar"]');await save()
  expect(dom.container.querySelector('[role="alert"]')).toBeNull()
  expect(f.owner.current.executors.first!.avatar).toEqual({})
  expect(f.owner.current.appearance.agentAvatars!.first).toEqual(legacy)
 })
})
