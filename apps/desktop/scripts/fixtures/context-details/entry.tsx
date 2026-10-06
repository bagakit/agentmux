import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { fixtureEpoch } from '../../../../../test/fixture-values.mjs'
import type { AgentTurnUsage } from '@agentmux/core'
import { AgentContextUsage } from '../../../src/renderer/src/components/AgentContextUsage'
import { AgentComposer } from '@agentmux/client-ui/components/AgentComposer'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import '@agentmux/client-ui/styles.css'
import '../../../src/renderer/src/styles/tokens.css'
import './fixture.css'
mountThemeRuntime(window, { appAppearance: 'dark' })
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
// Controlled Host observations. The actual decoder/preload/Store path is exercised by headroom tests.
const reported: AgentTurnUsage = { inputTokens: 230, outputTokens: 20, totalTokens: 250, observedAt: fixtureEpoch(1), context: { usedTokens: 250, capacityTokens: 1000 } }
const compacted: AgentTurnUsage = { inputTokens: 80, outputTokens: 20, totalTokens: 100, observedAt: fixtureEpoch(1), context: { usedTokens: 100, capacityTokens: 1000 } }
const unreported: AgentTurnUsage = { inputTokens: 230, outputTokens: 20, totalTokens: 250, observedAt: fixtureEpoch(1) }
const pointers: string[] = []
const controls: Record<string, unknown> = { pointers }
Object.assign(window, { contextHoverFixture: controls })
document.addEventListener('pointerover', event => { if ((event.target as Element).closest('.composer__context')) pointers.push(event.pointerType) })
function Scene() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark'), [draft, setDraft] = useState('Keep my current draft and input focus.')
  const [sample, setSample] = useState(reported), [source, setSource] = useState('original-session/run'), [visible, setVisible] = useState(true)
  Object.assign(controls, { setVisible, compact: () => setSample(compacted), reset: () => setSample(reported), switchSource: () => setSource(value => value === 'original-session/run' ? 'another-session/run' : 'original-session/run') })
  return <ClientUiProvider platform={platform}><main>
    <nav><strong>Context details</strong><span>Provider observations · read without leaving the draft</span><button onClick={() => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); updateThemeSelection({ appAppearance: next }) }}>Toggle theme</button></nav>
    <section id="known"><h2>Current Agent · reported context window</h2><p>Hover to inspect. Click to keep the details open.</p>
      <AgentComposer value={draft} onChange={setDraft} onSubmit={() => {}} contextUsage={<AgentContextUsage visible={visible} source={source} usage={sample} />} /><output>{draft}</output>
    </section>
    <section id="unreported"><h2>Another Agent · capacity not reported</h2><p>Turn tokens are available; the context window remains unknown.</p>
      <AgentComposer value="Keep the original Session usable." onChange={() => {}} onSubmit={() => {}} contextUsage={<AgentContextUsage source="unreported-session/run" usage={unreported} />} />
    </section>
  </main></ClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Scene />)
