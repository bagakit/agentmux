import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { resolveBrowserAgentControl, type BrowserAgentControlPreferences } from '../../../../../shared/browser-agent-control'
import { BrowserAgentControlSettingsPane } from '../BrowserAgentControlSettingsPane'
import type { SettingsModule } from '../settings-catalog'
import { saveConfigSlice } from '../save-config-slice'

async function saveAgentControl(value: BrowserAgentControlPreferences, expected: BrowserAgentControlPreferences): Promise<void> {
  await saveConfigSlice((current, agentControl: BrowserAgentControlPreferences) => ({ ...current, browser: { ...current.browser, agentControl } }), value, expected)
}

export const browserAgentControlSettingsModule = {
  id: 'browser-agent-control', archetype: 'preference', group: 'browser-use', title: 'Agent takeover',
  description: 'Cursor, discussion and page-edge feedback, with a live simulation.',
  icon: semanticIconComponent('object.agent-controlled-browser'),
  keywords: 'browser agent takeover control cursor mouse avatar title discussion tween click ripple glow color blend animation width preview simulation 鼠标 接管 内发光 讨论框',
  searchTargets: [
    { id: 'showCursor', title: 'Agent cursor', keywords: 'mouse show hide 鼠标' },
    { id: 'showDiscussion', title: 'Discussion box', keywords: 'message floating 讨论框' },
    { id: 'pointerTween', title: 'Cursor movement', keywords: 'tween animation' },
    { id: 'clickRipple', title: 'Click ripple', keywords: 'click feedback 波纹' },
    { id: 'glowColor', title: 'Inner glow', keywords: 'color blend width intensity softness animation 内发光' }
  ],
  savedSummary(config) {
    const p = resolveBrowserAgentControl(config.browser.agentControl)
    return `${p.showCursor ? 'Cursor on' : 'Cursor off'} · ${p.glowEnabled ? 'Glow on' : 'Glow off'}`
  },
  Pane({ config, active }) {
    return <BrowserAgentControlSettingsPane preferences={config.browser.agentControl} active={active} onSave={saveAgentControl} />
  }
} as const satisfies SettingsModule
