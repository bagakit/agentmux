import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkspaceLayout } from '@agentmux/layout'
import { StableWorkbenchView } from '../../../src/renderer/src/components/StableWorkbenchView'
import { SessionPane } from '../../../src/renderer/src/components/SessionPane'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { workbenchSessionStageHostId, type WorkbenchViewTarget } from '../../../src/renderer/src/lib/workbench-presentation'
import { api } from '../../../src/renderer/src/lib/api'
await import('../mailbox-message-navigation/entry')
const original = (window as any).mailboxNavigation, base = (window as any).resultReady
const repo = _hygiene_fixturePath("remote/resources/a-long-project-name-with-space/project-root")
const worktree = repo + '/.worktrees/a-long-worktree-with-a-different-directory'
const cwd = _hygiene_fixturePath("execution/original-agent/worktrees/independent-current-cwd")
const attach = api.sessions.attach
api.sessions.attach = async (...args) => {
  const snapshot = await attach(...args)
  return { ...snapshot, terminal: snapshot.terminal.type === 'basic-vt' && snapshot.terminal.restoreBytes.byteLength === 0
    ? { ...snapshot.terminal, restoreBytes: new TextEncoder().encode('\x1b[0m') } : snapshot.terminal }
}
const originalSeed = original.seed
const copies: string[] = []
api.ui.writeClipboardText = async text => { copies.push(text) }
original.seed = (appearance: 'dark' | 'light', draft: string) => {
  originalSeed(appearance, draft)
  flushSync(() => useAppStore.setState(state => ({
    config: { ...state.config!, hosts: [...state.config!.hosts.filter(h => h.id !== 'resource-host'),
      { id: 'resource-host', kind: 'ssh', label: 'Registered resource machine', host: 'private.invalid', user: 'preview' }],
      workspaces: [...state.config!.workspaces.filter(w => w.id !== 'resource-root' && !w.id.startsWith('context-display-')),
        { id: 'resource-root', name: 'Registered resource project with a long readable name', hostId: 'resource-host', path: repo, kind: 'folder' }].map(w => w.id === base.workspaceId
          ? { ...w, name: 'Exact resource worktree', hostId: 'resource-host', repoPath: repo, path: worktree, kind: 'worktree', branch: 'long-resource-worktree-branch' } : w) },
    sessions: state.sessions.map(s => s.id === base.sessionId ? { ...s, workspacePath: cwd } : s),
    tabs: { ...state.tabs, [base.tabId]: { ...state.tabs[base.tabId]!, name: 'Original target Tab with a deliberately long name' } }
  })))
}
let mounted: { unmount(): void; hosts: HTMLElement[]; root: HTMLElement } | undefined
const probe = {
  repo, worktree, cwd, sessionId: base.sessionId, origin: { workspaceId: base.workspaceId, groupId: 'result-input-group', tabId: base.tabId, regionId: base.regionId },
  copies,
  projections() {
    if (mounted) throw new Error('The one private projection preview is already mounted')
    const targets: WorkbenchViewTarget[] = ['a', 'b'].map(id => ({ hostId: 'context-presentation-' + id, active: true, visible: true,
      reference: { displayWorkspaceId: 'context-display-' + id, groupId: 'context-group-' + id, tabId: base.tabId, regionId: base.regionId } }))
    flushSync(() => useAppStore.setState(state => ({ viewModes: { ...state.viewModes, [base.sessionId]: 'activity' },
      config: { ...state.config!, workspaces: [...state.config!.workspaces, ...targets.map(t => ({ id: t.reference!.displayWorkspaceId, name: 'Independent display ' + t.hostId, hostId: 'local', path: _hygiene_fixturePath("display/") + t.hostId, kind: 'folder' as const }))] },
            layouts: { ...state.layouts, ...Object.fromEntries(targets.map(t => [t.reference!.displayWorkspaceId, createWorkspaceLayout(t.reference!.groupId, [t.reference!.tabId])])) }
    })))
    const root = document.createElement('div'), stage = document.createElement('div')
    root.dataset.locationProjectionProbe = ''; document.body.append(root)
    root.style.cssText = 'position:fixed;inset:36px 0 0;z-index:10;display:flex;background:var(--surface-1)'
    const hosts = targets.map(t => { const h = document.createElement('div'); h.id = t === targets[0] ? 'context-primary-host' : workbenchSessionStageHostId(t, base.regionId); h.dataset.contextProjection = t.reference!.displayWorkspaceId; h.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;height:100%'; root.append(h); return h })
    stage.style.display = 'none'; root.append(stage)
    const react = createRoot(stage)
    flushSync(() => react.render(<DesktopClientUiProvider><StableWorkbenchView homeId="context-primary-home" targetId="context-primary-host" active retainedRegionId={null} reference={targets[0]!.reference}><SessionPane sessionId={base.sessionId} surfaceKind="agent" interactiveResize={false}
      visible linkOrigin={{ workspaceId: base.workspaceId, tabGroupId: 'context-group-a', tabId: base.tabId, regionId: base.regionId, sessionId: base.sessionId }}
      presentations={[targets[1]!]} renderPresentationFrame={content => content} /></StableWorkbenchView></DesktopClientUiProvider>))
    mounted = { root, hosts, unmount() { flushSync(() => react.unmount()); root.remove(); mounted = undefined } }
    return targets.map((t, i) => ({ ...t.reference, hostId: hosts[i]!.id }))
  },
  closeProjections() { mounted?.unmount() }
}
Object.assign(window, { mailboxLocationContext: probe })
original.seed('dark', 'Original unsent draft')
