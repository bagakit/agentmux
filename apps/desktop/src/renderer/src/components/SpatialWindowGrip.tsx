import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { WorkbenchWindowChrome } from '../lib/workbench-document'

const ReturnIcon = semanticIconComponent('navigation.return')

export function WindowReturnButton({ chrome, className }: { chrome: WorkbenchWindowChrome; className?: string }) {
  return <button type="button" className={className} data-workbench-window-return="" aria-label={chrome.returnLabel}
    title={chrome.returnLabel} onClick={chrome.onReturn}><ReturnIcon size={14} /></button>
}

/** Local controls of the retained spatial workface, including while its own content is loading. */
export function SpatialWindowGrip({ chrome }: { chrome: WorkbenchWindowChrome }) {
  return <div className="spatial-window-grip" data-workbench-window-grip="" data-native-window-controls={chrome.nativeControls}>
    <WindowReturnButton chrome={chrome} className="spatial-window-return" />
  </div>
}
