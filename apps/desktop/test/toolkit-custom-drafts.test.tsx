import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ToolkitToolDefinition } from '@agentmux/core/control'
import { useToolkitDrafts, toolkitDraftDirty } from '../src/renderer/src/components/settings/use-toolkit-drafts'
import { composerDOM } from './helpers/composer-dom-fixture'
// A pending write needs no Main/Runtime fixture in this Renderer consumer test.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const dom = composerDOM()
const tool = (id: string): ToolkitToolDefinition => ({ id, revision: `revision-${id}`, name: id, icon: 'terminal', enabled: true, statusBar: 'icon', workspacePath: _hygiene_fixturePath("work"), script: 'console.log(1)', args: [] })
let drafts: ReturnType<typeof useToolkitDrafts>
function Consumer({ tools }: { tools: ToolkitToolDefinition[] }) {
  drafts = useToolkitDrafts(tools)
  return <div>{Object.entries(drafts.entries).map(([id,entry]) => <output key={id} data-tool={id}>{entry.value.name} · {toolkitDraftDirty(entry) ? 'Unsaved' : 'Saved'} · {entry.state}</output>)}</div>
}
describe('single-resource Toolkit authored drafts in an actual mounted consumer', () => {
  it('retains a legitimate own-key ID through the source effect, edit, captured save and local removal', async () => {
    const saved=tool('__proto__')
    await dom.render(<Consumer tools={[saved]} />)
    expect(Object.hasOwn(drafts.entries,'__proto__')).toBe(true)
    expect(Object.keys(drafts.entries)).toEqual(['__proto__'])
    await dom.render(<Consumer tools={[{...saved,icon:'zap',revision:'proto-2'}]} />)
    expect(Object.hasOwn(drafts.entries,'__proto__')).toBe(true)
    await act(async () => { drafts.edit('__proto__',{name:'Exact tool'}) })
    const update=vi.fn(async()=>({...saved,name:'Exact tool',icon:'zap',revision:'proto-3'}))
    await act(async () => { await drafts.save('__proto__',{add:vi.fn(),update}) })
    expect(update).toHaveBeenCalledWith('__proto__',{name:'Exact tool'},{name:'__proto__'})
    expect(drafts.entries.__proto__!.value.name).toBe('Exact tool')
    expect(Object.hasOwn(drafts.entries,'__proto__')).toBe(true)
    await act(async () => { drafts.forget('__proto__') })
    expect(Object.keys(drafts.entries)).toEqual([])
  })
  it('acknowledges A only and retains a later A edit plus the independent B draft', async () => {
    const a=tool('a'),b=tool('b'), held=deferred<ToolkitToolDefinition>()
    await dom.render(<Consumer tools={[a,b]} />)
    await act(async () => { drafts.edit('a',{name:'A submitted'}); drafts.edit('b',{name:'B still unsaved'}) })
    const writer={add:vi.fn(),update:vi.fn(() => held.promise)}
    let saving: Promise<boolean>
    await act(async () => { saving=drafts.save('a',writer) })
    expect(writer.update).toHaveBeenCalledWith('a',{name:'A submitted'},{name:'a'})
    await act(async () => { drafts.edit('a',{name:'A later'}); held.resolve({...a,name:'A submitted',revision:'a-2'}); await saving! })
    expect(drafts.entries.a!.value.name).toBe('A later')
    expect(drafts.entries.a!.expected!.name).toBe('A submitted')
    expect(toolkitDraftDirty(drafts.entries.a!)).toBe(true)
    expect(drafts.entries.b!.value.name).toBe('B still unsaved')
    expect(drafts.entries.b!.expected!.name).toBe('b')
    expect(dom.container.querySelector('[data-tool="b"]')?.textContent).toContain('Unsaved')
  })
  it.each(['script', 'actions'] as const)('preserves the authored %s baseline when this field was first edited during another field’s pending save', async (field) => {
    const original = tool('a'), held = deferred<ToolkitToolDefinition>()
    const outside = field === 'script' ? 'console.log("CLI")' : [{ id: 'refresh', label: 'CLI action', script: 'console.log("CLI")', args: [] }]
    const authored = field === 'script' ? 'console.log("Authored later")' : [{ id: 'refresh', label: 'Authored later', script: 'console.log("Authored later")', args: [] }]
    const cli = { ...original, [field]: outside, icon: 'zap', revision: 'cli-revision' }
    await dom.render(<Consumer tools={[original]} />)
    await act(async () => { drafts.edit('a', { name: 'Submitted name' }) })
    const update = vi.fn(() => held.promise)
    let saving: Promise<boolean>
    await act(async () => { saving = drafts.save('a', { add: vi.fn(), update }) })
    expect(update).toHaveBeenCalledWith('a', { name: 'Submitted name' }, { name: 'a' })
    await act(async () => { drafts.edit('a', { [field]: authored }) })
    await dom.render(<Consumer tools={[cli]} />)
    await act(async () => { held.resolve({ ...cli, name: 'Submitted name', revision: 'accepted-name' }); await saving! })
    expect(drafts.entries.a!.value[field]).toEqual(authored)
    expect(drafts.entries.a!.expected![field]).toEqual(original[field])
    expect(drafts.entries.a!.value.icon).toBe('zap')
    expect(drafts.entries.a!.expected!.name).toBe('Submitted name')
    const conflict = vi.fn(async () => { throw new Error('resource-conflict') })
    await act(async () => { await drafts.save('a', { add: vi.fn(), update: conflict }) })
    expect(conflict).toHaveBeenCalledWith('a', { [field]: authored }, { [field]: field === 'actions' ? [] : original.script })
    expect(drafts.entries.a!.value[field]).toEqual(authored)
    expect(drafts.saveFor('a').error).toContain('resource-conflict')
  })
  it('keeps same-field expectations and adopts an unauthored outside sibling', async () => {
    const a=tool('a')
    await dom.render(<Consumer tools={[a]} />)
    await act(async () => { drafts.edit('a',{name:'Our name'}) })
    await dom.render(<Consumer tools={[{...a,name:'CLI name',icon:'zap',revision:'a-2'}]} />)
    const update=vi.fn(async () => { throw new Error('resource-conflict') })
    await act(async () => { await drafts.save('a',{add:vi.fn(),update}) })
    expect(update).toHaveBeenCalledWith('a',{name:'Our name'},{name:'a'})
    expect(drafts.entries.a!.value.icon).toBe('zap')
    expect(drafts.entries.a!.value.name).toBe('Our name')
    expect(drafts.entries.a!.expected!.name).toBe('a')
    expect(drafts.saveFor('a').error).toContain('resource-conflict')
  })
  it('retains a failed pending draft and publishes only clean outside fields afterward', async () => {
    const a=tool('a')
    let reject!: (error: Error) => void
    const held = {promise: new Promise<ToolkitToolDefinition>((_resolve, fail) => { reject=fail })}
    await dom.render(<Consumer tools={[a]} />)
    await act(async () => { drafts.edit('a',{name:'Our name'}) })
    let saving: Promise<boolean>
    await act(async () => { saving=drafts.save('a',{add:vi.fn(),update:()=>held.promise}) })
    await dom.render(<Consumer tools={[{...a,icon:'zap',revision:'a-2'}]} />)
    expect(drafts.entries.a!.value.icon).toBe('terminal')
    await act(async () => { reject(new Error('reply unconfirmed')); await saving! })
    expect(drafts.entries.a!.value.name).toBe('Our name')
    expect(drafts.entries.a!.value.icon).toBe('zap')
    expect(drafts.entries.a!.saving).toBe(false)
    expect(drafts.entries.a!.state).toBe('error')
  })
  it('does not undo an owner-authored accepted definition with still-old React props', async () => {
    const a=tool('a')
    await dom.render(<Consumer tools={[a]} />)
    await act(async () => { drafts.edit('a',{name:'Accepted'}) })
    await act(async () => { await drafts.save('a',{add:vi.fn(),update:async()=>({...a,name:'Accepted',revision:'a-2'})}) })
    expect(drafts.entries.a!.value.name).toBe('Accepted')
    expect(drafts.entries.a!.expected!.revision).toBe('a-2')
    expect(toolkitDraftDirty(drafts.entries.a!)).toBe(false)
    await act(async () => { drafts.edit('a',{icon:'zap'}) })
    expect(drafts.entries.a!.value.name).toBe('Accepted')
    expect(drafts.entries.a!.value.icon).toBe('zap')
  })
  it('protects one in-flight save and preserves both empty argv and later argv edits', async () => {
    const a=tool('a'), held=deferred<ToolkitToolDefinition>(),update=vi.fn(()=>held.promise)
    await dom.render(<Consumer tools={[a]} />)
    await act(async () => { drafts.edit('a',{name:'Submitted'}) })
    let first: Promise<boolean>,second: Promise<boolean>
    await act(async () => { first=drafts.save('a',{add:vi.fn(),update}); second=drafts.save('a',{add:vi.fn(),update}) })
    expect(update).toHaveBeenCalledTimes(1)
    expect(await second!).toBe(false)
    await act(async () => { drafts.edit('a',{args:['later','']}); held.resolve({...a,name:'Submitted',revision:'a-2'}); await first! })
    expect(drafts.entries.a!.value.args).toEqual(['later',''])
    expect(drafts.entries.a!.expected!.args).toEqual([])
    expect(toolkitDraftDirty(drafts.entries.a!)).toBe(true)
  })
  it('distinguishes known empty/new drafts from an externally removed saved tool', async () => {
    const a=tool('a')
    await dom.render(<Consumer tools={[]} />)
    expect(Object.keys(drafts.entries)).toEqual([])
    await act(async () => { drafts.add('new',{name:'New',icon:'terminal',enabled:true,statusBar:'icon',workspacePath:_hygiene_fixturePath("work"),script:'console.log(1)',args:[]}) })
    expect(drafts.entries.new!.expected).toBeNull()
    expect(drafts.entries.new!.missing).toBe(false)
    await dom.render(<Consumer tools={[a]} />)
    await act(async () => { drafts.edit('a',{script:'console.log(2)'}) })
    await dom.render(<Consumer tools={[]} />)
    expect(drafts.entries.a!.missing).toBe(true)
    expect(drafts.entries.a!.value.script).toBe('console.log(2)')
    expect(drafts.entries.new!.expected).toBeNull()
  })
  it('captures an absent actions field as known empty and retains a later nested action edit during save',async()=> {
    const saved=tool('a'),action={id:'refresh',label:'Submitted action',script:'console.log(2)',args:[]},held=deferred<ToolkitToolDefinition>(),update=vi.fn(()=>held.promise)
    await dom.render(<Consumer tools={[saved]}/>)
    expect(Object.hasOwn(drafts.entries.a!.value,'actions')).toBe(false)
    expect(toolkitDraftDirty(drafts.entries.a!)).toBe(false)
    await act(async()=>drafts.edit('a',{actions:[action]}))
    let saving:Promise<boolean>
    await act(async()=>{saving=drafts.save('a',{add:vi.fn(),update})})
    expect(update).toHaveBeenCalledWith('a',{actions:[action]},{actions:[]})
    await act(async()=>{drafts.edit('a',{actions:[{...action,label:'Later action',args:['later','']}]});held.resolve({...saved,actions:[action],revision:'a-actions'});await saving!})
    expect(drafts.entries.a!.expected!.actions).toEqual([action])
    expect(drafts.entries.a!.value.actions).toEqual([{...action,label:'Later action',args:['later','']}])
    expect(toolkitDraftDirty(drafts.entries.a!)).toBe(true)
    expect(drafts.entries.a!.value.script).toBe(saved.script)
  })
  it('captures absent display as null and preserves later display edits during a pending save', async () => {
    const saved=tool('a'),display={script:'console.log("Display submitted")',args:['literal']},held=deferred<ToolkitToolDefinition>(),update=vi.fn(()=>held.promise)
    await dom.render(<Consumer tools={[saved]}/>)
    await act(async()=>drafts.edit('a',{display}))
    let saving:Promise<boolean>
    await act(async()=>{saving=drafts.save('a',{add:vi.fn(),update})})
    expect(update).toHaveBeenCalledWith('a',{display},{display:null})
    await act(async()=>{drafts.edit('a',{display:{...display,args:['later','']}});held.resolve({...saved,display,revision:'a-display'});await saving!})
    expect(drafts.entries.a!.expected!.display).toEqual(display)
    expect(drafts.entries.a!.value.display).toEqual({...display,args:['later','']})
    expect(drafts.entries.a!.value.script).toBe(saved.script)
    expect(toolkitDraftDirty(drafts.entries.a!)).toBe(true)
  })
  it('preserves authored display source against a CLI whole-field change and allows disabling with null', async () => {
    const display={script:'console.log("Original display")',args:[]},saved={...tool('a'),display}
    await dom.render(<Consumer tools={[saved]}/>)
    await act(async()=>drafts.edit('a',{display:{...display,script:'console.log("Authored display")'}}))
    await dom.render(<Consumer tools={[{...saved,display:{...display,script:'console.log("CLI display")'},icon:'zap',revision:'a-cli'}]}/>)
    const update=vi.fn(async()=>{throw new Error('resource-conflict')})
    await act(async()=>{await drafts.save('a',{add:vi.fn(),update})})
    expect(update).toHaveBeenCalledWith('a',{display:{...display,script:'console.log("Authored display")'}},{display})
    expect(drafts.entries.a!.value.icon).toBe('zap')
    await act(async()=>drafts.edit('a',{display:null}))
    const disable=vi.fn(async()=>({...saved,display:null,revision:'a-disabled'}))
    await act(async()=>{await drafts.save('a',{add:vi.fn(),update:disable})})
    expect(disable).toHaveBeenCalledWith('a',{display:null},{display})
    expect(drafts.entries.a!.value.display).toBeNull()
  })
  it('protects authored nested actions against a CLI whole-field change while adopting a clean sibling',async()=> {
    const action={id:'refresh',label:'Original action',script:'console.log(2)',args:['']},saved={...tool('a'),actions:[action]}
    await dom.render(<Consumer tools={[saved]}/>)
    const authored={...action,label:'Our action'}
    await act(async()=>drafts.edit('a',{actions:[authored]}))
    await dom.render(<Consumer tools={[{...saved,actions:[{...action,label:'CLI action'}],icon:'zap',revision:'a-cli'}]}/>)
    const update=vi.fn(async()=>{throw new Error('resource-conflict')})
    await act(async()=>{await drafts.save('a',{add:vi.fn(),update})})
    expect(update).toHaveBeenCalledWith('a',{actions:[authored]},{actions:[action]})
    expect(drafts.entries.a!.value.actions).toEqual([authored])
    expect(drafts.entries.a!.expected!.actions).toEqual([action])
    expect(drafts.entries.a!.value.icon).toBe('zap')
    expect(drafts.saveFor('a').error).toContain('resource-conflict')
    expect(toolkitDraftDirty(drafts.entries.a!)).toBe(true)
  })
})
