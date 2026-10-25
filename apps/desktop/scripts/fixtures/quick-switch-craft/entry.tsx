import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { QuickSwitcher } from '../../../src/renderer/src/components/QuickSwitcher'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'

// Actual switcher, index, Store, overlay and theme. Only native discovery uses controlled preview IO.
const config = await api.config.get(), workspace = config.workspaces[0]!
const scope = { hostId: workspace.hostId, repoPath: workspace.path, workspacePath: workspace.path }
const tabs = {
  browser: createWorkbenchTab('browser', { regionId: 'browser-region', kind: 'browser', workspaceId: workspace.id,
    id: 'original-browser', url: 'https://example.invalid/', title: 'New Tab', loading: false, canGoBack: false, canGoForward: false } as Parameters<typeof createWorkbenchTab>[1]),
  file: createWorkbenchTab('file', { regionId: 'file-region', kind: 'file', workspaceId: workspace.id, path: 'src/main.ts' }),
  git: createWorkbenchTab('git', { regionId: 'git-region', kind: 'git', workspaceId: workspace.id, scope, selection: null }),
  launcher: createWorkbenchTab('launcher', { regionId: 'launcher-region', kind: 'launcher', workspaceId: workspace.id })
}
const layout = { root: { type: 'leaf' as const, groupId: 'original-group' }, activeGroupId: 'original-group',
  groups: [{ id: 'original-group', tabOrder: Object.keys(tabs), activeTabId: 'browser', recentTabIds: [] }] }
useAppStore.setState({ config, loading: false, sessions: [], tabs, layouts: { [workspace.id]: layout }, activeWorkspaceId: workspace.id, mainSurface: 'workbench' })
api.files.list = async () => ({ status: 'listed', files: ['src/main.ts', 'docs/interaction.md', 'packages/client-ui/src/components/QuickSwitcher.tsx'],
  complete: true, omitted: 'git-ignored', partialReason: null })
mountThemeRuntime(window, { ...config.appearance, appAppearance: 'dark' })
let openSwitch: () => void
function Consumer() {
  const [open, setOpen] = useState(false), source = useRef<HTMLTextAreaElement>(null)
  openSwitch = () => { source.current?.focus(); setOpen(true) }
  return <><textarea ref={source} className="ui-input" aria-label="Original unsaved draft" defaultValue="Keep the original draft and selection." />
    <QuickSwitcher open={open} onClose={() => setOpen(false)} returnFocus={() => source.current} /></>
}
flushSync(() => createRoot(document.getElementById('root')!).render(<Consumer />))
Object.assign(window, { quickCraft: {
  show(mode: 'dark' | 'light') { updateThemeSelection({ ...config.appearance, appAppearance: mode }); flushSync(() => openSwitch()) },
  empty() { flushSync(() => useAppStore.setState({ tabs: {} })) },
  facts() { const state = useAppStore.getState(); return { layout: state.layouts[workspace.id], workspaceId: state.activeWorkspaceId } }
} })
