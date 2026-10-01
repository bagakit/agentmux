import { Activity, ArrowLeft, MoreHorizontal, X } from 'lucide-react'
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ToolkitToolDefinition } from '@agentmux/core/control'
import { resolvePerformancePreferences } from '../../../../shared/toolkit-preferences'
import { useAppStore } from '../../store'
import { PerformancePanel } from '../performance/PerformancePanel'
import { ToolkitPopover, type ToolkitPopoverSelection } from '../performance/PerformancePopover'
import { ToolkitIcon } from './ToolkitIcon'
import { UserToolkitResult } from './UserToolkitResult'

const OVERFLOW_SELECTION = Symbol('toolkit-overflow')
const NO_TOOLS: readonly ToolkitToolDefinition[] = []
const UserTool = memo(function UserTool({ definition, selection }: { definition: ToolkitToolDefinition; selection: ToolkitPopoverSelection }) {
  const [visible, setVisible] = useState(false)
  const changed = useCallback((value: boolean) => setVisible(value), [])
  return <ToolkitPopover {...selection} toolId={definition.id} name={definition.name} icon={<ToolkitIcon icon={definition.icon} size={14} aria-hidden="true" />} label={definition.statusBar === 'label'} onVisibleChange={changed}>
    {close => <UserToolkitResult definition={definition} active={visible && selection.selectedToolId === definition.id} close={close} />}
  </ToolkitPopover>
})
const Overflow = memo(function Overflow({ tools, selection }: { tools: readonly ToolkitToolDefinition[]; selection: ToolkitPopoverSelection }) {
  const chosen = tools.find(tool => tool.id === selection.selectedToolId)
  const [visible, setVisible] = useState(false)
  const changed = useCallback((value: boolean) => setVisible(value), [])
  return <ToolkitPopover {...selection} toolId={chosen?.id ?? OVERFLOW_SELECTION} name={chosen ? `More tools · ${chosen.name}` : 'More tools'} icon={<MoreHorizontal size={14} aria-hidden="true" />} onVisibleChange={changed} focusKey={chosen?.id ?? 'library'}>
    {close => chosen ? <><button type="button" className="small-button toolkit-overflow__back" onClick={() => selection.onSelectTool(OVERFLOW_SELECTION)}><ArrowLeft size={13} /> Back to tools</button><UserToolkitResult key={chosen.id} definition={chosen} active={visible} close={close} /></> : <>
      <header className="performance-header"><div className="performance-title"><h2>More tools</h2></div><button type="button" className="performance-icon-button" data-toolkit-close aria-label="Close tool list" onClick={close}><X size={14} /></button></header>
      <div className="performance-body toolkit-overflow__list">{tools.map(tool => <button type="button" className="toolkit-overflow__item" key={tool.id} onClick={() => selection.onSelectTool(tool.id)}><ToolkitIcon icon={tool.icon} size={16} /><span>{tool.name}</span></button>)}</div>
    </>}
  </ToolkitPopover>
})

/** One window-local selection coordinates existing popovers. Configuration is not a live result registry. */
export const ToolkitStatusBar = memo(function ToolkitStatusBar() {
  const preferences = useAppStore(state => state.config?.toolkit)
  const tools = preferences?.tools ?? NO_TOOLS
  const enabled = useMemo(() => tools.filter(tool => tool.enabled), [tools])
  const performance = resolvePerformancePreferences(preferences ? { toolkit: preferences } : {})
  const [selectedToolId, setSelectedToolId] = useState<string | symbol | null>(null)
  const select = useCallback((next: string | symbol | null, closing?: string | symbol) => setSelectedToolId(current => closing && current !== closing ? current : next), [])
  const selection = useMemo(() => ({ selectedToolId, onSelectTool: select }), [selectedToolId, select])
  const host = useRef<HTMLDivElement>(null)
  const measure = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(0)
  const overflow = useMemo(() => enabled.slice(visibleCount), [enabled, visibleCount])
  useLayoutEffect(() => {
    const node = host.current, metrics = measure.current
    const footer = node?.closest<HTMLElement>('.window-status-bar')
    if (!node || !metrics || !footer) return
    const update = () => {
      let available = footer.clientWidth
      let child: HTMLElement = node
      while (child.parentElement) {
        const parent = child.parentElement, style = getComputedStyle(parent)
        const siblings = Array.from(parent.children).filter((item): item is HTMLElement => item instanceof HTMLElement && item !== child && getComputedStyle(item).position !== 'absolute' && getComputedStyle(item).position !== 'fixed' && item.getBoundingClientRect().width > 0)
        for (const item of siblings) { available -= item.getBoundingClientRect().width }
        available -= parseFloat(style.paddingLeft || '0') + parseFloat(style.paddingRight || '0')
        available -= (parseFloat(style.columnGap) || 0) * siblings.length
        if (parent === footer) break
        child = parent
      }
      const widths = Array.from(metrics.querySelectorAll<HTMLElement>('[data-measure-tool]')).map(item => item.getBoundingClientRect().width)
      const perfWidth = performance.enabled ? widths.shift() ?? 22 : 0
      const all = perfWidth + widths.reduce((sum, width) => sum + width + 2, 0)
      if (all <= available) { setVisibleCount(enabled.length); return }
      let used = perfWidth + 24, count = 0
      for (const width of widths) { if (used + width + 2 > available) break; used += width + 2; ++count }
      setVisibleCount(count)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(footer)
    const left = footer.querySelector('.window-status-bar__surface-switch')
    const notices = footer.querySelector('.global-system-notices__trigger')
    if (left) observer.observe(left)
    if (notices) observer.observe(notices)
    return () => observer.disconnect()
  }, [enabled, performance.enabled, performance.statusBar])
  return <div ref={host} className="toolkit-statusbar">
    <PerformancePanel {...selection} />
    {enabled.slice(0,visibleCount).map(tool => <UserTool key={tool.id} definition={tool} selection={selection} />)}
    {visibleCount < enabled.length ? <Overflow tools={overflow} selection={selection} /> : null}
    <div ref={measure} className="toolkit-statusbar__measure" aria-hidden="true" inert>
      {performance.enabled ? <span className="performance-trigger" data-measure-tool><Activity size={14} />{performance.statusBar === 'label' ? <span>Performance</span> : null}</span> : null}
      {enabled.map(tool => <span className="performance-trigger" data-measure-tool key={tool.id}><ToolkitIcon icon={tool.icon} size={14} />{tool.statusBar === 'label' ? <span>{tool.name}</span> : null}</span>)}
    </div>
  </div>
})
