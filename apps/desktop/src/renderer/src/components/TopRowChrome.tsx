import { useEffect, useState } from 'react'
import { PanelLeft, PanelsTopLeft, RadioTower, Settings2 } from 'lucide-react'
import { useAppStore } from '../store'
import { FocusNavigationButton } from './FocusNavigationButton'
import { FocusNavigationPreview } from './FocusNavigationPreview'
import { SURFACE_NAVIGATION_PLUGINS } from './SurfaceNavigation'
import { WindowOverlayPortal } from './WindowOverlayHost'
import type { SettingsSectionId } from './SettingsPanel'

// 顶行 chrome 的单一实现：Board/欢迎页 topbar 与 workbench 顶行（root tabbar / chromeline）
// 共用同一套组件，消除双路径漂移。组件直接从 store 读取，不做 prop drilling。

function useSurfaceIdentity() {
  const config = useAppStore((state) => state.config)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const mainSurface = useAppStore((state) => state.mainSurface)
  const workspace = config?.workspaces.find((item) => item.id === activeWorkspaceId)
  return { mainSurface, workspace }
}

export function TopRowLeadingChrome() {
  const projectRailOpen = useAppStore((state) => state.projectRailOpen)
  const toolsOpen = useAppStore((state) => state.toolsOpen)
  const { mainSurface, workspace } = useSurfaceIdentity()
  const toolDockOwnsChrome = !projectRailOpen
    && toolsOpen
    && mainSurface === 'workbench' && Boolean(workspace)
  const chromeOwnedOutsideMain = projectRailOpen || toolDockOwnsChrome
  const globalSurfaceNeedsTrafficLightInset = (mainSurface === 'agents' || mainSurface === 'board' || mainSurface === 'survey') && chromeOwnedOutsideMain
  return (
    <div
      className={`top-row-leading-chrome ${chromeOwnedOutsideMain ? '' : 'top-row-leading-chrome--compact'}${globalSurfaceNeedsTrafficLightInset ? ' top-row-leading-chrome--global-inset' : ''}`}
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
    </div>
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
  if (mainSurface === 'board') return null
  const toolsAvailable = mainSurface === 'workbench' && Boolean(config?.workspaces.find((item) => item.id === activeWorkspaceId))
  const scope = mainSurface === 'agents' ? 'Focus' : 'Space'
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
  const { mainSurface, workspace } = useSurfaceIdentity()
  const hostId = workspace?.hostId
  if (mainSurface === 'agents') {
    return <div className="breadcrumbs"><strong>Focus</strong><span className="breadcrumbs__sep" aria-hidden>/</span><span>Recent execution contexts</span></div>
  }
  if (mainSurface === 'survey') {
    return <div className="breadcrumbs"><strong>Survey</strong><span className="breadcrumbs__sep" aria-hidden>/</span><span>Browse and verify</span></div>
  }
  if (mainSurface === 'board') {
    return <div className="breadcrumbs"><strong>Goals</strong></div>
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

export function SurfaceSwitch({ onOpenSettings, settingsOpen = false, onCloseSettings }: {
  onOpenSettings: (section: SettingsSectionId) => void
  settingsOpen?: boolean
  onCloseSettings?: () => void
}) {
  const mainSurface = useAppStore((state) => state.mainSurface)
  const setMainSurface = useAppStore((state) => state.setMainSurface)
  const [tooltip, setTooltip] = useState<{ id: string; left: number; top: number } | null>(null)
  // Window-level host [data-overlay-host] adapter (WindowOverlayPortal wraps createPortal into host):
  const showTooltip = (id: string, target: HTMLElement) => {
    const rect = target.getBoundingClientRect()
    setTooltip({ id, left: rect.left, top: rect.top - 8 })
  }
  const hideTooltip = (id: string) => {
    setTooltip((current) => current?.id === id ? null : current)
  }
  useEffect(() => {
    if (!tooltip) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTooltip(null)
    }
    const onBlur = () => setTooltip(null)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [tooltip])
  const activePlugin = tooltip
    ? SURFACE_NAVIGATION_PLUGINS.find((plugin) => plugin.id === tooltip.id)
    : null
  const renderTooltip = (plugin: typeof SURFACE_NAVIGATION_PLUGINS[number]) => (
    <div
      id={`surface-navigation-tooltip-${plugin.id}`}
      className="surface-navigation__tooltip"
      role="tooltip"
      data-state="open"
      data-overlay-layer="tooltip"
      data-focus-tooltip={plugin.id === 'focus' ? 'true' : undefined}
      style={{ left: `${tooltip?.left ?? 0}px`, top: `${tooltip?.top ?? 0}px` }}
      ref={(element) => {
        if (!element || !tooltip) return
        const width = element.getBoundingClientRect().width
        element.style.left = `${Math.max(8, Math.min(tooltip.left, window.innerWidth - width - 8))}px`
      }}
    >
      {plugin.id === 'focus' ? <FocusNavigationPreview /> : <><strong>{plugin.label}</strong><small>{plugin.tooltip}</small></>}
    </div>
  )
  const renderPlugin = (plugin: typeof SURFACE_NAVIGATION_PLUGINS[number]) => {
    if (plugin.kind === 'launcher') {
      return (
        <div
          key={plugin.id}
          className="surface-navigation__slot surface-navigation__slot--launcher"
          onMouseEnter={(event) => showTooltip(plugin.id, event.currentTarget)}
          onMouseLeave={() => hideTooltip(plugin.id)}
          onFocusCapture={(event) => showTooltip(plugin.id, event.currentTarget)}
          onBlurCapture={() => hideTooltip(plugin.id)}
        >
          {plugin.render()}
        </div>
      )
    }
    const Icon = plugin.icon
    const selected = mainSurface === plugin.surface
    const NavigationButton = plugin.id === 'focus' ? FocusNavigationButton : 'button'
    return (
      <NavigationButton
        key={plugin.id}
        type="button"
        className={`surface-navigation__slot surface-navigation__slot--surface${selected ? ' selected' : ''}`}
        aria-label={plugin.ariaLabel}
        aria-current={selected ? 'page' : undefined}
        aria-describedby={tooltip?.id === plugin.id ? `surface-navigation-tooltip-${plugin.id}` : undefined}
        title={plugin.title}
        onMouseEnter={(event) => showTooltip(plugin.id, event.currentTarget)}
        onMouseLeave={() => hideTooltip(plugin.id)}
        onFocus={(event) => showTooltip(plugin.id, event.currentTarget)}
        onBlur={() => hideTooltip(plugin.id)}
        onClick={() => { onCloseSettings?.(); setMainSurface(plugin.surface) }}
      >
        <Icon className="surface-navigation__icon" size={14} aria-hidden="true" />
      </NavigationButton>
    )
  }
  return (
    <>
      {SURFACE_NAVIGATION_PLUGINS.filter((plugin) => plugin.kind === 'launcher').map(renderPlugin)}
      <nav className="surface-navigation" aria-label="Primary surfaces">
        <div className="surface-navigation__surfaces" role="group" aria-label="Work surfaces and settings">
          {SURFACE_NAVIGATION_PLUGINS.filter((plugin) => plugin.kind === 'surface').map(renderPlugin)}
          <button
            type="button"
            className="surface-navigation__slot surface-navigation__settings"
            aria-label="Settings"
            title="Settings"
            aria-expanded={settingsOpen}
            data-settings-section="workspaces"
            onClick={() => settingsOpen ? onCloseSettings?.() : onOpenSettings('workspaces')}
          >
            <Settings2 size={14} aria-hidden="true" />
          </button>
        </div>
      </nav>
      {activePlugin && tooltip ? (
        <WindowOverlayPortal layer="tooltip">
          {renderTooltip(activePlugin)}
        </WindowOverlayPortal>
      ) : null}
    </>
  )
}
