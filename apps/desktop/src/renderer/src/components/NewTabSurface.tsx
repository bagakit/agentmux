import { Bot, Globe2, LoaderCircle, RadioTower, SquareTerminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { LaunchAgent } from './LaunchAgent'

export function NewTabSurface({ paneId, tabId }: { paneId: string; tabId?: string }) {
  const launcherView = useAppStore((state) => {
    const tab = tabId ? state.tabs[tabId] : undefined
    return tab?.kind === 'launcher' ? tab.view : 'picker'
  })
  const [starting, setStarting] = useState<'terminal' | 'browser' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const firstAction = useRef<HTMLButtonElement>(null)
  const config = useAppStore((state) => state.config)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const tabWorkspaceId = useAppStore((state) => tabId ? state.tabs[tabId]?.workspaceId : undefined)
  const launchTerminal = useAppStore((state) => state.launchTerminal)
  const createBrowser = useAppStore((state) => state.createBrowser)
  const openLauncher = useAppStore((state) => state.openLauncher)
  const setLauncherView = useAppStore((state) => state.setLauncherView)
  const workspace = config?.workspaces.find((item) => item.id === (tabWorkspaceId ?? activeWorkspaceId))

  useEffect(() => {
    firstAction.current?.focus()
  }, [])

  async function choose(kind: 'terminal' | 'browser'): Promise<void> {
    if (starting) return
    setStarting(kind)
    setError(null)
    try {
      if (kind === 'terminal') await launchTerminal(paneId, tabId)
      else await createBrowser(paneId, tabId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStarting(null)
    }
  }

  if (launcherView === 'agent') {
    return (
      <LaunchAgent
        paneId={paneId}
        {...(tabId ? { launcherTabId: tabId } : {})}
        onBack={() => {
          if (tabId) setLauncherView(tabId, 'picker')
        }}
      />
    )
  }

  return (
    <section className="new-tab-surface">
      <header>
        <div className="eyebrow">New tab</div>
        <h2>What do you want to open?</h2>
        <p>Choose content for this pane. The selected content replaces this surface in the same tab.</p>
      </header>
      <div className="new-tab-grid">
        <button ref={firstAction} type="button" onClick={() => void choose('terminal')} disabled={starting !== null}>
          <span className="new-tab-card__icon"><SquareTerminal size={19} /></span>
          <span><strong>Terminal</strong><small>Open the host shell in a recoverable core session.</small></span>
          {starting === 'terminal' ? <LoaderCircle className="spin" size={14} /> : null}
        </button>
        <button
          type="button"
          onClick={() => tabId ? setLauncherView(tabId, 'agent') : openLauncher(paneId, 'agent')}
          disabled={starting !== null}
        >
          <span className="new-tab-card__icon"><Bot size={19} /></span>
          <span><strong>Agent</strong><small>Launch Codex, Claude, TraeX, Hermes, or Pi.</small></span>
        </button>
        <button type="button" onClick={() => void choose('browser')} disabled={starting !== null}>
          <span className="new-tab-card__icon"><Globe2 size={19} /></span>
          <span><strong>Browser</strong><small>Navigate in a Main-owned embedded WebContents.</small></span>
          {starting === 'browser' ? <LoaderCircle className="spin" size={14} /> : null}
        </button>
      </div>
      <footer>
        <span>{workspace?.hostId !== 'local' ? <RadioTower size={11} /> : null}{workspace?.name ?? 'No workspace'} · {workspace?.hostId ?? 'No host'}</span>
        <kbd>tab</kbd><span>choose</span><kbd>↵</kbd><span>open</span>
      </footer>
      {error ? <div className="new-tab-error" role="alert">{error}</div> : null}
    </section>
  )
}
