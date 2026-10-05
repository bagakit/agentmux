import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { memo, useCallback, useContext, useState } from 'react'
import { resolvePerformancePreferences } from '../../../../shared/toolkit-preferences'
import { api } from '../../lib/api'
import { useAppStore } from '../../store'
import { usePerformanceObservation } from '../../lib/use-performance-observation'
import { SettingsNavigation } from '../SettingsNavigation'
import { ToolkitPopover, type ToolkitPopoverSelection } from './PerformancePopover'
import { PerformanceOverview } from './PerformanceOverview'
import { PerformanceScript } from './PerformanceScript'

const ThemeObjectPerformanceIcon = semanticIconComponent('object.performance')


/** 原结果 owner 的一个按需 Renderer 消费者；暂停与关闭不调用全局 stop。 */
export const PerformancePanel = memo(function PerformancePanel(selection: ToolkitPopoverSelection) {
  const enabled = useAppStore(state => resolvePerformancePreferences(state.config ?? {}).enabled)
  const layout = useAppStore(state => resolvePerformancePreferences(state.config ?? {}).statusBar)
  const settings = useContext(SettingsNavigation)!
  const [visible, setVisible] = useState(false)
  const [paused, setPaused] = useState(false)
  const [scriptOpen, setScriptOpen] = useState(false)
  const active = enabled && visible && selection.selectedToolId === 'performance' && !paused && !scriptOpen
  const observation = usePerformanceObservation(api.toolkit, active)
  const changeVisible = useCallback((next: boolean) => { setVisible(next); if (!next) setScriptOpen(false) }, [])
  if (!enabled) return null
  return <ToolkitPopover {...selection} toolId="performance" name="Performance" icon={<ThemeObjectPerformanceIcon size={14} aria-hidden="true" />} label={layout === 'label'} onVisibleChange={changeVisible} focusKey={scriptOpen ? 'script' : 'overview'}>{close => scriptOpen
    ? <PerformanceScript api={api.toolkit} back={() => setScriptOpen(false)} close={close} />
    : <PerformanceOverview {...observation} close={close} paused={paused} onPause={() => setPaused(value => !value)}
      onViewScript={() => setScriptOpen(true)} onConfigure={() => { close(); settings.open('toolkit') }} />}</ToolkitPopover>
})
