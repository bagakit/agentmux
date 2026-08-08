import {
  Keyboard,
  LayoutDashboard,
  PanelLeft,
  PanelsTopLeft,
  RadioTower,
  SquareTerminal
} from 'lucide-react'
import { projectWorkspaces } from '../lib/workspace-projects'
import { openShortcutHelp } from '../lib/shortcut-help-affordance'
import { isMacPlatform } from '../lib/host-platform'
import { useAppStore } from '../store'

// 顶行 chrome 的单一实现：Board/欢迎页 topbar 与 workbench 顶行（root tabbar / chromeline）
// 共用同一套组件，消除双路径漂移。组件直接从 store 读取，不做 prop drilling。

function useSurfaceIdentity() {
  const config = useAppStore((state) => state.config)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const mainSurface = useAppStore((state) => state.mainSurface)
  const workspace = config?.workspaces.find((item) => item.id === activeWorkspaceId)
  const project = projectWorkspaces(config?.workspaces ?? []).find((candidate) =>
    candidate.workspaces.some((item) => item.id === activeWorkspaceId)
  )
  return { mainSurface, workspace, project }
}

export function TopRowLeadingChrome() {
  const projectRailOpen = useAppStore((state) => state.projectRailOpen)
  const toolsOpen = useAppStore((state) => state.toolsOpen)
  const { mainSurface, workspace } = useSurfaceIdentity()
  const toolDockOwnsChrome = !projectRailOpen
    && toolsOpen
    && (mainSurface === 'board' || Boolean(workspace))
  const chromeOwnedOutsideMain = projectRailOpen || toolDockOwnsChrome
  return (
    <div
      className={`top-row-leading-chrome ${chromeOwnedOutsideMain ? '' : 'top-row-leading-chrome--compact'}`}
    >
      {chromeOwnedOutsideMain ? null : <SidebarToggleChrome />}
      <TopBreadcrumb />
    </div>
  )
}

export function SidebarToggleChrome() {
  return (
    <div className="sidebar-toggle-chrome" role="group" aria-label="Window sidebars">
      <ProjectRailToggle />
      <ToolsToggle />
      <ShortcutHelpButton />
    </div>
  )
}

// The visible door to the cheat-sheet — the fix for the bootstrap deadlock where the app's only
// shortcut-discovery surface could itself be opened only by a shortcut. It lives in the persistent
// sidebar-toggle chrome (present in the collapsed rail, the sidebar, and the tool dock) so it is
// reachable from anywhere, which is the property that matters for discoverability.
//
// It renders NO chord text — an icon-button with an accessible label needs none, which also sidesteps
// the whole class of hand-copied chord strings drifting from the registry (#367): there is no chord
// string here to drift. The tooltip is the plain label "Keyboard shortcuts", not a chord.
//
// It carries no open-state of its own and duplicates none of the routing: `openShortcutHelp` replays
// the registry's `help.shortcuts` chord into App's existing window listener, the same key the user would
// press — see shortcut-help-affordance.ts for why this reuse beats threading a prop to App's local state.
function ShortcutHelpButton() {
  return (
    <button
      className="icon-button sidebar-toggle-button"
      type="button"
      aria-label="Keyboard shortcuts"
      title="Keyboard shortcuts"
      data-shortcut-help-open
      onClick={() => openShortcutHelp(isMacPlatform())}
    >
      <Keyboard size={15} />
    </button>
  )
}

function ProjectRailToggle() {
  const projectRailOpen = useAppStore((state) => state.projectRailOpen)
  const toggleProjectRail = useAppStore((state) => state.toggleProjectRail)
  const label = `${projectRailOpen ? 'Hide' : 'Show'} projects sidebar`
  return (
    <button
      className={`icon-button sidebar-toggle-button ${projectRailOpen ? 'sidebar-toggle-button--active' : ''}`}
      aria-label={label}
      aria-expanded={projectRailOpen}
      title={label}
      data-project-rail-toggle
      onClick={toggleProjectRail}
    >
      <PanelLeft size={15} />
    </button>
  )
}

export function ToolsToggle() {
  const mainSurface = useAppStore((state) => state.mainSurface)
  const toolsOpen = useAppStore((state) => state.toolsOpen)
  const toggleTools = useAppStore((state) => state.toggleTools)
  const config = useAppStore((state) => state.config)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const toolsAvailable =
    mainSurface === 'board' || Boolean(config?.workspaces.find((item) => item.id === activeWorkspaceId))
  const scope = mainSurface === 'board' ? 'board' : 'workspace'
  return (
    <button
      className={`icon-button sidebar-toggle-button ${toolsOpen ? 'sidebar-toggle-button--active' : ''}`}
      aria-label={`${toolsOpen ? 'Hide' : 'Show'} ${scope} tools`}
      title={`${toolsOpen ? 'Hide' : 'Show'} ${scope} tools`}
      aria-pressed={toolsOpen}
      data-surface-tools-toggle
      disabled={!toolsAvailable}
      onClick={toggleTools}
    >
      <PanelsTopLeft size={15} />
    </button>
  )
}

// 身份归属（Identity Ownership）：面包屑只画「主区工作上下文」，且不与左侧
// Projects 列表重复——项目名已在 sidebar 高亮，workbench 顶行因此只画 branch
// （sidebar 不显示 branch，是唯一未重复的 within-project 上下文）。绝对路径只进
// title tooltip，永不平铺。host-pill 仅在非 local 时出现。
export function TopBreadcrumb() {
  const { mainSurface, workspace, project } = useSurfaceIdentity()
  const hostId = mainSurface === 'board' ? project?.hostId : workspace?.hostId
  if (mainSurface === 'board') {
    return (
      <div className="breadcrumbs">
        <strong>Board</strong>
        {project ? (
          <>
            <span className="breadcrumbs__sep" aria-hidden>/</span>
            <span>{project.name}</span>
          </>
        ) : null}
        {hostId && hostId !== 'local' ? (
          <span className="host-pill"><RadioTower size={11} /> {hostId}</span>
        ) : null}
      </div>
    )
  }
  // workbench 顶行不画项目名（已在左侧 Projects 列表高亮，画了就是重复）。
  // 只在有 branch（sidebar 未展示的 within-project 上下文）或非 local host 时
  // 才渲染，否则整条面包屑连同占位一起消失，Tab 直接贴着 ToolsToggle。
  const branch = workspace?.branch
  const remoteHost = hostId && hostId !== 'local' ? hostId : null
  if (!branch && !remoteHost) return null
  return (
    <div className="breadcrumbs">
      {branch ? (
        <strong title={workspace?.path ?? undefined}>{branch}</strong>
      ) : null}
      {remoteHost ? (
        <span className="host-pill"><RadioTower size={11} /> {remoteHost}</span>
      ) : null}
    </div>
  )
}

export function SurfaceSwitch() {
  const mainSurface = useAppStore((state) => state.mainSurface)
  const setMainSurface = useAppStore((state) => state.setMainSurface)
  return (
    <div className="surface-switch" role="group" aria-label="Main view">
      <button
        className={mainSurface === 'workbench' ? 'selected' : ''}
        onClick={() => setMainSurface('workbench')}
      >
        <SquareTerminal size={13} /> Workspace
      </button>
      <button
        className={mainSurface === 'board' ? 'selected' : ''}
        onClick={() => setMainSurface('board')}
      >
        <LayoutDashboard size={13} /> Board
      </button>
    </div>
  )
}
