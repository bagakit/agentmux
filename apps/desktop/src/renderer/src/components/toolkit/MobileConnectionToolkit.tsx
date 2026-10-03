import { Smartphone } from 'lucide-react'
import { memo, useCallback, useEffect, useState } from 'react'
import type { ToolkitToolDefinition } from '@agentmux/core/control'
import { MOBILE_CONNECTION_TOOL_ID, resolveMobileConnectionPreferences } from '../../../../shared/toolkit-preferences'
import { useAppStore } from '../../store'
import { api } from '../../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { ToolkitPopover, type ToolkitPopoverSelection } from '../performance/PerformancePopover'
import { UserToolkitResult } from './UserToolkitResult'

/** Only an entry: official scripts, actions and receipts use the public Toolkit owner. */
export const MobileConnectionToolkit = memo(function MobileConnectionToolkit(selection: ToolkitPopoverSelection) {
  const enabled = useAppStore(state => resolveMobileConnectionPreferences(state.config ?? {}).enabled)
  const layout = useAppStore(state => resolveMobileConnectionPreferences(state.config ?? {}).statusBar)
  const [visible, setVisible] = useState(false)
  const [definition, setDefinition] = useState<ToolkitToolDefinition | null>(null)
  const [error, setError] = useState('')
  const changed = useCallback((value: boolean) => setVisible(value), [])
  const active = visible && selection.selectedToolId === MOBILE_CONNECTION_TOOL_ID
  useEffect(() => {
    if (!active) return
    let disposed = false
    void api.toolkit.get(MOBILE_CONNECTION_TOOL_ID).then(value => {
      if (disposed) return
      if (value.kind !== 'script') throw new Error('Official tool definition is unavailable.')
      setDefinition(value.definition); setError('')
    }).catch(cause => { if (!disposed) setError(presentError(cause)) })
    return () => { disposed = true }
  }, [active, enabled, layout])
  if (!enabled) return null
  return <ToolkitPopover {...selection} toolId={MOBILE_CONNECTION_TOOL_ID} name="手机连接" icon={<Smartphone size={14} aria-hidden="true" />} label={layout === 'label'} onVisibleChange={changed}>
    {close => definition ? <UserToolkitResult definition={definition} active={active} close={close} official runLabel="生成并复制连接链接" copyOnRun primaryActionId="link" entryLabel="查询设备状态" /> : <div className="performance-body"><p role="status">{error || '正在读取官方工具…'}</p><button className="small-button" onClick={close}>关闭</button></div>}
  </ToolkitPopover>
})
