// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
const dom=composerDOM()
const editor=()=>dom.container.querySelector<HTMLElement>('[role="textbox"]')!
async function key(key:string,options:KeyboardEventInit={}) {
 const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options})
 await act(async()=>editor().dispatchEvent(event))
 return event
}
async function draft(value:string){await act(async()=>useAppStore.getState().setAgentComposerDraft('agent-1',value))}
beforeEach(()=>{
 useAppStore.setState({agentComposerHistory:{},agentComposerHistoryNavigation:{}})
 vi.spyOn(api.continuousProgress,'list').mockResolvedValue([])
 vi.spyOn(api.continuousProgress,'pauseForInput').mockResolvedValue(undefined)
 Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value(){}})
})
it('real DOM arrows recall accepted bodies and restore the exact draft without dispatch',async()=>{
 vi.spyOn(useAppStore.getState(),'sendQueuedAgentSteer').mockResolvedValue('submitted')
 const submit=vi.spyOn(api.sessions,'submitPrompt')
 await draft('first accepted');await dom.render(<AgentSessionComposer sessionId="agent-1" />)
 await key('Enter',{metaKey:true})
 expect(useAppStore.getState().agentComposerHistory['agent-1']).toEqual(['first accepted'])
 await draft('second queued');await key('Enter')
 expect(useAppStore.getState().agentComposerHistory['agent-1']).toEqual(['first accepted','second queued'])
 await draft('original unfinished draft')
 const queue=structuredClone(useAppStore.getState().agentSteerQueues),send=vi.spyOn(useAppStore.getState(),'send'),enqueue=vi.spyOn(useAppStore.getState(),'enqueueAgentSteer'),interrupt=vi.spyOn(useAppStore.getState(),'interrupt'),respond=vi.spyOn(useAppStore.getState(),'respondInteraction')
 expect((await key('ArrowUp')).defaultPrevented).toBe(true);expect(dom.draft()).toBe('second queued')
 await key('ArrowUp');expect(dom.draft()).toBe('first accepted')
 await key('ArrowDown');expect(dom.draft()).toBe('second queued')
 await key('ArrowDown');expect(dom.draft()).toBe('original unfinished draft')
 expect(useAppStore.getState().agentSteerQueues).toEqual(queue)
 expect(send).not.toHaveBeenCalled();expect(enqueue).not.toHaveBeenCalled();expect(interrupt).not.toHaveBeenCalled();expect(respond).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled()
})
it('rejected Send and queue leave both draft and history unchanged',async()=>{
 vi.spyOn(useAppStore.getState(),'send').mockReturnValue(false)
 vi.spyOn(useAppStore.getState(),'enqueueAgentSteer').mockReturnValue(false)
 await draft('refused original');await dom.render(<AgentSessionComposer sessionId="agent-1" />)
 await key('Enter',{metaKey:true});await key('Enter')
 expect(useAppStore.getState().agentComposerHistory).toEqual({});expect(dom.draft()).toBe('refused original')
})
it('IME and empty-history arrows fall through and Sessions never share recalled bodies',async()=>{
 useAppStore.getState().recordAgentComposerHistory('agent-2','neighbor only')
 await dom.render(<AgentSessionComposer sessionId="agent-1" />)
 expect((await key('ArrowUp')).defaultPrevented).toBe(false);expect(dom.draft()).toBe('Keep my draft')
 useAppStore.getState().recordAgentComposerHistory('agent-1','own body')
 expect((await key('ArrowUp',{isComposing:true})).defaultPrevented).toBe(false);expect(dom.draft()).toBe('Keep my draft')
 expect((await key('ArrowUp')).defaultPrevented).toBe(true);expect(dom.draft()).toBe('own body')
 expect(useAppStore.getState().agentComposerHistory['agent-2']).toEqual(['neighbor only'])
})

