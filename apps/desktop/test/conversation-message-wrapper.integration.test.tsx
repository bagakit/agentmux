// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseAgentMuxMessagePrefix, renderAgentMuxMessageEnvelope } from '@agentmux/core/agent-message-render'
import type { AgentMuxMessageEnvelope, AgentSessionHistoryPage } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { ConversationMessage } from '../src/renderer/src/components/ConversationMessage'
import { SessionHistoryView } from '../src/renderer/src/components/SessionHistoryView'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { api } from '../src/renderer/src/lib/api'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}})
vi.stubGlobal('IntersectionObserver',class {observe(){} disconnect(){}})
let host:HTMLDivElement, root:Root
beforeEach(()=>{host=document.createElement('div');document.body.append(host);root=createRoot(host)})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();window.getSelection()?.removeAllRanges();vi.restoreAllMocks()})
const packet='<bagakit-msg type="agent-v1" name="Review team" time="2026-10-04T00:00:00+08:00">\n**Original quote** &amp; context\n<cite from="User" ref="message-7">Keep both original IDs.</cite>\nContinue here.\n</bagakit-msg>'
const wire='[Message from Agent reviewer]\n'+packet
const page:AgentSessionHistoryPage={agentSessionId:'reader',source:{providerId:'claude',nativeSessionId:'native'},items:[
 {id:'input-one',kind:'user-message',contentParts:[{kind:'text',text:wire}]},
 {id:'input-two',kind:'user-message',contentParts:[{kind:'text',text:wire}]}
],nextCursor:null}
it('interprets a complete packet once, preserving declarations and mixed citation order',()=>{
 const parsed=parseAgentMuxMessagePrefix(wire)!;expect(parsed).not.toBeNull()
 expect(parsed.sourceLabel).toBe('Agent reviewer');expect(parsed.declaredAgentSessionId).toBe('reviewer')
 expect(parsed.packet).toEqual({profile:'agent-v1',name:'Review team',time:'2026-10-04T00:00:00+08:00',parts:[
 {kind:'text',text:'\n**Original quote** & context\n'},{kind:'citation',from:'User',reference:'message-7',text:'Keep both original IDs.'},{kind:'text',text:'\nContinue here.\n'}]})
 expect(parseAgentMuxMessagePrefix(packet)?.declaredAgentSessionId).toBeNull()
})
it('leaves malformed, unknown, incomplete and quoted packets entirely readable',()=>{
 const rejected=[packet.replace('</bagakit-msg>',''),packet.replace('name="Review team"',''),packet.replace('type="agent-v1"','type="agent-v1" permission="allow"'),packet.replace('<cite from="User" ref="message-7">','<unknown>'),packet.replace('Keep both original IDs.','<cite from="Other">nested</cite>'),packet.replace('00:00:00+08:00','00:00:00'),packet.replace('2026-10-04','2026-02-30'),packet+'\n'+packet,'> '+packet,'```xml\n'+packet+'\n```',packet.replace('Original quote','<![CDATA[Original quote]]>'),packet.replace('Original quote','<!--Original quote-->'),'<!DOCTYPE bagakit-msg [<!ENTITY xx "text">]>\n'+packet,packet.replace('Original quote','<?test?>')]
 expect(rejected).toHaveLength(14)
 for(const text of rejected)expect(parseAgentMuxMessagePrefix(text)).toBeNull()
 expect(parseAgentMuxMessagePrefix('[Message from Agent reviewer]\n'+rejected[0])).toBeNull()
})
it('uses declarations for reading without replacing trusted sender identity or recorded time',async()=>{
 await act(async()=>root.render(<ConversationMessage messageId="trusted" speaker={{role:'agent',id:'reviewer'}} conversationSessionId="reader" name="Verified review Agent" content={wire} createdAt={1000} timeFormatter={t=>`Recorded ${t}`} />))
 const turn=host.querySelector<HTMLElement>('.log-turn')!;expect(turn.dataset.speakerRole).toBe('agent')
 expect(turn.querySelector('.log-turn__who')?.textContent).toBe('Verified review Agent')
 expect(turn.querySelector('.log-turn__time')?.textContent).toBe('Recorded 1000')
 expect(turn.querySelector('.log-turn__packet-declaration')?.textContent).toBe('From Review team')
 expect(turn.querySelector('.log-turn__text')?.textContent).not.toContain('bagakit-msg')
 expect([...turn.querySelectorAll('.log-turn__text > *')].map(e=>e.textContent)).toEqual(['Original quote & context','Usermessage-7Keep both original IDs.','\nContinue here.\n'])
 expect(turn.querySelector('.log-turn__citation-from')?.textContent).toBe('User')
 expect(turn.querySelector('.log-turn__citation-ref')?.textContent).toBe('message-7')
})
it('native input and captured Core rendering use the same product parser without body dedup',async()=>{
 const envelope:AgentMuxMessageEnvelope={schema:'agentmux.a2a.v1',messageId:'original',operationId:'private-operation',createdAt:1000,
  sender:{kind:'agent-session',agentSessionId:'reviewer'},recipient:{kind:'agent-session',agentSessionId:'reader'},
  threadId:'thread',correlationId:'correlation',replyTo:null,workspaceId:null,senderSessionId:'reviewer',senderRunId:null,
  recipientSessionId:'reader',recipientRunId:null,body:packet}
 const captured=renderAgentMuxMessageEnvelope(envelope);expect(captured).toBe(wire)
 const messages=projectSessionUserMessages({agentSessionId:'reader',historyPage:page})
 expect(messages.map(m=>[m.rawId,m.author.kind])).toEqual([['input-one','unknown'],['input-two','unknown']])
 await act(async()=>root.render(<ActivityView sessionId="reader" capability="complete-events" displayState="done" items={[]} userMessages={messages} nativeHistoryPage={page} />))
 expect(host.querySelectorAll('.log-turn')).toHaveLength(2)
 expect([...host.querySelectorAll('.log-turn__text')].map(e=>e.textContent)).toEqual(Array(2).fill('Original quote & contextUsermessage-7Keep both original IDs.\nContinue here.\n'))
 expect([...host.querySelectorAll<HTMLElement>('.log-turn')].map(e=>e.dataset.speakerRole)).toEqual(['human','human'])
})
it('reads the same escaped packet from the built-in Claude reader through public Core and private FileStore',async()=>{
 const fixture=await nativeHistoryFixture('claude',jsonl(['actual-one','actual-two'].map(uuid=>({sessionId:'native-main',uuid,type:'user',
  message:{role:'user',content:wire},timestamp:'2026-10-04T00:00:00.000Z'}))))
 try {
  const nativePage=await fixture.client.sessionHistoryPage(fixture.session.agentSessionId,{limit:30})
  expect(nativePage.items.map(item=>[item.id,item.kind])).toEqual([['actual-one','user-message'],['actual-two','user-message']])
  const messages=projectSessionUserMessages({agentSessionId:fixture.session.agentSessionId,historyPage:nativePage})
  expect(messages.map(message=>[message.rawId,message.author.kind])).toEqual([['actual-one','unknown'],['actual-two','unknown']])
  await act(async()=>root.render(<ActivityView sessionId={fixture.session.agentSessionId} capability="complete-events" displayState="done"
   items={[]} userMessages={messages} nativeHistoryPage={nativePage} />))
  expect([...host.querySelectorAll('[data-native-record-id]')].map(el=>el.getAttribute('data-native-record-id'))).toEqual(['actual-one','actual-two'])
  expect([...host.querySelectorAll('.log-turn__citation-from')].map(el=>el.textContent)).toEqual(['User','User'])
  expect(fixture.controls.map(control=>control.mock.calls.length)).toEqual([0,0,0,0,0,0])
  expect(await fixture.bytes()).toEqual(fixture.before)
 } finally {await fixture.close()}
})
it('actual History shares this packet reading and keeps the exact native record IDs',async()=>{
 vi.spyOn(api.sessions,'historyPage').mockResolvedValue(page)
 await act(async()=>root.render(<SessionHistoryView control={{kind:'agent',hostId:'local',agentSessionId:'reader',run:{runId:'original-run'}}} visible label="Reader" themeId="graphite" fontSize={12} workspaceRoot="/private" openWorkspaceFile={vi.fn()} openHttpLink={vi.fn()} />))
 expect([...host.querySelectorAll<HTMLElement>('[data-history-item-id]')].map(e=>e.dataset.historyItemId)).toEqual(['input-one','input-two'])
 expect(host.querySelectorAll('.log-turn__citation')).toHaveLength(2)
 expect(host.querySelector('.log-turn__text')?.textContent).not.toContain('bagakit-msg')
})
it('keeps full authored Copy and body Range across a normal status update',async()=>{
 const clipboard=vi.spyOn(api.ui,'writeClipboardText').mockResolvedValue(undefined),annotation=vi.fn()
 const draw=(status:'complete'|'failed')=><ConversationMessage messageId="retained" conversationSessionId="reader" speaker={{role:'unknown',id:'unknown'}} content={[{kind:'text',text:wire},{kind:'resource',resourceType:'file',reference:'original.txt'}]} status={status} onSelectAnnotation={annotation} />
 await act(async()=>root.render(draw('complete')))
 const selected=host.querySelector('.log-turn__text strong')!,range=document.createRange();range.selectNodeContents(selected);window.getSelection()!.addRange(range)
 await act(async()=>selected.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})))
 expect(annotation).toHaveBeenCalledOnce();expect(annotation.mock.calls[0]![0].quote).toBe('Original quote')
 await act(async()=>root.render(draw('failed')))
 expect(host.querySelector('.log-turn__text strong')).toBe(selected);expect(window.getSelection()!.toString()).toBe('Original quote')
 await act(async()=>host.querySelector<HTMLButtonElement>('[title="Copy message"]')!.click())
 expect(clipboard).toHaveBeenCalledExactlyOnceWith(wire+'\noriginal.txt')
})
it('does not turn current Agent, System or code samples into incoming packet cards',async()=>{
 await act(async()=>root.render(<>
 <ConversationMessage messageId="answer" speaker={{role:'agent',id:'reader'}} conversationSessionId="reader" content={wire}/>
 <ConversationMessage messageId="system" speaker={{role:'system',id:'agentmux'}} conversationSessionId="reader" content={wire}/>
 <ConversationMessage messageId="code" speaker={{role:'human',id:'human'}} content={'```xml\n'+packet+'\n```'} />
 </>))
 expect(host.querySelectorAll('.log-turn')).toHaveLength(3)
 expect(host.querySelectorAll('.log-turn__packet-declaration')).toHaveLength(0)
 expect(host.querySelector('[data-message-id="answer"]')?.getAttribute('data-declared-source')).toBeNull()
 expect(host.querySelector('[data-message-id="code"] code')?.textContent).toContain('bagakit-msg')
})
