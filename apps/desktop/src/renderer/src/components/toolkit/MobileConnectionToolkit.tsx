import { Smartphone } from 'lucide-react'
import { memo, useCallback, useState } from 'react'
import { MOBILE_CONNECTION_TOOL_ID, resolveMobileConnectionPreferences } from '../../../../shared/toolkit-preferences'
import { useAppStore } from '../../store'
import { ToolkitPopover, type ToolkitPopoverSelection } from '../performance/PerformancePopover'
import { MobileConnectionResult } from './MobileConnectionResult'

/** Only an entry: official scripts, actions and receipts use the public Toolkit owner. */
export const MobileConnectionToolkit = memo(function MobileConnectionToolkit(selection: ToolkitPopoverSelection) {
  const enabled = useAppStore(state => resolveMobileConnectionPreferences(state.config ?? {}).enabled)
  const layout = useAppStore(state => resolveMobileConnectionPreferences(state.config ?? {}).statusBar)
  const [visible, setVisible] = useState(false)
  const changed = useCallback((value: boolean) => setVisible(value), [])
  if (!enabled) return null
  return <ToolkitPopover {...selection} toolId={MOBILE_CONNECTION_TOOL_ID} name="Phone connection" icon={<Smartphone size={14} aria-hidden="true" />} label={layout === 'label'} onVisibleChange={changed}>
    {close => <MobileConnectionResult active={visible && selection.selectedToolId === MOBILE_CONNECTION_TOOL_ID} close={close} />}
  </ToolkitPopover>
})
