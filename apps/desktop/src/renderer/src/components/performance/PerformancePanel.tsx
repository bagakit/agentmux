import { memo, useCallback, useContext, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { resolvePerformancePreferences } from '../../../../shared/toolkit-preferences'
import { api } from '../../lib/api'
import { useAppStore } from '../../store'
import { usePerformanceObservation } from '../../lib/use-performance-observation'
import { SettingsNavigation } from '../SettingsNavigation'
import { PerformancePopover } from './PerformancePopover'
import { PerformanceOverview, runKey, type RunContext } from './PerformanceOverview'
import { PerformanceScript } from './PerformanceScript'

const NO_IDENTITIES: string[] = []

/** 原结果 owner 的一个按需 Renderer 消费者；暂停与关闭不调用全局 stop。 */
export const PerformancePanel = memo(function PerformancePanel() {
  const enabled = useAppStore(state => resolvePerformancePreferences(state.config ?? {}).enabled)
  const layout = useAppStore(state => resolvePerformancePreferences(state.config ?? {}).statusBar)
  const settings = useContext(SettingsNavigation)!
  const [visible, setVisible] = useState(false)
  const [paused, setPaused] = useState(false)
  const [scriptOpen, setScriptOpen] = useState(false)
  const [visibleKeys, setVisibleKeys] = useState<readonly string[]>([])
  const wanted = useMemo(() => new Set(visibleKeys), [visibleKeys])
  const active = enabled && visible && !paused && !scriptOpen
  const observation = usePerformanceObservation(api.toolkit, active)
  const changeVisible = useCallback((next: boolean) => { setVisible(next); if (!next) { setScriptOpen(false); setVisibleKeys([]) } }, [])
  // 只投影可见行与所选 Run 的身份。其他 Session 的输出/状态不引发本组件渲染。
  const selectIdentities = useMemo(() => {
    let sessions: ReturnType<typeof useAppStore.getState>['sessions'] | undefined
    let projection = NO_IDENTITIES
    return (state: ReturnType<typeof useAppStore.getState>) => {
      if (!visible || !enabled || scriptOpen || !wanted.size) return NO_IDENTITIES
      if (state.sessions === sessions) return projection
      sessions = state.sessions
      projection = state.sessions.flatMap(session => {
        const key = runKey({ hostId: session.hostId, runId: session.control.run.runId })
        if (session.kind !== 'agent' || !wanted.has(key)) return []
        return [JSON.stringify([key, session.label, session.providerId, session.workspacePath, session.status.state])]
      })
      return projection
    }
  }, [visible, enabled, scriptOpen, wanted])
  const identities = useAppStore(useShallow(selectIdentities))
  const contexts = useMemo(() => Object.fromEntries(identities.map(identity => {
    const [key, label, provider, workspace, state] = JSON.parse(identity) as [string, string, string, string, string]
    return [key, { label, context: `${provider} · ${workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace}`, state, workspace, provider } satisfies RunContext]
  })), [identities])
  const contextKeys = useCallback((keys: readonly string[]) => setVisibleKeys(keys), [])
  if (!enabled) return null
  return <PerformancePopover label={layout === 'label'} onVisibleChange={changeVisible} focusKey={scriptOpen ? 'script' : 'overview'}>{close => scriptOpen
    ? <PerformanceScript api={api.toolkit} back={() => setScriptOpen(false)} close={close} />
    : <PerformanceOverview {...observation} contexts={contexts} close={close} paused={paused} onPause={() => setPaused(value => !value)}
      onVisibleRunKeysChange={contextKeys} onViewScript={() => setScriptOpen(true)} onConfigure={() => { close(); settings.open('toolkit') }} />}</PerformancePopover>
})
