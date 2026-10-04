// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { composerDOM } from './helpers/composer-dom-fixture'
import { layoutTimelineMarkers, TIMELINE_MARKER_SIZE } from '../src/renderer/src/lib/timeline-marker-layout'
import { conversationAxis, clusterConversationAxis, speaksAsHuman } from '../src/renderer/src/lib/conversation-axis'
import { ConversationAxis } from '../src/renderer/src/components/ConversationAxis'
import { focusMessageMarkers } from '../src/renderer/src/lib/focus-message-markers'
import { projectConversationRecords } from '@agentmux/client-ui/conversation-records'
import type { RulerRecord } from '../src/renderer/src/lib/conversation-ruler'
const dom = composerDOM()
const render = dom.render
const buttons = () => [...dom.container.querySelectorAll<HTMLButtonElement>('button')]
const buttonNamed = (name: string) => buttons().find(button => button.getAttribute('aria-label') === name)!
const markers = (centers: number[], width=1000) => centers.map((center,index)=>({fraction:center/width,member:index}))
const records=(points:number[]):RulerRecord[]=>points.map((at,index)=>({kind:'ruler-record',id:'r'+index,recordedAt:at,speaker:{role:'human',id:'author'+index},target:{kind:'observed',index},record:{id:'raw'+index,kind:'user-message',startedAt:at,contentParts:[{kind:'text',text:'Original '+index}]}}))
const messages=projectConversationRecords({agentSessionId:'s',timeline:{agentSessionId:'s',revision:1,items:[0,20,40].map((at,index)=>({id:'m'+index,agentSessionId:'s',kind:'user_message' as const,source:'native-hook' as const,status:'complete' as const,createdAt:at,updatedAt:at,title:'Recorded input',content:'Original '+index}))}})
describe('24px final screen targets',()=>{
 it.each([-1,-.5,0,.5,1])('uses actual overlap at 24%+d',delta=>{const result=layoutTimelineMarkers(markers([100,124+delta]),1000);expect(result).toHaveLength(delta<0?1:2);expect(TIMELINE_MARKER_SIZE).toBe(24)})
 it.each([-1,-.5,0,.5,1])('never uses the former 64px group width at 64%+d',delta=>{expect(layoutTimelineMarkers(markers([100,164+delta]),1000)).toHaveLength(2)})
 it('retains four already free targets and does not chain AB into free C/D',()=>{expect(layoutTimelineMarkers(markers([100,125.92,151.84,177.76]),1000).map(g=>g.members)).toEqual([[0],[1],[2],[3]]);expect(layoutTimelineMarkers(markers([100,120,140,165]),1000).map(g=>g.members)).toEqual([[0,1],[2],[3]])})
 it('checks clamped final boxes and expands after resize or pan',()=>{expect(layoutTimelineMarkers(markers([0,24]),1000).map(g=>g.members)).toEqual([[0,1]]);expect(layoutTimelineMarkers(markers([976,1000]),1000).map(g=>g.members)).toEqual([[0,1]]);const input=[{fraction:.2,member:'a'},{fraction:.22,member:'b'}];expect(layoutTimelineMarkers(input,1000)).toHaveLength(1);expect(layoutTimelineMarkers(input,2000)).toHaveLength(2);expect(layoutTimelineMarkers(input.map(m=>({...m,fraction:m.fraction+.5})),2000)).toHaveLength(2);expect(input[0]!.fraction).toBe(.2)})
 it('keeps source order and exact times for same-time 100+ records and unknown width',()=>{const input=Array.from({length:103},(_,index)=>({fraction:.5,member:index}));expect(layoutTimelineMarkers(input,300)[0]!.members).toEqual(input.map(m=>m.member));for(const width of [0,NaN,Infinity])expect(layoutTimelineMarkers(input,width)).toHaveLength(103);expect(layoutTimelineMarkers(input,10)).toHaveLength(1)})
 it('both production owners consume the same boxes and preserve record indices/0 time',()=>{const items=records([0,20,40,1000]);const marks=conversationAxis(items,speaksAsHuman);expect(clusterConversationAxis(marks,1000).map(g=>g.members.map(m=>m.index))).toEqual([[0,1],[2],[3]]);expect(items.map(m=>m.recordedAt)).toEqual([0,20,40,1000]);const focus=focusMessageMarkers(messages,{start:0,end:1000},1000);expect(focus.map(g=>g.records.map(r=>r.rawId))).toEqual([['m0','m1'],['m2']]);expect(focus.map(g=>[g.startAt,g.endAt])).toEqual([[0,20],[40,40]]);expect(focus[0]!.fraction).toBe(.012)})
 it('keeps single author keyboard/hover indices and nullable recent era',async()=>{const onSelect=vi.fn(),onPeek=vi.fn();await render(<ConversationAxis items={records([0,300,600,1000])} belongs={speaksAsHuman} label="Authors" size={16} describe={s=>({name:s.id!})} selectedIndex={null} width={1000} recentFraction={null} onSelect={onSelect} onPeek={onPeek}/>);const button=buttonNamed('author2');await act(async()=>button.focus());expect(onPeek.mock.calls[0]![0].mark.index).toBe(2);await act(async()=>button.click());expect(onSelect).toHaveBeenCalledWith(2);expect(button.hasAttribute('data-era')).toBe(false);expect(buttons()).toHaveLength(4)})
 it('uses a compact exact count and original member menu for 103 authors',async()=>{const onSelect=vi.fn();await render(<ConversationAxis items={records(Array(103).fill(0))} belongs={speaksAsHuman} label="Authors" size={16} describe={s=>({name:s.id!})} selectedIndex={102} width={24} onSelect={onSelect}/>);const group=buttonNamed('103 messages; choose a record');expect(group.textContent).toBe('99+');expect(group.querySelector('.conversation-axis__avatar')).toBeNull();await act(async()=>group.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})));let member:HTMLElement|null=null;await vi.waitFor(()=>{member=[...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find(item=>item.textContent?.includes('author102'))??null;expect(member).not.toBeNull()});await act(async()=>member!.click());expect(onSelect).toHaveBeenCalledWith(102)})
 it('renders the real Recent consumer with distinct author glyphs and truthful mixed count direction',async()=>{
  const bounds=HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){return this.classList.contains('recent-focus__time-scale')?new DOMRect(0,0,864,18):bounds.call(this)})
  const now=Date.now(),id='agent-1',timeline={agentSessionId:id,revision:1,items:[
    {id:'old-input',agentSessionId:id,kind:'user_message' as const,source:'user' as const,status:'complete' as const,createdAt:now-7200000,updatedAt:now-7200000,title:'Input',content:'Original human input',authorHuman:true},
    {id:'input',agentSessionId:id,kind:'user_message' as const,source:'user' as const,status:'complete' as const,createdAt:now-10000,updatedAt:now-10000,title:'Input',content:'Original input',authorHuman:true},
    {id:'reply',agentSessionId:id,kind:'assistant_message' as const,source:'native-hook' as const,status:'complete' as const,createdAt:now-9000,updatedAt:now-9000,title:'Reply',content:'Original reply'}]}
  vi.spyOn(api.sessions,'historySources').mockResolvedValue([])
  vi.spyOn(api.sessions,'historyPage').mockResolvedValue({agentSessionId:id,source:{providerId:'codex',nativeSessionId:'native'},items:[],nextCursor:null})
  vi.spyOn(api.sessions,'timeline').mockResolvedValue(timeline)
  useAppStore.setState({timelines:{[id]:timeline},agentFocus:{execution:{sessionId:id,history:[]},pmo:{sessionId:null}}})
  const contexts=createFocusProjectionSelector()(useAppStore.getState()).contexts
  await render(<RecentFocusTimeline entries={[]} currentSessionId={id} currentContext={{id,hostId:'local'}} contexts={contexts} onSelect={()=>{}} />)
  await vi.waitFor(()=>expect(dom.container.querySelectorAll('.recent-focus__message')).toHaveLength(2))
  const group=dom.container.querySelector<HTMLButtonElement>('.recent-focus__message--group')!,single=dom.container.querySelector<HTMLButtonElement>('.recent-focus__message:not(.recent-focus__message--group)')!
  expect(group.dataset.recordKind).toBe('mixed');expect(group.dataset.recordCount).toBe('2');expect(group.querySelector('.recent-focus__message-direction')!.textContent).toBe('↕');expect(group.querySelector('.recent-focus__message-avatar')).toBeNull()
  expect(single.dataset.messageRawId).toBe('old-input');expect(single.querySelector('.recent-focus__message-avatar')).not.toBeNull();expect(single.querySelector('.recent-focus__message-direction svg')).not.toBeNull()
  await act(async()=>single.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})))
  await vi.waitFor(()=>expect(document.querySelector('.recent-focus__message-preview[role=tooltip]')).not.toBeNull())
  const hover=document.querySelector('.recent-focus__message-preview[role=tooltip]')!,author=hover.querySelector('header strong')!.textContent!,caption=hover.querySelector('.recent-focus__message-caption')!.textContent!
  expect(author).not.toBe('');expect(caption).toMatch(/^→ /);expect(caption).not.toContain(author)
  await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
  const before=vi.mocked(api.sessions.historyPage).mock.calls.length
  await act(async()=>group.click())
  await vi.waitFor(()=>expect(document.querySelectorAll('[aria-label="Available conversation records"] button')).toHaveLength(2))
  expect([...document.querySelectorAll('[data-record-raw-id]')].map(e=>e.getAttribute('data-record-raw-id'))).toEqual(['input','reply']);expect(vi.mocked(api.sessions.historyPage).mock.calls).toHaveLength(before)
 })

})
