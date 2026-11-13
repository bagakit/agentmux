import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { SessionTakeoverSurface } from '../../../src/renderer/src/components/SessionTakeoverSurface'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'

// Real Settings and takeover components in a private document. Config is local preview data;
// durable saves, the resource owner and agent open --derive are proved by the owning tests.
const config = await api.config.get()
const actions = [
  { id: 'review-this-work', label: 'Review this work', base: 'new-agent' as const, instruction: 'Review the original Agent’s changes. Find concrete bugs and regressions, cite files and explain why each matters. Do not edit files.', executorId: Object.keys(config.executors)[1] ?? Object.keys(config.executors)[0] },
  { id: 'try-another-approach', label: 'Try another approach', base: 'fork' as const, instruction: 'Set the current approach aside. Propose a different way to reach the same goal, then try it and compare the results.' }
]
useAppStore.setState({ config: { ...config, agentDerivedActions: { actions, hidden: ['pass-on-experience'] } }, loading: false })
mountThemeRuntime(window, { ...config.appearance, appAppearance: 'dark' })
api.config.save = async next => { useAppStore.setState({ config: next }) }
const params = new URLSearchParams(location.search)
const root = createRoot(document.getElementById('root')!)
if (params.get('scene') === 'surface') {
  const executorId = actions[0]!.executorId!
  flushSync(() => root.render(<DesktopClientUiProvider><div className="agent-surface" style={{ position: 'relative', flex: 1 }}>
    <SessionTakeoverSurface active onClose={() => {}} source={{ agentSessionId: 'preview-session', hostId: 'local', cwd: '/preview/repo', label: 'Mote dialogue and Threads', executorId,
      diagnostic: 'Preview', origin: { workspaceId: 'preview', tabGroupId: 'preview', tabId: 'preview', regionId: 'preview' },
      derived: { id: actions[0]!.id, label: actions[0]!.label, instruction: actions[0]!.instruction } }} />
  </div></DesktopClientUiProvider>))
} else flushSync(() => root.render(<DesktopClientUiProvider><SettingsPanel initialSection="derived-actions" onClose={() => {}} /></DesktopClientUiProvider>))
Object.assign(window, { derivedVisual: { appearance: (mode: 'dark' | 'light') => updateThemeSelection({ ...config.appearance, appAppearance: mode }) } })
