import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { fixturePath } from '../../../../../test/fixture-values.mjs'
import { ClientUiProvider, type ClientUiPlatform } from '../../../src/platform.js'
import { ConversationMessage } from '../../../src/components/ConversationMessage.js'
import { ConversationReasoningTrace } from '../../../src/components/ConversationReasoningTrace.js'
import { InlineComposer } from '../../../src/components/InlineComposer.js'
import { mountThemeRuntime, updateThemeSelection } from '../../../src/theme/runtime.js'
import '../../../src/styles/index.css'
import '../../../../../apps/desktop/src/renderer/src/styles/tokens.css'
import './fixture.css'
mountThemeRuntime(window, { appAppearance: 'dark' })
const reasoning = '\n  Compare **both implementations** before changing the boundary.\nKeep the original source and its receipt.\n'
const input = '\n  {"pattern":"content-copy","include":"components/**/*.tsx"}\n'
const output = '\tThe source could not be read.\nRetry the same operation.\n'
const code = '  const copy = await platform.copyText(source);\n'
const attempts: { text: string; reportError(error: unknown): void; resolve(value: boolean): void }[] = []
const platform: ClientUiPlatform = { copyText: (text, reportError) => new Promise<boolean>(resolve => attempts.push({ text, reportError, resolve })),
  overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => null,
  renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
const path = fixturePath('.agentmux/pasted/sketch.png')
const canvas = document.createElement('canvas'); canvas.width = 90; canvas.height = 45
const context = canvas.getContext('2d')!; context.fillStyle = '#90b7a4'; context.fillRect(0, 0, 90, 45)
const image = { dataUrl: canvas.toDataURL('image/png') }, read = async () => image
const parts = [{ kind: 'reasoning', text: reasoning }, { kind: 'tool-call', name: 'search', callId: 'call-original-source-with-a-long-recorded-identifier-that-must-wrap-within-the-detail-pane', input },
  { kind: 'tool-result', callId: 'unpaired-original-result', output, failed: true }, { kind: 'text', text: `\`\`\`ts\n${code}\n\`\`\`` }] as const
Object.assign(window, { contentActionsFixture: { attempts, reasoning, input, output, code, path } })
function Scene() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark'), [draft, setDraft] = useState(`Keep @${path} and continue.`)
  const [source, setSource] = useState('original-record')
  return <ClientUiProvider platform={platform}><main>
    <nav><strong>Conversation detail actions</strong><span>Copy the original payload</span><button onClick={() => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); updateThemeSelection({ appAppearance: next }) }}>Toggle theme</button></nav>
    <section id="conversation"><ConversationMessage messageId={source} speaker={{ role: 'agent', id: 'assistant' }} name="Assistant" content={parts} status="complete" /></section>
    <section id="protected"><ConversationReasoningTrace part={{ kind: 'reasoning', text: 'protected', redacted: true }} expanded /><ConversationReasoningTrace part={{ kind: 'reasoning', text: '' }} expanded /></section>
    <section id="draft"><h2>Draft reference · reversible removal</h2><InlineComposer value={draft} onValueChange={setDraft} onKeyDown={() => {}} aria-label="Draft" readPastedImage={read} /><output>{draft}</output></section>
    <button id="source-change" onClick={() => setSource(value => value === 'original-record' ? 'another-record' : 'original-record')}>Switch recorded source</button>
  </main></ClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Scene />)
