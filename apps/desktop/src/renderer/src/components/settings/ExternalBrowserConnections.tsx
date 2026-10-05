import { TextInput } from '@agentmux/client-ui/input'
import { useEffect, useState } from 'react'
import { Copy, Link, FolderOpen, Unlink } from 'lucide-react'
import type { AgentMuxBrowserTarget, AgentMuxExternalBrowserPairing } from '@agentmux/core'
import { api } from '../../lib/api'
import { useAppStore } from '../../store'
import { presentError } from '@agentmux/client-ui/error-presentation'

/** Person-only connection controls. Pairing never shares a tab or changes a workbench. */
export function ExternalBrowserConnections() {
  const workspaceId = useAppStore(state => state.activeWorkspaceId)
  const [targets, setTargets] = useState<AgentMuxBrowserTarget[]>([])
  const [pairing, setPairing] = useState<AgentMuxExternalBrowserPairing | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let current = true
    setPairing(null)
    const read = async (): Promise<void> => {
      try {
        const result = await api.browser.listTargets(workspaceId ?? undefined)
        if (current) { setTargets(result.targets.filter(row => row.source === 'external')); setNotice(result.warning ?? '') }
      } catch (error) { if (current) setNotice(presentError(error)) }
    }
    const release = api.browser.onTargetsChanged(() => { void read() })
    void read()
    return () => { current = false; release() }
  }, [workspaceId])
  async function perform(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    try { await action() } catch (error) { setNotice(presentError(error)) }
    finally { setBusy(false) }
  }
  return <section className="settings-group external-browser-connections">
    <header><span>Share an external tab</span><small>{targets.filter(row => row.status === 'ready').length} available</small></header>
    <p className="settings-group-note">Keep your page in its own browser. Load the AgentMux extension, connect it here, then choose <strong>Share this tab</strong> in the extension. Other tabs stay outside the connection.</p>
    <div className="external-browser-connections__actions">
      <button className="small-button" disabled={busy} onClick={() => void perform(() => api.browser.revealExternalExtension())}><FolderOpen size={13} /> Extension folder</button>
      <button className="small-button" disabled={busy || !workspaceId} onClick={() => void perform(async () => {
        if (!workspaceId) return
        const result = await api.browser.createExternalPairing(workspaceId)
        if (useAppStore.getState().activeWorkspaceId !== workspaceId) return
        setPairing(result); setNotice('Paste this connection link in the extension. It expires in 10 minutes; no tab is shared yet.')
      })}><Link size={13} /> Connect extension</button>
    </div>
    {!workspaceId ? <p className="settings-group-note">Choose a Workspace to connect an external tab.</p> : null}
    {pairing ? <div className="external-browser-connections__link">
      <TextInput type="password" aria-label="Private extension connection link" readOnly value={pairing.link} autoComplete="off" />
      <button className="small-button" disabled={busy} onClick={() => void perform(async () => { if (Date.now() >= pairing.expiresAt) { setPairing(null); setNotice('This connection link expired. Create another connection link.'); return } await api.ui.writeClipboardText(pairing.link); setNotice('Connection link copied. Paste it in the AgentMux extension.') })}><Copy size={13} /> Copy</button>
    </div> : null}
    {targets.length ? <ul className="external-browser-connections__targets">{targets.map(row => <li key={row.id}>
      <div><strong>{row.title || 'Shared tab'}</strong><small>{row.status} · {row.id}</small>{row.warning ? <p>{row.warning}</p> : null}</div>
      {row.status !== 'revoked' && row.status !== 'closed' ? <button className="small-button" disabled={busy} onClick={() => void perform(() => api.browser.stopSharingExternal(row.id))}><Unlink size={13} /> Stop sharing</button> : null}
    </li>)}</ul> : null}
    {notice ? <p className="settings-group-note" role="status">{notice}</p> : null}
  </section>
}
