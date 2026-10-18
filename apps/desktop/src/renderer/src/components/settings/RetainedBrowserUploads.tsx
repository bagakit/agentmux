import { useWorkbenchWindowDocument } from '../../lib/workbench-document'
import { useEffect, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { BrowserRetainedUploads } from '../../../../shared/browser-upload'
import { api } from '../../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'

const ThemeActionRemoveIcon = semanticIconComponent('action.remove')


/** Original upload snapshots, retained without reconnecting or reading a page. */
export function RetainedBrowserUploads({ active }: { active: boolean }) {
  const dialogDocument = useWorkbenchWindowDocument() ?? undefined
  const [retained, setRetained] = useState<BrowserRetainedUploads | null>(null)
  const [notice, setNotice] = useState('')
  const [readIssue, setReadIssue] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    if (!active) return
    let current = true
    const read = async (): Promise<void> => {
      try { const value = await api.browser.listRetainedUploads(); if (current) { setRetained(value); setReadIssue('') } }
      catch (error) { if (current) setReadIssue(presentError(error)) }
    }
    const release = api.browser.onTargetsChanged(() => { void read() })
    void read()
    return () => { current = false; release() }
  }, [active])
  if (!retained?.selections.length && !notice && !readIssue && !retained?.warning) return null
  return <section className="settings-group external-browser-connections">
    <header><span>Selected files</span><small>{retained ? `${retained.selectionCount} selections · ${formatBytes(retained.byteLength)}` : 'Not yet observed'}</small></header>
    <p className="settings-group-note">Files selected for upload are kept through disconnects and restarts. Discard only after an upload finishes or is cancelled; unconfirmed documents keep their files.</p>
    <ul className="external-browser-connections__targets">{retained?.selections.map(selection => <li key={selection.id}>
      <div><strong>{selection.files.join(', ') || 'Unknown document selection'}</strong><small>{selection.status} · {formatBytes(selection.byteLength)} · {selection.browserId || 'Document owner unavailable'}</small></div>
      <button className="small-button" disabled={busy !== null} onClick={() => {
        setBusy(selection.id)
        void (async () => {
          try {
            const discarded = await api.browser.discardRetainedUpload(selection.id, dialogDocument)
            setRetained(await api.browser.listRetainedUploads())
            setNotice(discarded ? 'These selected-file snapshots were discarded. The original page may no longer upload them.' : 'Files kept. No other selection was changed.')
          } catch (error) { setNotice(presentError(error)) }
          finally { setBusy(null) }
        })()
      }}><ThemeActionRemoveIcon size={13} /> Discard</button>
    </li>)}</ul>
    {retained ? <p className="settings-group-note">Shared staging limit: {retained.selectionLimit} selections · {formatBytes(retained.byteLimit)}.</p> : null}
    {retained?.warning ? <p className="settings-group-note" role="status">{retained.warning}</p> : null}
    {readIssue ? <div className="browser-resources__notices" role="status"><strong>Selected-file status unavailable</strong><details><summary>Observation details</summary><p>{readIssue}</p></details></div> : null}
    {notice ? <p className="settings-group-note" role="status">{notice}</p> : null}
  </section>
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
