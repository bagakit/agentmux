import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolkitScriptSnapshot, ToolkitToolDefinition } from '@agentmux/core/control'
import { ToolkitPopover } from '../src/renderer/src/components/performance/PerformancePopover'
import { useToolkitScriptObservation } from '../src/renderer/src/components/toolkit/use-toolkit-script-observation'
import { ToolkitSettingsPane } from '../src/renderer/src/components/settings/ToolkitSettingsPane'
import { UserToolkitResult } from '../src/renderer/src/components/toolkit/UserToolkitResult'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'

// Functional draft tests use a plain field for Monaco; real-model/compositor proof is a later gate.
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: ({id,actionId,value,onChange}:{id:string;actionId:string|null;value:string;onChange(value:string):void}) => <textarea data-script-tool={id} data-script-action={actionId ?? ''} aria-label="Script test field" value={value} onChange={event=>onChange(event.target.value)} /> }))
const dom=composerDOM()
const definition=(id:string): ToolkitToolDefinition => ({id,revision:`revision-${id}`,name:id,icon:'terminal',enabled:true,statusBar:'icon',workspacePath:_hygiene_fixturePath("work"),script:'console.log(1)',args:[]})
const snapshot=(id:string,sequence=1): ToolkitScriptSnapshot => ({schema:'agentmux.toolkit.v1',kind:'script',toolId:id,definition:definition(id),state:'idle',reason:null,admission:null,latestConfirmed:null,consumerCount:1,sequence})
beforeEach(()=> { vi.stubGlobal('ResizeObserver',class { observe() {} disconnect() {} unobserve() {} }); vi.stubGlobal('requestAnimationFrame',(f:FrameRequestCallback)=>setTimeout(()=>f(1),0)); vi.stubGlobal('cancelAnimationFrame',clearTimeout) })

