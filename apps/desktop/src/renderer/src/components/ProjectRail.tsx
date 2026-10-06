import { useSidebarResize } from '../hooks/useSidebarResize'
import { useAppStore } from '../store'
import { PROJECT_RAIL_DEFAULT_WIDTH, PROJECT_RAIL_MIN_WIDTH, PROJECT_RAIL_MAX_WIDTH } from '../lib/project-rail-width'
import { WorkspaceSidebar } from './WorkspaceSidebar'

export function ProjectRail({ visible = true }: { visible?: boolean }) {
  const width = useAppStore((state) => state.projectRailWidth)
  const setWidth = useAppStore((state) => state.setProjectRailWidth)
  const { containerRef, isResizing, onResizeStart, onResizeReset } = useSidebarResize<HTMLDivElement>({
    isOpen: true, resizable: visible, width, setWidth, deltaSign: 1, defaultWidth: PROJECT_RAIL_DEFAULT_WIDTH,
    minWidth: PROJECT_RAIL_MIN_WIDTH, maxWidth: PROJECT_RAIL_MAX_WIDTH
  })
  return <div ref={containerRef} className={`project-rail-shell ${isResizing ? 'project-rail-shell--resizing' : ''}`}>
    <WorkspaceSidebar visible={visible} />
    <div className="project-rail-width-handle" role="separator" tabIndex={0}
      aria-label="Resize Projects" title="Drag to resize Projects · Double-click or Enter to reset" aria-orientation="vertical"
      aria-valuemin={PROJECT_RAIL_MIN_WIDTH} aria-valuemax={PROJECT_RAIL_MAX_WIDTH} aria-valuenow={width}
      onMouseDown={onResizeStart} onDoubleClick={onResizeReset}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { onResizeReset(event); return }
        const next = event.key === 'Home' ? PROJECT_RAIL_MIN_WIDTH : event.key === 'End' ? PROJECT_RAIL_MAX_WIDTH
          : event.key === 'ArrowLeft' ? width - 16 : event.key === 'ArrowRight' ? width + 16 : null
        if (next === null) return
        event.preventDefault()
        event.stopPropagation()
        setWidth(next)
      }} />
  </div>
}
