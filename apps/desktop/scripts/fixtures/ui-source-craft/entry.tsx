import '../result-ready-input-continuity/entry'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useAppStore } from '../../../src/renderer/src/store'
import { ConversationResourceFile } from '../../../../../packages/client-ui/src/components/ConversationResourceFile'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { ConversationChannelQuote } from '../../../../../packages/client-ui/src/components/ConversationChannelQuote'
import type { AgentMuxInteractionRequest, ChannelTranscriptQuote } from '@agentmux/core'
import { parseAgentMuxMessagePrefix, renderChannelTranscriptQuote } from '@agentmux/core/agent-message-render'
import { ConversationInputText } from '../../../../../packages/client-ui/src/components/ConversationInputText'

// Controlled API facts; real Workbench, SessionPane, shared resource readers and Desktop CSS.
const original = (window as any).resultReady
mountThemeRuntime(window, {themeId:'graphite',appAppearance:'dark'})
const quote: ChannelTranscriptQuote = {version:1,application:{domain:'chat.example',appId:'original-app'},externalConversationId:'original-room',observedAt:1,range:{from:{messageId:'earlier-source',inclusive:true},throughMessageId:'current-request',origin:'first-observed'},coverage:'complete',gaps:[],records:[{messageId:'earlier-source',contentType:'text',content:'Review the original source before deciding.',author:{kind:'unknown'}}]}
const gallery = document.createElement('main'); document.body.append(gallery)
const root = createRoot(gallery), reads: unknown[] = []
const record = { source: { providerId: 'codex', nativeSessionId: 'source-craft-native' }, recordId: 'original-file-record' }
const part = { kind: 'resource' as const, resourceType: 'file' as const, reference: 'original-recorded-file', label: 'Review notes.txt', mimeType: 'text/plain' }
Object.assign(window, { uiSourceCraft: {
  reads,
  pending(long: boolean, theme: string) {
    updateThemeSelection({themeId:'graphite',appAppearance:theme as 'light'|'dark'})
    gallery.style.display = 'none'; document.getElementById('root')!.style.display = 'flex'; original.seed()
    const session = useAppStore.getState().sessions.find(s => s.id === original.sessionId)!
    const evidence = { source: 'native-hook' as const, observedAt: 1, run: session.control.run, hookReceiptId: 'source-craft-receipt' }
    const request: AgentMuxInteractionRequest = long ? {id:'long-request',agentSessionId:session.id,kind:'question',evidence,questions:[{id:'original-question',title:'Choose an original workspace',prompt:'Review the available sources before choosing.',options:Array.from({length:12},(_,index)=>({id:'source-'+index,label:'Original source '+(index+1),description:'Retained project context and its original recorded input.'}))}]} : {id:'short-request',agentSessionId:session.id,kind:'permission',title:'Read the selected project file',toolName:'read_file',toolInput:'Review notes.txt',evidence,options:[{id:'allow',label:'Allow once',kind:'allow-once'},{id:'deny',label:'Deny',kind:'reject-once'}]}
    flushSync(() => useAppStore.setState(state => ({ sessions: state.sessions.map(s => s.id === session.id ? { ...s, status: { state: 'waiting' as const, source: 'native-hook' as const, observedAt: 1 }, pendingInteraction: request } : s) })))
  },
  sources(theme: string) {
    updateThemeSelection({themeId:'graphite',appAppearance:theme as 'light'|'dark'})
    document.getElementById('root')!.style.display = 'none'
    gallery.style.cssText = 'display:block;max-width:640px;width:100%;height:100%;margin:auto;padding:24px;box-sizing:border-box;overflow:auto;background:var(--surface-0);color:var(--text);font:var(--fs-body) var(--font-ui)'
    flushSync(() => root.render(<><h2>Original source records</h2><p>Files and protocol details stay with their original record.</p>
      <ConversationResourceFile part={part} partIndex={0} record={record} readResource={async request => { reads.push(request); return { ...request, reference: request.expectedReference, result: { status: 'file', dataBase64: btoa('Original notes'), byteLength: 14, mimeType: 'text/plain', label: 'Review notes.txt' } } }} />
      <ConversationInputText text={'<amux:continue />'} prefix={parseAgentMuxMessagePrefix('<amux:continue />')} />
      <ConversationInputText text={'<amux:guidance>Keep the original workspace and review the source before continuing.</amux:guidance>'} prefix={parseAgentMuxMessagePrefix('<amux:guidance>Keep the original workspace and review the source before continuing.</amux:guidance>')} />
      <ConversationChannelQuote quote={quote} raw={renderChannelTranscriptQuote(quote)} />
    </>))
  },
  facts() { return original.facts() }
} })
