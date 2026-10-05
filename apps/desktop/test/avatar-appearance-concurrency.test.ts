const { fixturePath: _reshape_fixturePath } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigOwner } from '../src/main/config-owner.js'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store.js'
import type { AppConfig } from '../src/shared/contracts.js'
import { moteAvatarRevision } from '../src/main/mote-avatar-writer.js'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const key=JSON.stringify(['local',_reshape_fixturePath("private/avatar-concurrency/original")])
function fixture(){
  let current={appearance:{terminalTheme:'graphite',spaceObjectIcons:{[key]:'gem'},spaceObjectIconRevisions:{foreign:'original-foreign'}},workspaces:[],executors:{},hosts:[],composerShortcuts:[]} as unknown as AppConfig
  let saves=0
  const owner=new ConfigOwner({read:()=>current,save:async next=>{saves++;return structuredClone(next)},publish:next=>{current=next}})
  return {owner,get current(){return current},get saves(){return saves}}
}
function choice(config:AppConfig,value:string|undefined):AppConfig{
  const icons={...config.appearance.spaceObjectIcons};if(value===undefined)delete icons[key];else icons[key]=value
  return {...config,appearance:{...config.appearance,spaceObjectIcons:icons}}
}
describe('original avatar publication revisions',()=>{
  it('does not save a same-value edit after the original schema normalizes metadata order',async()=>{
    const store=new ConfigStore(join(tmpdir(),'agentmux-avatar-readonly-schema-probe.json'))
    let current=store.validate({...structuredClone(DEFAULT_CONFIG),appearance:{...DEFAULT_CONFIG.appearance,
      spaceObjectIcons:{exact:'gem'},spaceObjectIconRevisions:{exact:'original-token'}}})
    let saves=0
    const owner=new ConfigOwner({read:()=>current,save:async next=>{saves++;return store.validate(next)},publish:next=>{current=next}})
    const before=structuredClone(current)
    await owner.edit(before,structuredClone(before))
    expect(current.appearance.spaceObjectIconRevisions).toEqual({exact:'original-token'})
    expect(saves).toBe(0)
  })
  it('refuses a legacy stale edit after A→B→A while retaining the later A',async()=>{
    const f=fixture(),before=structuredClone(f.current)
    await f.owner.update(config=>choice(config,'rocket'));await f.owner.update(config=>choice(config,'gem'))
    await expect(f.owner.edit(before,choice(before,'moon'))).rejects.toThrow('appearance.spaceObjectIcons')
    expect(f.current.appearance.spaceObjectIcons?.[key]).toBe('gem')
  })
  it('changes the native opaque revision after A→B→A without changing its returned choice',async()=>{
    const f=fixture(),target={workspaceId:'__scratch__',topicId:'launcher:leader',objectKey:key}
    const before=moteAvatarRevision(f.current,target)
    await f.owner.update(config=>choice(config,'rocket'));await f.owner.update(config=>choice(config,'gem'))
    expect(moteAvatarRevision(f.current,target)).not.toBe(before)
    expect(f.current.appearance.spaceObjectIcons?.[key]).toBe('gem')
  })
  it('retains a deletion tombstone and foreign nonces through unrelated saves',async()=>{
    const f=fixture();await f.owner.update(config=>choice(config,undefined))
    const nonce=f.current.appearance.spaceObjectIconRevisions?.[key]
    expect(nonce).toBeTypeOf('string')
    await f.owner.update(config=>({...config,appearance:{...config.appearance,terminalTheme:'graphite'}}))
    expect(f.current.appearance.spaceObjectIconRevisions?.[key]).toBe(nonce)
    expect(f.current.appearance.spaceObjectIconRevisions?.foreign).toBe('original-foreign')
    expect(Object.hasOwn(f.current.appearance.spaceObjectIcons??{},key)).toBe(false)
  })
  it('ignores caller-authored nonce replacement without manufacturing a save',async()=>{
    const f=fixture();await f.owner.update(config=>({...config,appearance:{...config.appearance,spaceObjectIconRevisions:{foreign:'forged'}}}))
    expect(f.current.appearance.spaceObjectIconRevisions).toEqual({foreign:'original-foreign'})
    expect(f.saves).toBe(0)
  })
  it('preserves both existing same-value no-op/read-retry cases',async()=>{
    const f=fixture(),before=structuredClone(f.current)
    await f.owner.update(config=>choice(config,'rocket'));await f.owner.update(config=>choice(config,'gem'))
    const saves=f.saves,nonce=f.current.appearance.spaceObjectIconRevisions?.[key]
    await f.owner.edit(before,choice(before,'gem'))
    await f.owner.edit(choice(before,'moon'),choice(before,'gem'))
    expect(f.saves).toBe(saves);expect(f.current.appearance.spaceObjectIconRevisions?.[key]).toBe(nonce)
  })
  it('merges a foreign choice edit after another object publishes without dropping either',async()=>{
    const f=fixture(),before=structuredClone(f.current),other=JSON.stringify(['local',_reshape_fixturePath("private/avatar-concurrency/other")])
    await f.owner.update(config=>choice(config,'rocket'))
    const requested={...before,appearance:{...before.appearance,spaceObjectIcons:{...before.appearance.spaceObjectIcons,[other]:'moon'}}}
    await f.owner.edit(before,requested)
    expect(f.current.appearance.spaceObjectIcons).toEqual({[key]:'rocket',[other]:'moon'})
  })
})
