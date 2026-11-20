import { createRoot } from 'react-dom/client'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { BrowserTrafficPanel } from '../../../src/renderer/src/components/BrowserTrafficPanel'
import '../../../src/renderer/src/styles/index.css'

mountThemeRuntime(window, { appAppearance: 'dark' })
createRoot(document.getElementById('root')!).render(
  <main className="browser-surface" style={{ height: '100vh' }}>
    <div className="browser-body">
      <div className="browser-stage" style={{ flex: '1 1 auto' }} />
      <BrowserTrafficPanel browserId="traffic-main-page" visible={true} onClose={() => {}} />
      <BrowserTrafficPanel browserId="traffic-excluded-page" visible={true} onClose={() => {}} />
    </div>
  </main>
)
