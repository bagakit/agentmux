import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { fixturePath } from '../../../../../test/fixture-values.mjs'
import { ClientUiProvider, type ClientUiPlatform } from '../../../src/platform.js'
import { InlineComposer, documentDraft } from '../../../src/components/InlineComposer.js'
import { AgentComposer } from '../../../src/components/AgentComposer.js'
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
const portrait = fixturePath('.agentmux/pasted/portrait.png'), square = fixturePath('.agentmux/pasted/square.png')
const imageFor = (width: number, height: number) => {
  const sample = document.createElement('canvas'); sample.width = width; sample.height = height
  const paint = sample.getContext('2d')!; paint.fillStyle = '#536c90'; paint.fillRect(0, 0, width, height)
  paint.fillStyle = '#dce9e1'; paint.fillRect(width / 4, height / 4, width / 2, height / 2)
  return { dataUrl: sample.toDataURL('image/png') }
}
const images = new Map([[path, image], [portrait, imageFor(24, 96)], [square, imageFor(72, 72)]])
const read = async (target: string) => images.get(target) ?? null
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
const initial = `Compare @${path} with @${path} before sending.`
const keyEvents: string[] = []
Object.assign(window, { contentActionsFixture: { initial, path, documentDraft, keyEvents } })
function Draft({ value, disabled = false, collapsed = false }: { value: string; disabled?: boolean; collapsed?: boolean }) {
  const [draft, setDraft] = useState(value)
  if (collapsed) return <><AgentComposer value={draft} onChange={setDraft} disabled={disabled} placeholder="Message" readPastedImage={read} tools={<div className="composer-tools" data-mode="collapsed" />} /><output>{draft}</output></>
  return <><div className="composer"><InlineComposer value={draft} onValueChange={setDraft} disabled={disabled} placeholder="Message" aria-label="Draft" readPastedImage={read} onKeyDown={event => { keyEvents.push(event.key) }} /></div><output>{draft}</output></>
}
function Scene() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  return <ClientUiProvider platform={platform}><main>
    <nav><strong>Draft image actions</strong><span>Remove one reference · retain the source</span><button onClick={() => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); updateThemeSelection({ appAppearance: next }) }}>Toggle theme</button></nav>
    <section id="draft"><h2>Editable draft · repeated original image</h2><Draft value={initial} /></section>
    <section id="spacing"><h2>Inline images · landscape / portrait / square</h2><Draft value={`另外 Focus 的 Hover @${path} review 并 @${portrait} 继续 @${square} 检查。`} /></section>
    <section id="compact"><h2>One-line Message Tool</h2><Draft collapsed value={`看 @${path} 图 @${portrait} 继续 @${square} 完成。`} /></section>
    <section id="failed"><h2>Unreadable image reference</h2><Draft value={`Keep the surrounding text @${missing} and continue.`} /></section>
    <section id="disabled"><h2>Read-only draft</h2><Draft value={`Retain @${path}`} disabled /></section>
    <section id="history"><h2>Historical image · preview only</h2><ConversationImage path={path} text={`@${path}`} readImage={read} /></section>
  </main></ClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Scene />)
