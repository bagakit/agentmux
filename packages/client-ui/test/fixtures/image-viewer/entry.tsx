import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { fixturePath } from '../../../../../test/fixture-values.mjs'
import { ClientUiProvider, type ClientUiPlatform } from '../../../src/platform.js'
import { ConversationMessage } from '../../../src/components/ConversationMessage.js'
import { InlineComposer } from '../../../src/components/InlineComposer.js'
import { ConversationView } from '../../../src/components/ConversationView.js'
import { mountThemeRuntime, updateThemeSelection } from '../../../src/theme/runtime.js'
import type { AgentSessionHistoryResourceRequest, AgentSessionHistoryResourceReadResult } from '@agentmux/core'
import '../../../src/styles/index.css'
import '../../../../../apps/desktop/src/renderer/src/styles/tokens.css'
import './fixture.css'

mountThemeRuntime(window, { appAppearance: 'dark' })
const paths = ['architecture.png', 'interface.png'].map(name => fixturePath(`.agentmux/pasted/${name}`))
async function sample(title: string, accent: string) {
  const image = new Image()
  image.src = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="960" viewBox="0 0 1440 960">
    <rect width="1440" height="960" fill="#e9efeb"/><path d="M0 80H1440M0 160H1440M0 240H1440M0 320H1440M0 400H1440M0 480H1440M0 560H1440M0 640H1440M0 720H1440M0 800H1440M0 880H1440" stroke="#dce5df"/>
    <rect x="80" y="80" width="1280" height="800" rx="32" fill="#fcfdfa"/><text x="140" y="180" font-family="sans-serif" font-size="24" fill="#627568">DESIGN STUDY / SHARED WORKSPACE</text>
    <text x="140" y="255" font-family="sans-serif" font-size="54" fill="#1c3225">${title}</text>
    <path d="M420 480H1020M720 480V690" stroke="${accent}" stroke-width="5"/>
    <rect x="140" y="370" width="300" height="220" rx="20" fill="#edf2ee"/><rect x="570" y="370" width="300" height="220" rx="20" fill="${accent}"/><rect x="1000" y="370" width="300" height="220" rx="20" fill="#edf2ee"/>
    <text x="185" y="445" font-family="sans-serif" font-size="21" fill="#627568">01 / RESOURCE</text><text x="185" y="495" font-family="sans-serif" font-size="32" fill="#1c3225">Original source</text>
    <text x="615" y="445" font-family="sans-serif" font-size="21" fill="#ffffff">02 / SHARED UI</text><text x="615" y="495" font-family="sans-serif" font-size="32" fill="#ffffff">Local view</text>
    <text x="1045" y="445" font-family="sans-serif" font-size="21" fill="#627568">03 / CLIENT</text><text x="1045" y="495" font-family="sans-serif" font-size="32" fill="#1c3225">Clear feedback</text>
    <rect x="570" y="690" width="300" height="90" rx="16" fill="#edf2ee"/><text x="615" y="745" font-family="sans-serif" font-size="26" fill="#1c3225">Exact reference</text>
    <circle cx="1280" cy="180" r="20" fill="${accent}"/></svg>`)
  await image.decode()
  const canvas = document.createElement('canvas'); canvas.width = 1440; canvas.height = 960
  canvas.getContext('2d')!.drawImage(image, 0, 0)
  return { dataUrl: canvas.toDataURL('image/png') }
}
const images = await Promise.all([sample('A readable working surface', '#39745c'), sample('A second point of view', '#536c90')])
const calls: string[] = []
const readImage = async (path: string) => { calls.push(path); return images[paths.indexOf(path)] ?? null }
const nativeRead = async (input: AgentSessionHistoryResourceRequest): Promise<AgentSessionHistoryResourceReadResult> => ({
  agentSessionId: 'fixture-session', source: input.source, recordId: input.recordId, turnId: input.turnId, partIndex: input.partIndex,
  reference: input.expectedReference, result: { status: 'read', mimeType: 'image/png', dataBase64: images[0]!.dataUrl.split(',')[1]!, byteLength: atob(images[0]!.dataUrl.split(',')[1]!).length }
})
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
Object.assign(window, { imageViewerFixture: { calls, paths } })
function Scene() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [draft, setDraft] = useState(`Compare @${paths[0]} with @${paths[1]}`)
  return <ClientUiProvider platform={platform}><main>
    <nav><strong>Shared image viewing</strong><span>Isolated component scene · generated sample images</span>
      <button onClick={() => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); updateThemeSelection({ appAppearance: next }) }}>Toggle theme</button></nav>
    <section id="message"><ConversationMessage messageId="image-message" speaker={{ role: 'agent', id: 'fixture-agent' }} name="Assistant" status="complete"
      content={`Inspect the original design and compare the second view.\n\n@${paths[0]}\n\n@${paths[1]}`} readPastedImage={readImage} /></section>
    <section id="draft"><h2>Original editable draft</h2><InlineComposer value={draft} onValueChange={setDraft} disabled={false} placeholder="Message" aria-label="Image draft" readPastedImage={readImage} onKeyDown={() => {}} /></section>
    <section id="native"><ConversationView sessionId="fixture-session" readHistoryResource={nativeRead} page={{ agentSessionId: 'fixture-session', source: { providerId: 'codex', nativeSessionId: 'fixture-native' }, nextCursor: null,
      items: [{ id: 'record-original', kind: 'user-message', contentParts: [{ kind: 'resource', resourceType: 'image', reference: 'recorded-image', label: 'Recorded design' }] }] }} /></section>
  </main></ClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Scene />)