it('DOM line boundaries and open suggestions retain their original keyboard ownership',async()=>{
 useAppStore.getState().recordAgentComposerHistory('agent-1','older body')
 await draft('first\nmiddle\nlast');await dom.render(<AgentSessionComposer sessionId="agent-1" />)
 const text=editor().querySelectorAll('p')[1]!.firstChild!, range=document.createRange();range.setStart(text,2);range.collapse(true)
 const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range)
 // ProseMirror consumes its real DOM selection before the keyboard event.
 document.dispatchEvent(new Event('selectionchange'));await act(async()=>new Promise(resolve=>setTimeout(resolve,0)))
 expect((await key('ArrowUp')).defaultPrevented).toBe(false);expect(dom.draft()).toBe('first\nmiddle\nlast')
 expect((await key('ArrowDown')).defaultPrevented).toBe(false);expect(dom.draft()).toBe('first\nmiddle\nlast')
 await draft('/');await act(async()=>new Promise(resolve=>setTimeout(resolve,0)))
 const candidates=dom.container.querySelectorAll('.composer__suggestions button')
 // This preview catalog may have no commands; install a real configured shortcut for the same consumer.
 await act(async()=>useAppStore.setState(s=>({config:{...s.config!,composerShortcuts:[{id:'own',keyword:'history-action',label:'History action',body:'Action body'}]}})))
 expect(dom.container.querySelectorAll('.composer__suggestions button').length).toBeGreaterThan(0)
 const historyBefore=structuredClone(useAppStore.getState().agentComposerHistoryNavigation)
 await key('ArrowDown');expect(document.activeElement?.closest('.composer__suggestions')).not.toBeNull()
 expect(dom.draft()).toBe('/');expect(useAppStore.getState().agentComposerHistoryNavigation).toEqual(historyBefore)
})
it('history changes reach the persisted fastpath, navigation stays transient, and hydration preserves unknown delivery',()=>{
 const state=useAppStore.getState(),partialize=useAppStore.persist.getOptions().partialize!, merge=useAppStore.persist.getOptions().merge!
 const original={operationId:'same-op',runId:'run-agent-1',text:'unknown original',promptCondition:{expectedRun:{runId:'run-agent-1'},afterSubmissionId:null},execution:'immediate' as const,status:'deferred' as const,error:'Original outcome unknown',errorCode:'NO_ACK',logId:'original-log'}
 useAppStore.setState({agentSteerQueues:{'agent-1':[original]},agentComposerDrafts:{'agent-1':'private draft','agent-2':'neighbor draft'}})
 const before=partialize(useAppStore.getState())
 state.recordAgentComposerHistory('agent-1','accepted unknown original')
 const saved=partialize(useAppStore.getState()) as any
 expect(saved).not.toBe(before);expect(saved.agentComposerHistory).toEqual({'agent-1':['accepted unknown original']})
 state.recallAgentComposerHistory('agent-1','older','private draft')
 const recalled=partialize(useAppStore.getState()) as any
 expect(recalled).not.toBe(saved)
 expect(recalled.agentComposerDrafts).toEqual({'agent-1':'accepted unknown original','agent-2':'neighbor draft'})
 state.recallAgentComposerHistory('agent-1','older','accepted unknown original')
 expect(partialize(useAppStore.getState())).toBe(recalled)
 expect(saved).not.toHaveProperty('agentComposerHistoryNavigation')
 const restored=merge(saved,{...state,agentComposerHistory:{},agentComposerHistoryNavigation:{}})
 expect(restored.agentComposerHistory).toEqual(saved.agentComposerHistory);expect(restored.agentComposerHistoryNavigation).toEqual({})
 expect(restored.agentSteerQueues['agent-1']).toEqual([original]);expect(restored.agentComposerDrafts).toEqual({'agent-1':'private draft','agent-2':'neighbor draft'})
 expect(merge({...saved,agentComposerHistory:{broken:[null],valid:['exact body']}},state).agentComposerHistory).toEqual({valid:['exact body']})
})

it('plain arrows browse consecutive multiline records and return once to the original blank draft', async () => {
 const state=useAppStore.getState()
 state.recordAgentComposerHistory('agent-1','older first\nolder last')
 state.recordAgentComposerHistory('agent-1','newer first\nnewer last')
 await draft('');await dom.render(<AgentSessionComposer sessionId="agent-1" />)
 editor().focus()
 const input=editor() as HTMLElement & { editor: import('@tiptap/core').Editor }
 expect((await key('ArrowUp')).defaultPrevented).toBe(true);expect(dom.draft()).toBe('newer first\nnewer last')
 expect((await key('ArrowUp')).defaultPrevented).toBe(true);expect(dom.draft()).toBe('older first\nolder last')
 expect((await key('ArrowDown')).defaultPrevented).toBe(true);expect(dom.draft()).toBe('newer first\nnewer last')
 expect((await key('ArrowDown')).defaultPrevented).toBe(true);expect(dom.draft()).toBe('')
 expect((await key('ArrowDown')).defaultPrevented).toBe(false)
 // Temporary history navigation did not create a stack of undoable prompt replacements.
 await act(async()=>{expect(input.editor.commands.undo()).toBe(false)})
 expect(dom.draft()).toBe('')
 expect(api.continuousProgress.pauseForInput).not.toHaveBeenCalled()
})

