import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { fixturePath } from '../../../../../test/fixture-values.mjs'
import { ClientUiProvider, type ClientUiPlatform } from '../../../src/platform.js'
import { InlineComposer, documentDraft } from '../../../src/components/InlineComposer.js'
import { ConversationImage } from '../../../src/components/ConversationImage.js'
import { mountThemeRuntime, updateThemeSelection } from '../../../src/theme/runtime.js'
import '../../../src/styles/index.css'
import '../../../../../apps/desktop/src/renderer/src/styles/tokens.css'
import './fixture.css'
mountThemeRuntime(window, { appAppearance: 'dark' })
const path = fixturePath('.agentmux/pasted/sketch.png'), missing = fixturePath('.agentmux/pasted/missing.png')
const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 72
const context = canvas.getContext('2d')!; context.fillStyle = '#dce9e1'; context.fillRect(0, 0, 120, 72)
context.fillStyle = '#39745c'; context.fillRect(12, 12, 34, 48); context.fillStyle = '#536c90'; context.fillRect(60, 12, 48, 20); context.fillRect(60, 42, 48, 18)
const image = { dataUrl: canvas.toDataURL('image/png') }
const read = async (target: string) => target === path ? image : null
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
const initial = `Compare @${path} with @${path} before sending.`
const keyEvents: string[] = []
Object.assign(window, { contentActionsFixture: { initial, path, documentDraft, keyEvents } })
function Draft({ value, disabled = false }: { value: string; disabled?: boolean }) {
  const [draft, setDraft] = useState(value)
  return <><InlineComposer value={draft} onValueChange={setDraft} disabled={disabled} placeholder="Message" aria-label="Draft" readPastedImage={read} onKeyDown={event => { keyEvents.push(event.key) }} /><output>{draft}</output></>
}
function Scene() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  return <ClientUiProvider platform={platform}><main>
    <nav><strong>Draft image actions</strong><span>Remove one reference · retain the source</span><button onClick={() => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); updateThemeSelection({ appAppearance: next }) }}>Toggle theme</button></nav>
    <section id="draft"><h2>Editable draft · repeated original image</h2><Draft value={initial} /></section>
    <section id="failed"><h2>Unreadable image reference</h2><Draft value={`Keep the surrounding text @${missing} and continue.`} /></section>
    <section id="disabled"><h2>Read-only draft</h2><Draft value={`Retain @${path}`} disabled /></section>
    <section id="history"><h2>Historical image · preview only</h2><ConversationImage path={path} text={`@${path}`} readImage={read} /></section>
  </main></ClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Scene />)
