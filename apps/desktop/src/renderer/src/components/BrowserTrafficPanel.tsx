import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { BrowserRequestCapture } from './BrowserRequestCapture'
import './browser-traffic-panel.css'

const ThemeActionCloseIcon = semanticIconComponent('action.close')

export function BrowserTrafficPanel({ browserId, visible, onClose }: { browserId: string; visible: boolean; onClose(): void }) {
  return <aside className="browser-trace-rail browser-management-rail browser-traffic" aria-label="Browser traffic" inert={!visible}>
    <header><strong>Traffic</strong><IconButton type="button" aria-label="Hide traffic" title="Hide traffic" onClick={onClose}><ThemeActionCloseIcon size={14} /></IconButton></header>
    <BrowserRequestCapture browserId={browserId} visible={visible} />
  </aside>
}