it('modifiers, IME and selected text remain editor-owned before and during browsing', async () => {
 useAppStore.getState().recordAgentComposerHistory('agent-1','history first\nhistory last')
 await dom.render(<AgentSessionComposer sessionId="agent-1" />)
 const input=editor() as HTMLElement & { editor: import('@tiptap/core').Editor }
 input.focus()
 for(const marker of [{shiftKey:true},{metaKey:true},{ctrlKey:true},{altKey:true},{isComposing:true},{keyCode:229}]) {
  const before=dom.draft()
  expect((await key('ArrowUp',marker)).defaultPrevented).toBe(false)
  expect(dom.draft()).toBe(before)
 }
 await act(async()=>{input.editor.commands.setTextSelection({from:1,to:5})})
 expect((await key('ArrowUp')).defaultPrevented).toBe(false);expect(dom.draft()).toBe('Keep my draft')
 await act(async()=>{input.editor.commands.setTextSelection(1)})
 await key('ArrowUp');expect(dom.draft()).toBe('history first\nhistory last')
 await act(async()=>{input.editor.commands.setTextSelection({from:1,to:5})})
 expect((await key('ArrowDown')).defaultPrevented).toBe(false);expect(dom.draft()).toBe('history first\nhistory last')
})

it('an actual edit and its undo exit old browsing without resurrecting the old stash', async () => {
 useAppStore.getState().recordAgentComposerHistory('agent-1','recalled body')
 await dom.render(<AgentSessionComposer sessionId="agent-1" />)
 const input=editor() as HTMLElement & { editor: import('@tiptap/core').Editor };input.focus()
 await key('ArrowUp')
 await act(async()=>{input.editor.commands.insertContent(' edited')})
 const edited=dom.draft()
 expect(edited).toContain(' edited')
 expect(useAppStore.getState().agentComposerHistoryNavigation['agent-1']).toBeUndefined()
 expect((await key('ArrowDown')).defaultPrevented).toBe(false);expect(dom.draft()).toBe(edited)
 await act(async()=>{expect(input.editor.commands.undo()).toBe(true)})
 expect(dom.draft()).toBe('recalled body')
 expect(useAppStore.getState().agentComposerHistoryNavigation['agent-1']).toBeUndefined()
 expect((await key('ArrowDown')).defaultPrevented).toBe(false);expect(dom.draft()).toBe('recalled body')
})

it('an external same-Session draft replacement survives remount and a different Agent never shares its stash', async () => {
 await act(async()=>useAppStore.setState({sessions:[composerSession(),composerSession('agent-2')]}))
 const state=useAppStore.getState();state.recordAgentComposerHistory('agent-1','A history');state.recordAgentComposerHistory('agent-2','B history')
 await dom.render(<AgentSessionComposer key="A" sessionId="agent-1" />);await key('ArrowUp')
 await act(async()=>state.setAgentComposerDraft('agent-2','B unfinished'))
 await dom.render(<AgentSessionComposer key="B" sessionId="agent-2" />)
 const event=new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true})
 await act(async()=>editor().dispatchEvent(event));expect(dom.draft('agent-2')).toBe('B history')
 await draft('A new draft from another surface')
 await dom.render(<AgentSessionComposer key="A" sessionId="agent-1" />)
 expect((await key('ArrowDown')).defaultPrevented).toBe(false)
 expect(dom.draft()).toBe('A new draft from another surface')
 expect(dom.draft('agent-2')).toBe('B history')
})

