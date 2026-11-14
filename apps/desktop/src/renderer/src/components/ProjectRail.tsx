import { useId } from 'react'
import { useSidebarResize } from '../hooks/useSidebarResize'
import { useAppStore } from '../store'
import { PROJECT_RAIL_DEFAULT_WIDTH, PROJECT_RAIL_MIN_WIDTH, PROJECT_RAIL_MAX_WIDTH } from '../lib/project-rail-width'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { SidebarResizeHandle } from './SidebarResizeHandle'

export function ProjectRail({ visible = true }: { visible?: boolean }) {
  const sidebarId = useId()
  const width = useAppStore((state) => state.projectRailWidth)
  const setWidth = useAppStore((state) => state.setProjectRailWidth)
  const { containerRef, isResizing, onResizeStart, onResizeReset } = useSidebarResize<HTMLDivElement>({
    isOpen: true, resizable: visible, width, setWidth, deltaSign: 1, defaultWidth: PROJECT_RAIL_DEFAULT_WIDTH,
    minWidth: PROJECT_RAIL_MIN_WIDTH, maxWidth: PROJECT_RAIL_MAX_WIDTH
  })
  return <div id={sidebarId} ref={containerRef} className={`project-rail-shell ${isResizing ? 'project-rail-shell--resizing' : ''}`}>
    <WorkspaceSidebar visible={visible} />
    <SidebarResizeHandle className="project-rail-width-handle" aria-controls={sidebarId}
      aria-label="Resize Projects" title="Drag to resize Projects · Double-click or Enter to reset"
      minWidth={PROJECT_RAIL_MIN_WIDTH} maxWidth={PROJECT_RAIL_MAX_WIDTH} width={width} resizing={isResizing}
      onWidthChange={setWidth} onResizeStart={onResizeStart} onResizeReset={onResizeReset} />
  </div>
}
