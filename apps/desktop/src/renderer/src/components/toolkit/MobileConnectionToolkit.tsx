import { Settings2, Smartphone, X } from 'lucide-react'
import { memo, useCallback, useContext, useState } from 'react'
import { MOBILE_CONNECTION_TOOL_ID, resolveMobileConnectionPreferences } from '../../../../shared/toolkit-preferences'
import { useAppStore } from '../../store'
import { SettingsNavigation } from '../SettingsNavigation'
import { ToolkitPopover, type ToolkitPopoverSelection } from '../performance/PerformancePopover'
import { DeviceManagementSettings } from '../settings/DeviceManagementSettings'

/** A client presentation of the original Host's device port; it owns no authorization state. */
export const MobileConnectionToolkit = memo(function MobileConnectionToolkit(selection: ToolkitPopoverSelection) {
  const enabled = useAppStore(state => resolveMobileConnectionPreferences(state.config ?? {}).enabled)
  const layout = useAppStore(state => resolveMobileConnectionPreferences(state.config ?? {}).statusBar)
  const settings = useContext(SettingsNavigation)
  const [visible, setVisible] = useState(false)
  const changed = useCallback((value: boolean) => setVisible(value), [])
  if (!enabled) return null
  const active = visible && selection.selectedToolId === MOBILE_CONNECTION_TOOL_ID
  return <ToolkitPopover {...selection} toolId={MOBILE_CONNECTION_TOOL_ID} name="手机连接" icon={<Smartphone size={14} aria-hidden="true" />} label={layout === 'label'} onVisibleChange={changed}>
    {close => <>
      <header className="performance-header"><div className="performance-title"><Smartphone size={18} /><h2>手机连接</h2><span className="performance-official">Official</span></div><button type="button" className="performance-icon-button" data-toolkit-close aria-label="关闭手机连接" onClick={close}><X size={14} /></button></header>
      <div className="performance-body mobile-connection-toolkit"><DeviceManagementSettings active={active} compact /></div>
      {settings && <footer className="performance-actions"><button type="button" onClick={() => { close(); settings.openToolkit(MOBILE_CONNECTION_TOOL_ID) }}><Settings2 size={14} />设置与设备管理</button></footer>}
    </>}
  </ToolkitPopover>
})
