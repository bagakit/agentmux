// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
vi.mock('electron', async () => { const { tmpdir } = await import('node:os'); return { app: { getPath: () => tmpdir() } } })
import { ConfigStore } from '../src/main/config-store'
import { executeSettingsControl } from '../src/main/settings-control'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { focusZoneContainerKey } from '../src/shared/focus-zone-presentation'
const key='focus.zonePresentations', project=focusZoneContainerKey('project','local','root'), collection=focusZoneContainerKey('collection','remote','root')
const inspect=(owner:Awaited<ReturnType<typeof configOwnerFixture>>['owner'])=>executeSettingsControl({schemaVersion:5,requestId:'inspect-zone-choice',operation:'settings.get',target:key},owner)
const set=(owner:Awaited<ReturnType<typeof configOwnerFixture>>['owner'],value:unknown)=>executeSettingsControl({schemaVersion:5,requestId:'set-zone-choice',operation:'settings.set',key,value:JSON.stringify(value)},owner)
it('the original public settings owner discovers, validates and durably reloads exact container choices without rewriting project routes',async()=>{
 const f=await configOwnerFixture(), before=f.owner.current, bytes=await f.bytes()
 expect(await inspect(f.owner)).toMatchObject({entries:[{key,value:'[]',default:'[]',kind:'string'}]})
 await set(f.owner,[]);expect(await f.bytes()).toBe(bytes)
 const choices=[{key:project,presentation:'cards'},{key:collection,presentation:'sections'}]
 await set(f.owner,choices)
 expect(f.owner.current.focus?.zonePresentations).toEqual(choices)
 expect((await new ConfigStore(f.store.filePath).get()).focus?.zonePresentations).toEqual(choices)
 for(const field of ['workspaces','hosts','executors'] as const)expect(f.owner.current[field]).toEqual(before[field])
 const saved=await f.bytes()
 await expect(set(f.owner,[{key:'["local","root"]',presentation:'cards'}])).rejects.toThrow()
 await expect(set(f.owner,[{key:project,presentation:'tags'}])).rejects.toThrow()
 expect(await f.bytes()).toBe(saved)
})
it('ConfigOwner merges different container deltas and rejects a conflicting same-container reset without replacing other fields',async()=>{
 const f=await configOwnerFixture(), base=f.owner.current
 const update=(container:string,presentation:'cards'|'sections')=>({...base,focus:{recentActivityHours:48 as const,zonePresentations:[{key:container,presentation}]}})
 await f.owner.edit(base,update(project,'cards'))
 await f.owner.edit(base,update(collection,'sections'))
 expect(f.owner.current.focus?.zonePresentations).toEqual([{key:project,presentation:'cards'},{key:collection,presentation:'sections'}])
 const authored=f.owner.current
 await set(f.owner,[{key:project,presentation:'sections'},{key:collection,presentation:'sections'}])
 await expect(f.owner.edit(authored,{...authored,focus:{...authored.focus!,zonePresentations:[{key:collection,presentation:'sections'}]}})).rejects.toMatchObject({code:'CONFIG_CONFLICT'})
 expect(f.owner.current.focus?.zonePresentations?.[0]?.presentation).toBe('sections')
})

it('public Topic discovery shares the implicit sections default and preserves an authored cards choice after durable reload',async()=>{
 const f=await configOwnerFixture(), before=await f.bytes()
 const inspectTopic=()=>executeSettingsControl({schemaVersion:5,requestId:'inspect-topic-default',operation:'settings.get',target:'focus.topicPresentation'},f.owner)
 expect(await inspectTopic()).toMatchObject({entries:[{key:'focus.topicPresentation',value:'sections',default:'sections'}]})
 expect(await f.bytes()).toBe(before); expect(f.owner.current.focus?.topicPresentation).toBeUndefined()
 await executeSettingsControl({schemaVersion:5,requestId:'author-topic-tags',operation:'settings.set',key:'focus.topicPresentation',value:'cards'},f.owner)
 expect(await inspectTopic()).toMatchObject({entries:[{key:'focus.topicPresentation',value:'cards',default:'sections'}]})
 expect((await new ConfigStore(f.store.filePath).get()).focus?.topicPresentation).toBe('cards')
})
