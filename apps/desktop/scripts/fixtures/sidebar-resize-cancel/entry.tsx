// Reuse the original App + actual durable public Core spatial boundary and original file Regions.
import '../cross-device-project-groups/entry'
import { useAppStore } from '../../../src/renderer/src/store'
import { updateThemeSelection } from '@agentmux/client-ui/theme'
import { api } from '../../../src/renderer/src/lib/api'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
const presses: { target: string; detail: number }[] = []
document.addEventListener('mousedown', event => { const node = (event.target as HTMLElement).closest('[role="separator"]'); presses.push({ target: node?.getAttribute('aria-label') ?? (event.target as HTMLElement).className, detail: event.detail }) }, true)
Object.assign(window, { sidebarResizeFixture: {
  presses,
  async prepareSpatialBaseline() { const original = await api.spatial.read(); if (!original) throw new Error('Original private spatial seed is missing'); await api.spatial.commit({ expectedRevision: original.revision, graph: desktopSpatialGraph(useAppStore.getState(), [], original.graph) }) },
  widths() { const s = useAppStore.getState(); return { projectRailWidth: s.projectRailWidth, toolDockWidth: s.toolDockWidth,
    surveySidebarWidth: s.surveySidebarWidth, recallSidebarWidth: s.recallSidebarWidth, focusTimelineNameWidth: s.focusTimelineNameWidth } },
  show(surface: 'workbench' | 'survey' | 'recall' | 'agents') { const s = useAppStore.getState(); s.setMainSurface(surface); s.setSurveySidebarCollapsed(false); s.setRecallSidebarCollapsed(false) },
  theme(mode: 'light' | 'dark') { useAppStore.setState(s => ({ config: { ...s.config!, appearance: { ...s.config!.appearance, appAppearance: mode } } })); updateThemeSelection({ appAppearance: mode }) }
} })