it('suggestions keep arrows and Enter at their real focused button, and Escape returns to editing', async () => {
 await act(async()=>useAppStore.setState(s=>({config:{...s.config!,composerShortcuts:[
  {id:'a',keyword:'alpha',label:'Alpha',body:'body A'}, {id:'b',keyword:'beta',label:'Beta',body:'body B'}
 ]}})))
 await draft('/');await dom.render(<AgentSessionComposer sessionId="agent-1" />);editor().focus()
 const send=vi.spyOn(useAppStore.getState(),'send'),enqueue=vi.spyOn(useAppStore.getState(),'enqueueAgentSteer')
 const buttons=()=>[...dom.container.querySelectorAll<HTMLButtonElement>('.composer__suggestions button')]
 async function focusedKey(name:string){const event=new KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true});await act(async()=>document.activeElement!.dispatchEvent(event));return event}
 await focusedKey('ArrowDown');expect(document.activeElement).toBe(buttons()[0])
 await focusedKey('ArrowDown');expect(document.activeElement).toBe(buttons()[1])
 await focusedKey('ArrowUp');expect(document.activeElement).toBe(buttons()[0])
 expect((await focusedKey('Escape')).defaultPrevented).toBe(true)
 expect(document.activeElement).toBe(editor());expect(buttons()).toHaveLength(0);expect(dom.draft()).toBe('/')
 await draft('/b');expect(buttons()).toHaveLength(1)
 await focusedKey('ArrowDown');expect(document.activeElement).toBe(buttons()[0])
 expect((await focusedKey('Enter')).defaultPrevented).toBe(true)
 expect(dom.draft()).toContain('agentmux-subcommand:body%20B');expect(document.activeElement).toBe(editor())
 expect(send).not.toHaveBeenCalled();expect(enqueue).not.toHaveBeenCalled()
})


it('a browsing snapshot keeps its original records when a query page changes, then releases at the live draft', () => {
 const state=useAppStore.getState()
 state.recordAgentComposerHistory('agent-1','saved local body')
 const candidates=['query older','query newest']
 expect(state.recallAgentComposerHistory('agent-1','older','private unfinished',candidates)).toBe('query newest')
 candidates.reverse()
 expect(state.recallAgentComposerHistory('agent-1','older','query newest',['different newest'])).toBe('query older')
 expect(state.recallAgentComposerHistory('agent-1','newer','query older',[])).toBe('query newest')
 expect(state.recallAgentComposerHistory('agent-1','newer','query newest',[])).toBe('private unfinished')
 expect(useAppStore.getState().agentComposerHistoryNavigation['agent-1']).not.toHaveProperty('entries')
 expect(state.recallAgentComposerHistory('agent-1','older','private unfinished',['different newest'])).toBe('different newest')
 expect(useAppStore.getState().agentComposerHistory['agent-1']).toEqual(['saved local body'])
})


it('returning from temporary history browsing preserves the original typed-draft undo', async () => {
 useAppStore.getState().recordAgentComposerHistory('agent-1','history first\nhistory last')
 await draft('');await dom.render(<AgentSessionComposer sessionId="agent-1" />)
 const input=editor() as HTMLElement & { editor: import('@tiptap/core').Editor };input.focus()
 await act(async()=>{input.editor.commands.insertContent('typed live draft')})
 await key('ArrowUp');await key('ArrowDown')
 expect(dom.draft()).toBe('typed live draft')
 await act(async()=>{expect(input.editor.commands.undo()).toBe(true)})
 expect(dom.draft()).toBe('')
 await act(async()=>{expect(input.editor.commands.redo()).toBe(true)})
 expect(dom.draft()).toBe('typed live draft')
})


it('an external edit with the same original body is not a history restoration', async () => {
 useAppStore.getState().recordAgentComposerHistory('agent-1','preview body')
 await draft('');await dom.render(<AgentSessionComposer sessionId="agent-1" />)
 const input=editor() as HTMLElement & { editor: import('@tiptap/core').Editor };input.focus()
 await act(async()=>{input.editor.commands.insertContent('original typed body')})
 await key('ArrowUp')
 await draft('original typed body')
 expect(useAppStore.getState().agentComposerHistoryNavigation['agent-1']).toBeUndefined()
 await act(async()=>{expect(input.editor.commands.undo()).toBe(false)})
 expect(dom.draft()).toBe('original typed body')
})
