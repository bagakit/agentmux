import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { ProfileNetworkDiagnostics } from '../../../src/renderer/src/components/settings/ProfileNetworkDiagnostics'
import '../../../src/renderer/src/styles/index.css'
import '../../../src/renderer/src/components/settings/settings-browser-profiles.css'
mountThemeRuntime(window, { appAppearance: 'dark' })
const bridge = (window as any).profileProbe
;(window as any).profileProbeAppearance = (appearance: 'dark' | 'light') => updateThemeSelection({ appAppearance: appearance })
bridge.initial().then(({ profile }: any) => {
  createRoot(document.getElementById('root')!).render(createElement('main', { style: { padding: 20, maxWidth: 620, margin: '0 auto' } },
    createElement('p', { style: { color: 'var(--text-3)', fontSize: 11, margin: '0 0 8px' } }, 'BROWSER PROFILE'),
    createElement('h2', { style: { margin: '0 0 22px', fontSize: 20, fontWeight: 600 } }, profile.label),
    createElement(ProfileNetworkDiagnostics, { profile, ports: bridge })))
})
