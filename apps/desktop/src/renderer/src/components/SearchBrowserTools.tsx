import { memo, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import type { BrowserToolbarConfig, WorkspaceRecord } from '../../../shared/contracts'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { formatBrowserAnnotationsContext } from '../lib/browser-annotations'
import { workbenchSurfaces } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { BrowserAnnotationsPanel } from './BrowserAnnotationsPanel'
import { BrowserProfilesPanel } from './BrowserProfilesPanel'
import { BrowserToolbarPreferences } from './BrowserToolbarPreferences'

export const SearchBrowserTools = memo(function SearchBrowserTools({ workspace, visible = true }: { workspace: WorkspaceRecord; visible?: boolean }) {
  const config = useAppStore((state) => state.config)
  const layout = useAppStore((state) => state.layouts[workspace.id])
  // Keep the original controls' local drafts while the visited Search surface is hidden.
  // Its data still comes from the same Store; hidden tools do not subscribe to runtime updates.
  const toolStore = useMemo(() => ({
    getState: useAppStore.getState,
    getInitialState: useAppStore.getInitialState,
    subscribe: visible ? useAppStore.subscribe : () => () => {}
  }), [visible])
  const sessions = useStore(toolStore, (state) => state.sessions)
  const tabs = useStore(toolStore, (state) => state.tabs)
  const browserAnnotationsByBrowserId = useStore(toolStore, (state) => state.browserAnnotationsByBrowserId)
  const deleteBrowserAnnotation = useAppStore((state) => state.deleteBrowserAnnotation)
  const clearBrowserAnnotations = useAppStore((state) => state.clearBrowserAnnotations)
  const appendAgentComposerDraft = useAppStore((state) => state.appendAgentComposerDraft)
  const selectSession = useAppStore((state) => state.selectSession)
  const [savingBrowserToolbar, setSavingBrowserToolbar] = useState(false)
  const allBrowserSurfaces = useMemo(() => Object.values(tabs).flatMap((tab) => workbenchSurfaces(tab))
    .flatMap((candidate) => candidate.kind === 'browser' ? [candidate] : []), [tabs])
  const browserSurfaces = useMemo(() => allBrowserSurfaces.filter((candidate) => candidate.workspaceId === workspace.id), [allBrowserSurfaces, workspace.id])
  const currentNavigationByBrowserId = useMemo(() => Object.fromEntries(browserSurfaces.map((browser) => [
    browser.browserId, browser.navigationId
  ])), [browserSurfaces])
  const browserAnnotations = useMemo(() => Object.values(browserAnnotationsByBrowserId).flat()
    .filter((annotation) => annotation.workspaceId === workspace.id), [browserAnnotationsByBrowserId, workspace.id])
  const workspaceAgentSessions = useMemo(() => sessions.flatMap((session) => (
    session.kind === 'agent' && workspaceOwnsSessionPath(workspace, session) ? [session] : []
  )), [sessions, workspace])

  async function saveBrowserToolbar(toolbar: BrowserToolbarConfig, expected: BrowserToolbarConfig): Promise<void> {
    if (savingBrowserToolbar) return
    const current = useAppStore.getState().config
    if (!current) throw new Error('Browser bar settings are unavailable. Retry after configuration is restored.')
    setSavingBrowserToolbar(true)
    try {
      await api.config.save({ ...current, browser: { ...current.browser, toolbar } },
        { ...current, browser: { ...current.browser, toolbar: expected } })
    } finally {
      setSavingBrowserToolbar(false)
    }
  }

  return (
    <section className="browser-tools-panel" aria-label="Browser Tools">
      {config ? <BrowserToolbarPreferences
        toolbar={config.browser.toolbar}
        saving={savingBrowserToolbar}
        onSave={saveBrowserToolbar}
      /> : null}
      <BrowserProfilesPanel browsers={browserSurfaces} allBrowsers={allBrowserSurfaces} />
      <BrowserAnnotationsPanel
        annotations={browserAnnotations}
        currentNavigationByBrowserId={currentNavigationByBrowserId}
        agentSessions={workspaceAgentSessions}
        onDelete={deleteBrowserAnnotation}
        onClear={() => {
          for (const browserId of new Set(browserAnnotations.map(({ browserId }) => browserId))) {
            clearBrowserAnnotations(browserId)
          }
        }}
        onAddToComposer={(sessionId, currentAnnotations) => {
          appendAgentComposerDraft(sessionId, formatBrowserAnnotationsContext(currentAnnotations))
          selectSession(sessionId, layout?.activeGroupId)
        }}
      />
    </section>
  )
})
