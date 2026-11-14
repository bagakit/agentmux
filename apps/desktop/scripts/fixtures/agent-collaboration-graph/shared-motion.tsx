import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentMuxInteractionOperationIntent, AgentMuxInteractionOperationReceipt, AgentMuxInteractionRequest, AgentMuxInteractionResponse } from '@agentmux/core'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { Button } from '@agentmux/client-ui/components/Button'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { AgentInteractionCard } from '@agentmux/client-ui/components/AgentInteractionCard'
import { mountThemeRuntime, updateThemeSelection } from '../../../../../packages/client-ui/src/theme/runtime'
import { fixtureEpoch } from '../../../../../test/fixture-values.mjs'
import '../../../src/renderer/src/styles/tokens.css'
import '@agentmux/client-ui/styles.css'

type Mode = 'native-completed' | 'saved' | 'unknown' | 'sending' | 'failure'
const copied: string[] = [], operations: unknown[] = []
const platform: ClientUiPlatform = {
  copyText: async text => { copied.push(text); return true }, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => <span aria-hidden="true">A</span>, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null
}
mountThemeRuntime(window, { appAppearance: 'dark' })
const style = document.createElement('style')
style.textContent = `body{margin:0;background:var(--surface-0);color:var(--text);font:var(--font-size,13px) var(--font-sans);min-height:100vh}main{max-width:920px;padding:28px;margin:auto;display:grid;gap:22px}h1{font-size:20px;margin:0}h2{font-size:14px;margin:0 0 12px;color:var(--text-2)}section{padding:18px;border:1px solid var(--line);border-radius:12px;background:var(--surface-1)}.fixture-buttons{display:flex;gap:10px;flex-wrap:wrap}.fixture-label{color:var(--text-2);margin:6px 0 0}.fixture-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}button,input{font:inherit}.fixture-request{max-width:720px}.fixture-input{color:var(--text);background:var(--surface-0);border:1px solid var(--line);border-radius:6px;padding:8px}@media(max-width:640px){main{padding:14px;gap:14px}section{padding:12px}}`
document.head.append(style)
const input = JSON.stringify({ path: 'src/original.ts', reason: 'Read the exact original input before deciding.', sections: ['Discovery', 'Session identity', 'Native completion', 'Failure and retry'], constraints: { preserveOriginalRequest: true, preserveOperationId: true, noSyntheticCompletion: true } }, null, 2)
let setMode: (mode: Mode) => void, pendingReject: ((error: Error) => void) | undefined, pendingComplete: (() => void) | undefined
function request(mode: Mode): AgentMuxInteractionRequest {
  return { id: 'private-native-request-' + mode, agentSessionId: 'private-original-session', evidence: { source: 'native-hook', observedAt: fixtureEpoch(0, 0, 1), run: { runId: 'private-original-run' } },
    kind: 'permission', title: 'Allow the original write?', toolName: 'Write', toolInput: input,
    options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }, { id: 'deny', label: 'Deny', kind: 'reject-once' }] }
}
function SharedMotion() {
  const [mode, changeMode] = useState<Mode>('native-completed'), [busy, changeBusy] = useState(false)
  setMode = changeMode
  async function respond(response: AgentMuxInteractionResponse, intent: AgentMuxInteractionOperationIntent): Promise<AgentMuxInteractionOperationReceipt> {
    operations.push({ mode, response, intent })
    if (mode === 'failure') throw Error('Original operation failed; its request and retry remain available.')
    if (mode === 'sending') return new Promise((_resolve, reject) => { pendingReject = reject })
    const receipt: AgentMuxInteractionOperationReceipt = { ...intent, agentSessionId: intent.expectedRequest.agentSessionId, run: { runId: 'private-original-run' }, response,
      delivery: mode === 'saved' ? 'saved' : mode === 'unknown' ? 'unknown' : 'hook-written', nativeAdoption: 'unknown',
      ...(mode === 'native-completed' ? { nativeCompleted: { source: 'native-hook', observedAt: fixtureEpoch(0, 1, 1), run: { runId: 'private-original-run' } } } : {}) }
    if (mode === 'native-completed') return new Promise(resolve => { pendingComplete = () => resolve(receipt) })
    return receipt
  }
  return <ClientUiProvider platform={platform}><main>
    <header><h1>Shared motion consumers</h1><p className="fixture-label">Original components, original theme · private controlled requests and receipts</p></header>
    <section><h2>Native actions</h2><div className="fixture-buttons"><Button data-fixture-primary variant="primary" onClick={() => changeBusy(!busy)}>Save changes</Button><Button>Review details</Button><Button disabled>Unavailable</Button><Button data-fixture-busy aria-busy={busy} onClick={() => changeBusy(!busy)}>{busy ? 'Saving changes…' : 'Start save'}</Button></div><p className="fixture-label">Busy reflects this fixture's pending action, never Provider completion.</p></section>
    <section><h2>Original tool order and exact payload</h2><ConversationMessage messageId="private-original-message" speaker={{ role: 'agent', id: 'private-original-session' }} content={[
      { kind: 'tool-result', callId: 'result-before-unrelated-call', output: 'Original result\nRead succeeded; the next call is a separate observed part.\n', failed: false },
      { kind: 'tool-call', callId: 'private-original-call', name: 'Read', input }
    ]} /></section>
    <section className="fixture-request"><h2>Original native request · {mode}</h2><AgentInteractionCard key={mode} request={request(mode)} sourceNotice="Private native-hook evidence · original Session and Run" onRespond={respond} onInspect={async () => null} /></section>
    <section><h2>Input remains independent</h2><input className="fixture-input" aria-label="Unsent review note" placeholder="Keep this original note" defaultValue="Unsent review note" /></section>
  </main></ClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<SharedMotion />)
Object.assign(window, { sharedMotion: {
  setMode(mode: Mode) { setMode(mode) }, failPending() { pendingReject?.(Error('Original operation failed; retry the same request.')) }, completePending() { pendingComplete?.() },
  theme(appAppearance: 'dark' | 'light') { return updateThemeSelection({ appAppearance }) },
  facts() { return { copied: [...copied], operations: structuredClone(operations), active: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent, completed: document.querySelector('.agent-interaction')?.getAttribute('data-completed'), payloads: document.querySelectorAll('.conversation-tool-trace__payload').length } }
} })
