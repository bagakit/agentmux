import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { executeSettingsResourcesControl as execute } from '../src/main/settings-resources-control.js'
import { composerShortcutSchema, executorSchema } from '../src/main/config-store.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { applyConfigEdit } from '../src/shared/config-edit.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import type { AgentMuxControlSettingsResourceRequest, AgentMuxControlSettingsResourceFields } from '@agentmux/core'
const envelope={schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:'resource-test'}
const prompts=[{id:'one',keyword:'one',label:'One',body:'literal $TOKEN\nsecond line'},{id:'two',keyword:'two',label:'Two',body:'second'}]
const template={label:'Local',providerId:'codex',command:'cat',args:[],env:{},injectAgentMuxGuide:false}
type Input<T> = T extends unknown ? Omit<T, 'requestId' | 'schemaVersion'> : never
const request=(value:Input<AgentMuxControlSettingsResourceRequest>)=>({...envelope,...value}) as AgentMuxControlSettingsResourceRequest
const get=async(f:Awaited<ReturnType<typeof configOwnerFixture>>,resource:'prompts'|'executors',id:string)=>{
 const result=await execute(request({operation:'settings.resource.get',resource,id}),f.owner)
 if(result.operation!=='settings.resource.get')throw new Error('wrong result')
 return result.item.value
}
describe('typed Settings resources through the sole Main owner',()=>{
 it('derives nonempty DTO fields from actual persistence schemas, preserves fixed resource identities and literal values',async()=>{
  const f=await configOwnerFixture({executors:{first:template,second:template},composerShortcuts:prompts})
  expect(Object.keys(executorSchema.shape).length).toBeGreaterThan(0)
  expect(Object.keys(composerShortcutSchema.shape).length).toBeGreaterThan(0)
  await expect(execute(request({operation:'settings.resource.list',resource:'executors'}),f.owner)).resolves.toEqual({operation:'settings.resource.list',resource:'executors',partial:true,items:[{id:'first',value:template},{id:'second',value:template}]})
  await expect(execute(request({operation:'settings.resource.list',resource:'prompts'}),f.owner)).resolves.toEqual({operation:'settings.resource.list',resource:'prompts',partial:true,items:prompts.map(({id,...value})=>({id,value}))})
  expect(Object.keys(await get(f,'executors','first')).sort()).toEqual(Object.keys(executorSchema.shape).filter(k=>k!=='avatar').sort())
  expect(Object.keys(await get(f,'prompts','one')).sort()).toEqual(Object.keys(composerShortcutSchema.shape).filter(k=>k!=='id'&&k!=='providerId').sort())
  const args=['','--help','a b',"a'b",'$TOKEN','src/*.ts','>','C:\\folder\\file']
  const env=JSON.parse('{"__proto__":"own","constructor":"literal","A":"line1\\nB=line2","odd key":"= value"}')
  await execute(request({operation:'settings.resource.update',resource:'executors',id:'first',changes:{args,env,avatar:null}}),f.owner)
  const actual=await get(f,'executors','first')
  expect(actual.args).toEqual(args);expect(actual.env).toEqual(env);expect(Object.hasOwn(actual.env as object,'__proto__')).toBe(true)
  expect(actual.avatar).toEqual({});expect((await f.disk()).executors.first!.env).toEqual(env)
 })
 it('adds, reads, updates and removes both resources with no overwrite or upsert',async()=>{
  const f=await configOwnerFixture({executors:{first:template,second:template},composerShortcuts:prompts})
  for(const [resource,id,value]of[['executors','third',template],['prompts','--help',{keyword:'third',label:'',body:' $literal\nbody '}]]as const){
   await execute(request({operation:'settings.resource.add',resource,id,value}),f.owner)
   const actual=await get(f,resource,id),bytes=await f.bytes()
   await expect(execute(request({operation:'settings.resource.add',resource,id,value}),f.owner)).rejects.toMatchObject({code:'SETTING_RESOURCE_EXISTS'})
   expect(await f.bytes()).toBe(bytes)
   expect(typeof actual.label).toBe('string')
   await execute(request({operation:'settings.resource.update',resource,id,changes:{label:'Changed'},expected:{label:actual.label!}}),f.owner)
   const updated=await get(f,resource,id)
   await execute(request({operation:'settings.resource.remove',resource,id,expected:updated}),f.owner)
   await expect(get(f,resource,id)).rejects.toMatchObject({code:'SETTING_RESOURCE_NOT_FOUND'})
   await expect(execute(request({operation:'settings.resource.update',resource,id,changes:{label:'No upsert'}}),f.owner)).rejects.toMatchObject({code:'SETTING_RESOURCE_NOT_FOUND'})
  }
 })
 it('adds and removes the legal own identity constructor without mistaking inherited object values for a template',async()=>{
  const f=await configOwnerFixture({executors:{first:template,second:template},composerShortcuts:prompts})
  await execute(request({operation:'settings.resource.add',resource:'executors',id:'constructor',value:template}),f.owner)
  expect(Object.hasOwn(f.owner.current.executors,'constructor')).toBe(true)
  expect(await get(f,'executors','constructor')).toEqual(template)
  await expect(execute(request({operation:'settings.resource.remove',resource:'executors',id:'constructor',expected:template}),f.owner)).resolves.toEqual({operation:'settings.resource.remove',resource:'executors',id:'constructor',removed:true})
  expect(Object.hasOwn(f.owner.current.executors,'constructor')).toBe(false)
  await expect(get(f,'executors','constructor')).rejects.toMatchObject({code:'SETTING_RESOURCE_NOT_FOUND'})
 })
 it('compares absent optional fields in a complete get DTO, supports explicit absent expectations, and redacts invalid values',async()=>{
  const f=await configOwnerFixture({executors:{first:template,second:template},composerShortcuts:prompts})
  const original=await get(f,'executors','first')
  expect(Object.hasOwn(original,'avatar')).toBe(false)
  await execute(request({operation:'settings.resource.update',resource:'executors',id:'first',changes:{avatar:null},expected:original}),f.owner)
  expect((await get(f,'executors','first')).avatar).toEqual({})
  await execute(request({operation:'settings.resource.update',resource:'executors',id:'second',changes:{avatar:{tint:'#abcdef'}},expected:{avatar:null}}),f.owner)
  const bytes=await f.bytes()
  await expect(execute(request({operation:'settings.resource.update',resource:'executors',id:'first',changes:{avatar:{badge:'PRIVATE_VALUE'}}}),f.owner)).rejects.toMatchObject({code:'INVALID_SETTING_VALUE',message:expect.not.stringContaining('PRIVATE_VALUE')})
  expect(await f.bytes()).toBe(bytes)
 })
 it('preserves Prompt body, normalizes keyword/name, changes and unbinds Provider, and persists an explicit empty library',async()=>{
  const f=await configOwnerFixture({composerShortcuts:prompts})
  await execute(request({operation:'settings.resource.update',resource:'prompts',id:'one',changes:{keyword:' new ',label:' ',providerId:'claude',body:' $TOKEN\n  literal '}}),f.owner)
  expect(await get(f,'prompts','one')).toEqual({keyword:'new',label:'new',providerId:'claude',body:' $TOKEN\n  literal '})
  await execute(request({operation:'settings.resource.update',resource:'prompts',id:'one',changes:{providerId:null},expected:{providerId:'claude'}}),f.owner)
  expect(Object.hasOwn(await get(f,'prompts','one'),'providerId')).toBe(false)
  await execute(request({operation:'settings.resource.update',resource:'prompts',id:'one',changes:{providerId:'codex'},expected:{providerId:null}}),f.owner)
  for(const id of ['one','two'])await execute(request({operation:'settings.resource.remove',resource:'prompts',id}),f.owner)
  expect((await f.disk()).composerShortcuts).toEqual([])
  const result=await execute(request({operation:'settings.resource.list',resource:'prompts'}),f.owner)
  expect(result).toEqual({operation:'settings.resource.list',resource:'prompts',partial:true,items:[]})
 })
 it('rejects unknown fields, identity changes, invalid fields and duplicate keywords before any bytes or publish change',async()=>{
  const f=await configOwnerFixture({executors:{first:template,second:template},composerShortcuts:prompts})
  const bytes=await f.bytes()
  const invalidChanges:AgentMuxControlSettingsResourceFields[]=[{other:true},{id:'new'},{body:'   '},{keyword:'two'},{providerId:''}]
  for(const changes of invalidChanges){
   await expect(execute(request({operation:'settings.resource.update',resource:'prompts',id:'one',changes}),f.owner)).rejects.toBeInstanceOf(Error)
   expect(await f.bytes()).toBe(bytes)
  }
  await expect(execute(request({operation:'settings.resource.update',resource:'executors',id:'first',changes:{providerId:'claude'}}),f.owner)).rejects.toMatchObject({code:'SETTING_IDENTITY_IMMUTABLE'})
  await expect(execute(request({operation:'settings.resource.update',resource:'executors',id:'first',changes:{env:{A:1}}}),f.owner)).rejects.toMatchObject({code:'INVALID_SETTING_VALUE'})
  await expect(execute(request({operation:'settings.resource.add',resource:'executors',id:'unknown-provider',value:{...template,providerId:'unknown-provider',env:{PRIVATE:'SECRET_VALUE'}}}),f.owner)).rejects.toMatchObject({code:'INVALID_SETTING_VALUE',message:expect.not.stringContaining('SECRET_VALUE')})
  expect(await f.bytes()).toBe(bytes);expect(f.runtime.prepare).not.toHaveBeenCalled();expect(f.publish).not.toHaveBeenCalled()
 })
 it('compares only changed fields against supplied expectations, keeps disjoint commits, and proves real nochange',async()=>{
  const f=await configOwnerFixture({executors:{first:template,second:template},composerShortcuts:prompts})
  await execute(request({operation:'settings.resource.update',resource:'prompts',id:'one',changes:{body:'external'}}),f.owner)
  await execute(request({operation:'settings.resource.update',resource:'prompts',id:'one',changes:{label:'Local'},expected:{label:'One'}}),f.owner)
  expect(await get(f,'prompts','one')).toEqual({keyword:'one',label:'Local',body:'external'})
  const bytes=await f.bytes(),count=f.publish.mock.calls.length
  await execute(request({operation:'settings.resource.update',resource:'prompts',id:'one',changes:{label:'Local'},expected:{label:'stale'}}),f.owner)
  expect(await f.bytes()).toBe(bytes);expect(f.publish).toHaveBeenCalledTimes(count)
  await expect(execute(request({operation:'settings.resource.update',resource:'prompts',id:'one',changes:{body:'local'},expected:{body:'literal $TOKEN\nsecond line'}}),f.owner)).rejects.toMatchObject({code:'CONFIG_CONFLICT'})
  await expect(execute(request({operation:'settings.resource.update',resource:'prompts',id:'one',changes:{body:'local'},expected:{}}),f.owner)).rejects.toMatchObject({code:'INVALID_SETTING_VALUE'})
  await expect(execute(request({operation:'settings.resource.remove',resource:'prompts',id:'one',expected:{keyword:'one',label:'One',body:'external'}}),f.owner)).rejects.toMatchObject({code:'CONFIG_CONFLICT'})
  expect(await f.bytes()).toBe(bytes)
 })
 it('treats env and argv as whole authored values and preserves supported own-key UI edits through validation and persistence',async()=>{
  const f=await configOwnerFixture({executors:{first:{...template,env:{A:'original'}},second:template}})
  const before=structuredClone(f.owner.current)
  await execute(request({operation:'settings.resource.update',resource:'executors',id:'first',changes:{env:{B:'external'}}}),f.owner)
  await expect(f.owner.edit(before,{...before,executors:{...before.executors,first:{...before.executors.first!,env:{C:'local'}}}})).rejects.toMatchObject({code:'CONFIG_CONFLICT',field:'executors.first.env'})
  const baseline=structuredClone(f.owner.current),env=JSON.parse('{"__proto__":"kept","constructor":"own"}')
  await f.owner.edit(baseline,{...baseline,executors:{...baseline.executors,first:{...baseline.executors.first!,env}}})
  expect(f.owner.current.executors.first!.env).toEqual(env)
  expect(Object.hasOwn(f.owner.current.executors.first!.env,'__proto__')).toBe(true)
  expect((await f.disk()).executors.first!.env).toEqual(env)
  await execute(request({operation:'settings.resource.update',resource:'executors',id:'first',changes:{env:{},args:[]}}),f.owner)
  expect(f.owner.current.executors.first!.env).toEqual({});expect(f.owner.current.executors.first!.args).toEqual([])
  const inherited=Object.fromEntries([['constructor',template]])
  const config={...baseline,executors:inherited}
  expect(applyConfigEdit(config,config,{...config,executors:{...inherited,constructor:{...template,label:'Safe'}}}).executors['constructor']!.label).toBe('Safe')
 })
})
