import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_MOTE_FACE } from '../src/shared/mote-avatars'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { inspectSpaceIconOverrides } from '../src/shared/space-object-appearance'
import { readSpatialAppearance } from '../src/renderer/src/lib/mobile-presentation'

const key = JSON.stringify(['local', _hygiene_fixturePath("work/mote.one")]), other = JSON.stringify(['remote', _hygiene_fixturePath("work/mote.two")])
let store: typeof import('../src/renderer/src/store').useAppStore
let api: typeof import('../src/renderer/src/lib/api').api
let dispose: (() => void) | undefined
let backing: Map<string,string>
beforeEach(async () => {
  vi.resetModules(); backing = new Map()
  vi.stubGlobal('window', { localStorage: { getItem: (name: string) => backing.get(name) ?? null,
    setItem: (name: string, value: string) => backing.set(name, value), removeItem: (name: string) => backing.delete(name) }, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  store = (await import('../src/renderer/src/store')).useAppStore
  api = (await import('../src/renderer/src/lib/api')).api
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({sessions:[],timelines:{},recoveryCandidates:[]})
  vi.spyOn(api.providers, 'list').mockResolvedValue({catalog:[],warnings:[]} as never)
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
})
afterEach(() => { dispose?.();dispose=undefined;vi.restoreAllMocks();vi.unstubAllGlobals() })
async function attach(initial?: Record<string,unknown>) {
  const fixture = await configOwnerFixture(initial === undefined ? {} : {appearance:{terminalTheme:'graphite',spaceObjectIcons:initial}})
  vi.spyOn(api.config,'get').mockImplementation(async()=>fixture.owner.current)
  vi.spyOn(api.config,'save').mockImplementation((after,before)=>fixture.owner.edit(before,after))
  return fixture
}
async function initialize() { dispose=await store.getState().initialize();expect(store.getState().loading).toBe(false) }
function legacy(value:unknown) {backing.set('agentmux-workbench-v1',JSON.stringify({version:1,state:{spaceObjectIcons:value,pinnedItems:{original:['tab']}}}))}

it('hands original local choices once to actual ConfigOwner and keeps immutable raw damaged records', async()=>{
  const face={...DEFAULT_MOTE_FACE,nose:'bridge' as const};const records={[key]:face,[other]:'brain',damaged:{kind:'face',future:'retained'}}
  const f=await attach();legacy(records);await initialize()
  expect((await f.disk()).appearance.spaceObjectIcons).toEqual(records)
  expect(store.getState().spaceObjectIcons).toEqual({[key]:face,[other]:'brain'})
  expect(store.getState().error).toContain('1 saved avatar record')
  expect(store.getState().pinnedItems).toEqual({original:['tab']})
  await store.getState().setSpaceObjectIcon(key,'book')
  expect((await f.disk()).appearance.spaceObjectIcons).toEqual({...records,[key]:'book'})
  await (await import('../src/renderer/src/store')).prepareRendererUpdate()
  expect(JSON.parse(backing.get('agentmux-workbench-v1')!).state.spaceObjectIcons).toBeUndefined()
  // The existing public spatial appearance consumer sees the confirmed selection, not a second writer.
  expect(await readSpatialAppearance(store.getState(), {spaces:[{kind:'project',spaceId:key,hostId:'local'}]} as never, undefined, [], vi.fn())).toEqual([{spaceId:key,glyph:'book'}])
})
it('present empty canonical map wins and cannot resurrect local data on later hydration',async()=>{
  const f=await attach({});legacy({[key]:'brain'});await initialize()
  expect(store.getState().spaceObjectIcons).toEqual({});expect(api.config.save).not.toHaveBeenCalled()
  await store.persist.rehydrate();expect(store.getState().spaceObjectIcons).toEqual({})
  expect((await f.disk()).appearance.spaceObjectIcons).toEqual({})
})
it('concurrent canonical clear beats absent-field handoff without replaying original choices',async()=>{
  const f=await attach();legacy({[key]:'brain'})
  vi.mocked(api.config.save).mockImplementationOnce(async(after,before)=>{
    await f.owner.edit(before,{...before,appearance:{...before.appearance,spaceObjectIcons:{}}})
    return await f.owner.edit(before,after)
  })
  await initialize();expect(store.getState().spaceObjectIcons).toEqual({});expect((await f.disk()).appearance.spaceObjectIcons).toEqual({})
})
it('lost save receipt reads the original durable owner and confirms only the same object choice',async()=>{
  const f=await attach({});await initialize()
  vi.mocked(api.config.save).mockImplementationOnce(async(after,before)=>{await f.owner.edit(before,after);throw new Error('receipt lost')})
  await store.getState().setSpaceObjectIcon(key,DEFAULT_MOTE_FACE)
  expect(store.getState().spaceObjectIcons[key]).toEqual(DEFAULT_MOTE_FACE)
  expect(api.config.save).toHaveBeenCalledTimes(1)
  expect((await f.disk()).appearance.spaceObjectIcons?.[key]).toEqual(DEFAULT_MOTE_FACE)
})
it('failed save retains confirmed choices and rejects while the original draft is held by its caller',async()=>{
  const f=await attach({[key]:'book'});await initialize()
  vi.mocked(api.config.save).mockRejectedValueOnce(new Error('write unavailable'))
  await expect(store.getState().setSpaceObjectIcon(key,'brain')).rejects.toThrow('write unavailable')
  expect(store.getState().spaceObjectIcons[key]).toBe('book');expect((await f.disk()).appearance.spaceObjectIcons?.[key]).toBe('book')
})
it('atomic face conflicts, unrelated opaque keys merge, and raw damaged records survive original ConfigOwner saves',async()=>{
  const f=await attach({[key]:DEFAULT_MOTE_FACE,damaged:{future:true}});const before=f.owner.current
  const a={...DEFAULT_MOTE_FACE,eyes:'spark' as const},b={...DEFAULT_MOTE_FACE,mouth:'grin' as const}
  await f.owner.edit(before,{...before,appearance:{...before.appearance,spaceObjectIcons:{...before.appearance.spaceObjectIcons,[key]:a}}})
  await expect(f.owner.edit(before,{...before,appearance:{...before.appearance,spaceObjectIcons:{...before.appearance.spaceObjectIcons,[key]:b}}})).rejects.toThrow('changed since')
  await f.owner.edit(before,{...before,appearance:{...before.appearance,spaceObjectIcons:{...before.appearance.spaceObjectIcons,[other]:'brain'}}})
  expect((await f.disk()).appearance.spaceObjectIcons).toEqual({[key]:a,[other]:'brain',damaged:{future:true}})
  expect(inspectSpaceIconOverrides((await f.disk()).appearance.spaceObjectIcons).invalidKeys).toEqual(['damaged'])
})
it('unconfirmed handoff keeps original raw bytes and working choices instead of serializing an empty replacement',async()=>{
  await attach();legacy({[key]:'brain'});vi.mocked(api.config.save).mockRejectedValue(new Error('offline'))
  await initialize();expect(store.getState().spaceObjectIcons[key]).toBe('brain')
  expect(store.getState().error).toContain('Avatar preservation is unconfirmed')
  expect(JSON.parse(backing.get('agentmux-workbench-v1')!).state.spaceObjectIcons).toEqual({[key]:'brain'})
})
it('two different object receipts arriving in reverse order keep both later Main choices',async()=>{
  const f=await attach({});await initialize();let finish!:()=>void,committed!:()=>void
  const reached=new Promise<void>(r=>committed=r),wait=new Promise<void>(r=>finish=r)
  vi.mocked(api.config.save).mockImplementationOnce(async(after,before)=>{const saved=await f.owner.edit(before,after);committed();await wait;return saved})
  const first=store.getState().setSpaceObjectIcon(key,'brain');await reached
  await store.getState().setSpaceObjectIcon(other,'book');finish();await first
  expect(store.getState().spaceObjectIcons).toEqual({[key]:'brain',[other]:'book'})
  expect((await f.disk()).appearance.spaceObjectIcons).toEqual(store.getState().spaceObjectIcons)
})
it('same object old receipt cannot replace a newer confirmed original choice',async()=>{
  const f=await attach({});await initialize();let finish!:()=>void,committed!:()=>void
  const reached=new Promise<void>(r=>committed=r),wait=new Promise<void>(r=>finish=r)
  vi.mocked(api.config.save).mockImplementationOnce(async(after,before)=>{const saved=await f.owner.edit(before,after);store.getState().setConfig(saved);committed();await wait;return saved})
  const first=store.getState().setSpaceObjectIcon(key,'brain');await reached
  await store.getState().setSpaceObjectIcon(key,'book');finish();await first
  expect(store.getState().spaceObjectIcons).toEqual({[key]:'book'})
  expect((await f.disk()).appearance.spaceObjectIcons).toEqual(store.getState().spaceObjectIcons)
})
it('a late lost-receipt read cannot roll back newer Main publication during that read',async()=>{
  const f=await attach({});await initialize();let finish!:(value:typeof f.owner.current)=>void,reading!:()=>void
  const reached=new Promise<void>(r=>reading=r)
  vi.mocked(api.config.save).mockImplementationOnce(async(after,before)=>{await f.owner.edit(before,after);throw new Error('old receipt lost')})
  vi.mocked(api.config.get).mockImplementationOnce(()=>{reading();return new Promise(r=>finish=r)})
  const old=store.getState().setSpaceObjectIcon(key,'brain');const rejected=expect(old).rejects.toThrow('old receipt lost');await reached
  const snapshot=f.owner.current;const newer=await f.owner.edit(snapshot,{...snapshot,appearance:{...snapshot.appearance,spaceObjectIcons:{[key]:'book'}}})
  store.getState().setConfig(newer);finish(snapshot);await rejected
  expect(store.getState().spaceObjectIcons[key]).toBe('book')
})
it('unrelated Session changes keep the confirmed projection and do not issue choice writes',async()=>{
  await attach({[key]:DEFAULT_MOTE_FACE});await initialize();const projected=store.getState().spaceObjectIcons
  vi.mocked(api.config.save).mockClear();vi.mocked(api.config.get).mockClear()
  for(let i=0;i<100;i++)store.setState({timelines:{unrelated:{agentSessionId:'unrelated',revision:i,items:[]} as never}})
  expect(store.getState().spaceObjectIcons).toBe(projected);expect(api.config.save).not.toHaveBeenCalled();expect(api.config.get).not.toHaveBeenCalled()
})