describe('Toolkit visible reader and shared selection',()=> {
  it('releases the old selected reader before subscribing the new one, and close only releases its own read',async()=> {
    const calls:string[]=[],publish=new Map<string,(value:ToolkitScriptSnapshot)=>void>()
    const observe=vi.fn((id:string,read:(value:ToolkitScriptSnapshot)=>void)=>{
      calls.push(`observe:${id}`);publish.set(id,read);read(snapshot(id))
      return {dispose:()=>calls.push(`release:${id}`)}
    })
    const get=vi.fn(async(id:string)=>snapshot(id))
    const readerApi={get,observe}
    function Reader({id,active}:{id:string;active:boolean}) { const read=useToolkitScriptObservation(readerApi,id,active);return <output data-reader={id}>{read.snapshot?.definition.name??'Unread'}</output> }
    const view=(selected:string|null)=><><Reader id="a" active={selected==='a'}/><Reader id="b" active={selected==='b'}/></>
    await dom.render(view('a'));expect(calls).toEqual(['observe:a'])
    await dom.render(view('b'));expect(calls).toEqual(['observe:a','release:a','observe:b'])
    await dom.render(view(null));expect(calls).toEqual(['observe:a','release:a','observe:b','release:b'])
    await act(async()=>publish.get('a')!({...snapshot('a',2),definition:{...definition('a'),name:'Late wrong update'}}))
    expect(dom.container.querySelector('[data-reader="a"]')?.textContent).toBe('a')
    expect(get).not.toHaveBeenCalled()
  })
  it('does not move terminal focus on hover; an old close cannot clear a newly selected tool',async()=> {
    vi.useFakeTimers()
    function Consumer() {
      const [selected,setSelected]=useState<string|symbol|null>(null)
      const choose=(next:string|symbol|null,closing?:string|symbol)=>setSelected(current=>closing&&current!==closing?current:next)
      return <><div className="xterm"><input aria-label="Original input"/></div>{['a','b'].map(id=><ToolkitPopover key={id} toolId={id} name={id} icon={<span aria-hidden="true">·</span>} selectedToolId={selected} onSelectTool={choose}>{close=><button data-toolkit-close onClick={close}>Close {id}</button>}</ToolkitPopover>)}</>
    }
    await dom.render(<Consumer/>); const input=dom.container.querySelector<HTMLInputElement>('input')!
    input.focus()
    await dom.hover('[data-toolkit-id="a"]')
    await act(async()=> { vi.advanceTimersByTime(120) })
    expect(document.activeElement).toBe(input)
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    const oldClose=document.querySelector<HTMLButtonElement>('[data-toolkit-close]')!
    await dom.click('[data-toolkit-id="b"]')
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('b')
    await act(async()=> oldClose.click())
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('b')
    vi.useRealTimers()
  })
  it.each(['ordinary', 'monaco'] as const)('closes a passive hover without consuming the connected %s input owner’s Escape or its selection', async (inputKind) => {
    vi.useFakeTimers()
    try {
      const cancelled = vi.fn(), released = vi.fn()
      const readerApi = { get: vi.fn(), observe: vi.fn((_id: string, read: (value: ToolkitScriptSnapshot) => void) => { read(snapshot('a')); return { dispose: released } }) }
      function Result({ close }: { close(): void }) { useToolkitScriptObservation(readerApi, 'a', true); return <button data-toolkit-close onClick={close}>Close a</button> }
      function Consumer() {
        const [selected, setSelected] = useState<string | symbol | null>(null)
        return <><div className={inputKind === 'monaco' ? 'monaco-editor' : undefined}><textarea aria-label="Original editing input" defaultValue="Keep this authored selection" onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { cancelled(); event.preventDefault() } }} /></div><ToolkitPopover toolId="a" name="a" icon={<span>·</span>} selectedToolId={selected} onSelectTool={setSelected}>{close => <Result close={close} />}</ToolkitPopover></>
      }
      await dom.render(<Consumer />)
      const input = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Original editing input"]')!
      expect(input.isConnected).toBe(true)
      expect(input.closest('[hidden],[inert]')).toBeNull()
      expect(getComputedStyle(input).display).not.toBe('none')
      input.focus(); input.setSelectionRange(5, 9)
      await dom.hover('[data-toolkit-id="a"]'); await act(async () => { vi.advanceTimersByTime(120) })
      expect(document.activeElement).toBe(input)
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
      const ime = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, keyCode: 229, bubbles: true, cancelable: true })
      await act(async () => { input.dispatchEvent(ime) })
      expect(cancelled).not.toHaveBeenCalled(); expect(ime.defaultPrevented).toBe(false)
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      await act(async () => { input.dispatchEvent(escape) })
      expect(cancelled).toHaveBeenCalledOnce()
      expect(escape.defaultPrevented).toBe(true) // The original input, not the hover observer, owns cancellation.
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(released).toHaveBeenCalledOnce()
      expect(document.activeElement).toBe(input)
      expect(input.value).toBe('Keep this authored selection')
      expect([input.selectionStart, input.selectionEnd]).toEqual([5, 9])
    } finally { vi.useRealTimers() }
  })
  it('keeps explicit popup Escape and IME with the popup focus owner and returns to its exact connected trigger', async () => {
    function Consumer() {
      const [selected, setSelected] = useState<string | symbol | null>(null)
      return <ToolkitPopover toolId="a" name="a" icon={<span>·</span>} selectedToolId={selected} onSelectTool={setSelected}>{close => <button data-toolkit-close onClick={close}>Close a</button>}</ToolkitPopover>
    }
    await dom.render(<Consumer />); await dom.click('[data-toolkit-id="a"]')
    const close = document.querySelector<HTMLButtonElement>('[data-toolkit-close]')!
    expect(close.isConnected).toBe(true); expect(document.activeElement).toBe(close)
    const ime = new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })
    await act(async () => { close.dispatchEvent(ime) })
    expect(document.activeElement).toBe(close); expect(ime.defaultPrevented).toBe(false)
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => { close.dispatchEvent(escape) })
    expect(escape.defaultPrevented).toBe(true)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(dom.container.querySelector('[data-toolkit-id="a"]'))
  })
  it('creating a tool focuses its name and saving submits one complete captured resource without running',async()=> {
    const add=vi.fn(async(id:string,value:Omit<ToolkitToolDefinition,'id'|'revision'>)=>({...value,id,revision:'owner-issued'}))
    const onRunTool=vi.fn(async()=> 'Admitted')
    await dom.render(<ToolkitSettingsPane tools={[]} active performance={{enabled:true,statusBar:'icon'}} writer={{add,update:vi.fn()}} onSave={vi.fn()} onRemoveTool={vi.fn()} onRunTool={onRunTool}/>)
    const addButton=Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent?.includes('Add tool'))!
    await act(async()=>addButton.click())
    const name=dom.container.querySelector<HTMLInputElement>('.toolkit-editor__name input')!
    expect(document.activeElement).toBe(name)
    const input=(node:HTMLInputElement,value:string)=> { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true})) }
    await act(async()=> { input(name,'Local summary');input(dom.container.querySelector<HTMLInputElement>('.toolkit-editor__fields input:not([type])')!,_hygiene_fixturePath("fixed")) })
    const save=dom.container.querySelector<HTMLButtonElement>('.toolkit-editor .primary-button')!
    expect(save.disabled).toBe(false)
    await act(async()=>save.click())
    expect(add).toHaveBeenCalledTimes(1)
    const [id,value]=add.mock.calls[0]!
    expect(id).toMatch(/^tool-/)
    expect(value).toEqual({name:'Local summary',icon:'terminal',enabled:true,statusBar:'icon',workspacePath:_hygiene_fixturePath("fixed"),script:"console.log('Hello from your toolkit')\n",args:[],actions:[]})
    expect(onRunTool).not.toHaveBeenCalled()
    expect(save.disabled).toBe(true)
  })
  it('does not replace a focused result or its selection on hover; explicit click switches the single reader',async()=> {
    vi.useFakeTimers()
    const calls:string[]=[]
    const readerApi={get:vi.fn(),observe:vi.fn((id:string,read:(value:ToolkitScriptSnapshot)=>void)=>{calls.push(`observe:${id}`);read(snapshot(id));return {dispose:()=>calls.push(`release:${id}`)}})}
    function Result({id,close}:{id:string;close():void}) {
      useToolkitScriptObservation(readerApi,id,true)
      return <><button data-toolkit-close onClick={close}>Close {id}</button><textarea aria-label={`Result ${id}`} defaultValue="Keep this selected text"/></>
    }
    function Consumer() {
      const [selected,setSelected]=useState<string|symbol|null>(null)
      const choose=(next:string|symbol|null,closing?:string|symbol)=>setSelected(current=>closing&&current!==closing?current:next)
      return <><div className="xterm"><input aria-label="Terminal input"/></div>{['a','b'].map(id=><ToolkitPopover key={id} toolId={id} name={id} icon={<span aria-hidden="true">·</span>} selectedToolId={selected} onSelectTool={choose}>{close=><Result id={id} close={close}/>}</ToolkitPopover>)}</>
    }
    await dom.render(<Consumer/>);await dom.click('[data-toolkit-id="a"]')
    const textarea=document.querySelector<HTMLTextAreaElement>('[aria-label="Result a"]')!
    textarea.focus();textarea.setSelectionRange(5,12)
    await dom.hover('[data-toolkit-id="b"]');await act(async()=>vi.advanceTimersByTime(120))
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('a')
    expect(document.activeElement).toBe(textarea)
    expect([textarea.selectionStart,textarea.selectionEnd]).toEqual([5,12])
    expect(calls).toEqual(['observe:a'])
    await dom.click('[data-toolkit-id="b"]')
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('b')
    expect(calls).toEqual(['observe:a','release:a','observe:b'])
    dom.container.querySelector<HTMLInputElement>('[aria-label="Terminal input"]')!.focus()
    await dom.hover('[data-toolkit-id="a"]');await act(async()=>vi.advanceTimersByTime(120))
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('a')
    expect(document.activeElement).toBe(dom.container.querySelector('[aria-label="Terminal input"]'))
    expect(calls).toEqual(['observe:a','release:a','observe:b','release:b','observe:a'])
    await act(async()=>document.querySelector<HTMLButtonElement>('[data-toolkit-close]')!.click())
    expect(calls).toEqual(['observe:a','release:a','observe:b','release:b','observe:a','release:a'])
    vi.useRealTimers()
  })
  it('runs the visible saved target with captured revision and last result, and stops only its exact admitted execution',async()=> {
    const saved=definition('__proto__'),previous={executionId:'previous-a',invocationId:'previous-invocation',definition:saved,expectedLatestExecutionId:null,target:{workspacePath:saved.workspacePath},run:{hostId:'local',runId:'previous-run'},startedAt:1,endedAt:2,exitCode:0,state:'succeeded' as const,reason:null,text:'Confirmed before'}
    let current:ToolkitScriptSnapshot={...snapshot(saved.id),state:'succeeded',latestConfirmed:previous}
    let publish!:(value:ToolkitScriptSnapshot)=>void
    const release=vi.fn(),get=vi.spyOn(api.toolkit,'get').mockImplementation(async()=>current)
    vi.spyOn(api.toolkit,'observe').mockImplementation((id,read)=> { expect(id).toBe('__proto__');publish=read;read(current);return{dispose:release} })
    const run=vi.spyOn(api.toolkit,'run').mockImplementation(async()=>current),stop=vi.spyOn(api.toolkit,'stop').mockImplementation(async()=>current)
    const openToolkit=vi.fn(),close=vi.fn()
    await dom.render(<SettingsNavigation.Provider value={{open:vi.fn(),openToolkit}}><UserToolkitResult definition={saved} active close={close}/></SettingsNavigation.Provider>)
    const runButton=dom.container.querySelector<HTMLButtonElement>('.toolkit-result__actions button')!
    expect(runButton.disabled).toBe(false)
    await act(async()=>runButton.click())
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![0]).toBe('__proto__')
    expect(run.mock.calls[0]![1]).toEqual({invocationId:expect.any(String),expectedRevision:saved.revision,expectedLatestExecutionId:'previous-a'})
    const running={executionId:'admitted-a',invocationId:'invocation-a',definition:saved,expectedLatestExecutionId:'previous-a',target:{workspacePath:saved.workspacePath},run:{hostId:'local',runId:'running-a'},startedAt:3,state:'unknown' as const,reason:'Reply unconfirmed',text:'Current text'}
    current={...current,sequence:2,state:'unknown',admission:running,reason:running.reason}
    await act(async()=>publish(current))
    expect(runButton.disabled).toBe(true)
    const stopButton=Array.from(dom.container.querySelectorAll<HTMLButtonElement>('.toolkit-result__actions button')).find(button=>button.textContent?.trim()==='Stop')!
    expect(stopButton.disabled).toBe(false)
    await act(async()=>stopButton.click())
    expect(stop).toHaveBeenCalledTimes(1);expect(stop).toHaveBeenCalledWith('__proto__','admitted-a')
    const configure=Array.from(dom.container.querySelectorAll<HTMLButtonElement>('.toolkit-result__actions button')).find(button=>button.textContent?.trim()==='Configure')!
    await act(async()=>configure.click())
    expect(close).toHaveBeenCalledOnce();expect(openToolkit).toHaveBeenCalledWith('__proto__')
    expect(get).toHaveBeenCalledTimes(2)
    await dom.render(<p>Closed reader</p>)
    expect(release).toHaveBeenCalledOnce();expect(stop).toHaveBeenCalledTimes(1)
  })
  it('appends current execution text without replacing a selected range, then resets text for a different execution',async()=> {
    const saved=definition('a'),result={executionId:'result-a',invocationId:'invocation-a',definition:saved,expectedLatestExecutionId:null,target:{workspacePath:saved.workspacePath},run:{hostId:'local',runId:'run-a'},startedAt:1,endedAt:2,exitCode:0,state:'succeeded' as const,reason:null,text:'Keep this selected text'}
    let current:ToolkitScriptSnapshot={...snapshot('a'),state:'succeeded',latestConfirmed:result},publish!:(value:ToolkitScriptSnapshot)=>void
    vi.spyOn(api.toolkit,'observe').mockImplementation((_id,read)=> { publish=read;read(current);return{dispose:vi.fn()} })
    await dom.render(<SettingsNavigation.Provider value={{open:vi.fn(),openToolkit:vi.fn()}}><UserToolkitResult definition={saved} active close={vi.fn()}/></SettingsNavigation.Provider>)
    const output=dom.container.querySelector<HTMLPreElement>('[data-toolkit-output]')!,node=output.firstChild!,range=document.createRange()
    range.setStart(node,5);range.setEnd(node,9);document.getSelection()!.removeAllRanges();document.getSelection()!.addRange(range)
    current={...current,sequence:2,latestConfirmed:{...result,text:result.text+'\nNew confirmed suffix'}}
    await act(async()=>publish(current))
    expect(output.firstChild).toBe(node);expect(range.toString()).toBe('this')
    expect(output.textContent).toBe('Keep this selected text\nNew confirmed suffix')
    current={...current,sequence:3,latestConfirmed:{...result,executionId:'result-b',text:'Different confirmed execution'}}
    await act(async()=>publish(current))
    expect(output.firstChild).not.toBe(node);expect(output.textContent).toBe('Different confirmed execution')
  })
  it('edits an action in the single script field, saves its captured whole field, and keeps the main script untouched',async()=> {
    const saved=definition('__proto__'),update=vi.fn(async(_id:string,changes:Partial<ToolkitToolDefinition>)=>({...saved,...changes,revision:'saved-actions'})),onRunTool=vi.fn()
    await dom.render(<ToolkitSettingsPane tools={[saved]} toolId={saved.id} active performance={{enabled:true,statusBar:'icon'}} writer={{add:vi.fn(),update}} onSave={vi.fn()} onRemoveTool={vi.fn()} onRunTool={onRunTool}/>)
    const button=(text:string)=>Array.from(dom.container.querySelectorAll<HTMLButtonElement>('.toolkit-editor button')).find(node=>node.textContent?.trim()===text)!
    await act(async()=>button('Add action').click())
    const label=dom.container.querySelector<HTMLInputElement>('.toolkit-editor__action-heading input')!
    expect(document.activeElement).toBe(label)
    const actionId=dom.container.querySelector<HTMLElement>('[data-toolkit-edit-action]')!.dataset.toolkitEditAction!
    expect(actionId).toMatch(/^action-/)
    const input=(node:HTMLInputElement|HTMLTextAreaElement,value:string)=> { Object.getOwnPropertyDescriptor(node instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true})) }
    await act(async()=> { input(label,'Refresh identity');input(dom.container.querySelector<HTMLTextAreaElement>('[data-script-tool]')!,"console.log('Refreshed')") })
    expect(dom.container.querySelectorAll('[data-script-tool]')).toHaveLength(1)
    expect(dom.container.querySelector<HTMLElement>('[data-script-tool]')!.dataset.scriptAction).toBe(actionId)
    await act(async()=>button('Add argument').click())
    await act(async()=>input(dom.container.querySelector<HTMLInputElement>('.toolkit-argument input')!,'literal $VALUE'))
    await act(async()=>dom.container.querySelector<HTMLButtonElement>('.toolkit-editor .primary-button')!.click())
    const actions=[{id:actionId,label:'Refresh identity',script:"console.log('Refreshed')",args:['literal $VALUE']}]
    expect(update).toHaveBeenCalledOnce();expect(update).toHaveBeenCalledWith('__proto__',{actions},{actions:[]})
    expect(onRunTool).not.toHaveBeenCalled()
    await act(async()=>button('Main script').click())
    expect(dom.container.querySelectorAll('[data-script-tool]')).toHaveLength(1)
    expect(dom.container.querySelector<HTMLTextAreaElement>('[data-script-tool]')!.value).toBe(saved.script)
    await act(async()=>dom.container.querySelector<HTMLButtonElement>('[data-toolkit-edit-action]')!.click())
    expect(dom.container.querySelector<HTMLInputElement>('.toolkit-editor__action-heading input')!.value).toBe('Refresh identity')
    await act(async()=>dom.container.querySelector<HTMLButtonElement>('[aria-label="Remove action Refresh identity"]')!.click())
    expect(dom.container.querySelector('[data-toolkit-edit-action]')).toBeNull()
    expect(dom.container.querySelector<HTMLTextAreaElement>('[data-script-tool]')!.value).toBe(saved.script)
    expect(dom.container.querySelector<HTMLButtonElement>('.toolkit-editor .primary-button')!.disabled).toBe(false)
  })
  it('shows only configured result actions and sends their captured revision, source result and admission baseline without retargeting',async()=> {
    const action={id:'__proto__',label:'Refresh identity',script:"console.log('Action captured')",args:['literal argument']},saved={...definition('__proto__'),actions:[action]}
    const previous={executionId:'source-a',invocationId:'source-invocation',definition:saved,expectedLatestExecutionId:null,target:{workspacePath:saved.workspacePath},run:{hostId:'local',runId:'source-run'},startedAt:1,endedAt:2,exitCode:0,state:'succeeded' as const,reason:null,text:'{"buttons":[{"label":"Injected from output"}]}'}
    let current:ToolkitScriptSnapshot={...snapshot(saved.id),definition:{...saved,revision:'new-owner-revision',workspacePath:_hygiene_fixturePath("new-target"),actions:[{...action,label:'New action label',script:'New script'}]},state:'succeeded',latestConfirmed:previous},publish!:(value:ToolkitScriptSnapshot)=>void
    vi.spyOn(api.toolkit,'observe').mockImplementation((_id,read)=>{publish=read;read(current);return{dispose:vi.fn()}})
    const invoke=vi.spyOn(api.toolkit,'action').mockRejectedValue(new Error('CONFIG_CONFLICT: tool configuration changed'))
    const run=vi.spyOn(api.toolkit,'run')
    await dom.render(<SettingsNavigation.Provider value={{open:vi.fn(),openToolkit:vi.fn()}}><UserToolkitResult definition={current.definition} active close={vi.fn()}/></SettingsNavigation.Provider>)
    const buttons=dom.container.querySelectorAll<HTMLButtonElement>('[data-toolkit-action]')
    expect(buttons).toHaveLength(1);expect(buttons[0]!.textContent).toBe('Refresh identity')
    expect(dom.container.textContent).not.toContain('New action label')
    expect(buttons[0]!.disabled).toBe(false)
    await act(async()=>buttons[0]!.click())
    expect(invoke).toHaveBeenCalledOnce();expect(invoke).toHaveBeenCalledWith('__proto__','__proto__',{invocationId:expect.any(String),expectedRevision:saved.revision,sourceExecutionId:'source-a',expectedAdmissionExecutionId:null})
    expect(run).not.toHaveBeenCalled();expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('CONFIG_CONFLICT')
    current={...current,sequence:2,state:'unknown',reason:'Outcome unconfirmed'}
    await act(async()=>publish(current))
    expect(buttons[0]!.disabled).toBe(true)
    current={...current,sequence:3,state:'succeeded',reason:null,latestConfirmed:{...previous,definition:{...saved,actions:[]}}}
    await act(async()=>publish(current))
    expect(dom.container.querySelectorAll('[data-toolkit-action]')).toHaveLength(0)
    expect(dom.container.querySelector('[data-toolkit-output]')!.textContent).toBe(previous.text)
    expect(invoke).toHaveBeenCalledOnce()
  })
  it('reads the actual captured action script and arguments instead of the main entry script',async()=> {
    const action={id:'refresh',label:'Refresh identity',script:'Captured action source',args:['captured argument']},saved={...definition('a'),actions:[action]}
    const result={executionId:'action-result',invocationId:'action-invocation',definition:saved,expectedLatestExecutionId:'source-a',target:{workspacePath:saved.workspacePath},run:{hostId:'local',runId:'action-run'},startedAt:3,endedAt:4,exitCode:0,state:'succeeded' as const,reason:null,text:'Action output',action:{id:'refresh',sourceExecutionId:'source-a',expectedAdmissionExecutionId:null}}
    const current:ToolkitScriptSnapshot={...snapshot('a'),definition:saved,state:'succeeded',latestConfirmed:result}
    vi.spyOn(api.toolkit,'observe').mockImplementation((_id,read)=>{read(current);return{dispose:vi.fn()}})
    await dom.render(<SettingsNavigation.Provider value={{open:vi.fn(),openToolkit:vi.fn()}}><UserToolkitResult definition={saved} active close={vi.fn()}/></SettingsNavigation.Provider>)
    expect(dom.container.querySelector('.toolkit-result__origin')?.textContent).toBe('Action · Refresh identity')
    const script=Array.from(dom.container.querySelectorAll<HTMLButtonElement>('.toolkit-result__actions button')).find(node=>node.textContent?.trim()==='Script')!
    await act(async()=>script.click())
    expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Read-only toolkit script"]')!.value).toBe(action.script)
    expect(dom.container.textContent).toContain(JSON.stringify(action.args))
    expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Read-only toolkit script"]')!.readOnly).toBe(true)
  })
  it('keeps the authored built-in preference when visiting another tool; an explicit missing target stays unavailable',async()=> {
    const tools=[definition('saved')]
    const props={tools,active:true,performance:{enabled:true,statusBar:'icon' as const},writer:{add:vi.fn(),update:vi.fn()},onSave:vi.fn(),onRemoveTool:vi.fn(),onRunTool:vi.fn()}
    await dom.render(<ToolkitSettingsPane {...props}/>)
    const checkbox=dom.container.querySelector<HTMLInputElement>('.toolkit-settings__toggle input')!
    await act(async()=>checkbox.click())
    expect(checkbox.checked).toBe(false)
    await act(async()=>dom.container.querySelector<HTMLButtonElement>('[data-tool-id="saved"]')!.click())
    expect(dom.container.querySelector('[data-tool-editor="saved"]')).not.toBeNull()
    await act(async()=>dom.container.querySelector<HTMLButtonElement>('[data-tool-id="performance"]')!.click())
    expect(dom.container.querySelector<HTMLInputElement>('.toolkit-settings__toggle input')!.checked).toBe(false)
    expect(dom.container.querySelector<HTMLButtonElement>('.toolkit-settings .primary-button')!.disabled).toBe(false)
    expect(props.onSave).not.toHaveBeenCalled()
    await dom.render(<ToolkitSettingsPane {...props} toolId="absent"/>)
    expect(dom.container.querySelector('.toolkit-workbench__empty')?.textContent).toContain('This saved tool is unavailable.')
    expect(dom.container.querySelector('[data-tool-id="performance"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(dom.container.querySelector('[data-tool-editor]')).toBeNull()
  })
  it('deletes the legitimate own-key tool through the captured owner callback without targeting another tool',async()=> {
    const saved=definition('__proto__'),onRemoveTool=vi.fn(async()=>undefined)
    await dom.render(<ToolkitSettingsPane tools={[saved]} toolId={saved.id} active performance={{enabled:true,statusBar:'icon'}} writer={{add:vi.fn(),update:vi.fn()}} onSave={vi.fn()} onRemoveTool={onRemoveTool} onRunTool={vi.fn()}/>)
    expect(dom.container.querySelector('[data-tool-editor]')?.getAttribute('data-tool-editor')).toBe('__proto__')
    const remove=Array.from(dom.container.querySelectorAll<HTMLButtonElement>('.toolkit-editor__footer button')).find(button=>button.textContent?.includes('Delete tool'))!
    await act(async()=>remove.click())
    const confirm=document.querySelector<HTMLButtonElement>('[data-confirm-label="Delete tool"]')!
    expect(confirm.isConnected).toBe(true)
    await act(async()=>confirm.click())
    expect(onRemoveTool).toHaveBeenCalledTimes(1)
    expect(onRemoveTool).toHaveBeenCalledWith('__proto__',{name:'__proto__',icon:'terminal',enabled:true,statusBar:'icon',workspacePath:_hygiene_fixturePath("work"),script:'console.log(1)',args:[]})
    expect(dom.container.querySelector('[data-tool-editor="__proto__"]')).toBeNull()
  })
})
