import { useEffect, useState } from 'react'
import type { BrowserProfileCreationOperation } from '@agentmux/core/control'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { Button } from '@agentmux/client-ui/components/Button'
import { submitProfileCreation } from '../../lib/browser-profile-creations'

const creationLabels: Record<BrowserProfileCreationOperation, string> = {
  'browser.profile.create': 'Create Profile', 'browser.profile.copy': 'Copy Profile',
  'browser.profile.folder.create': 'Create folder', 'browser.profile.view.create': 'Save view',
  'browser.profile.proxy.create': 'Create proxy'
}

/** Original client input only. Confirmation goes back to the same Main metadata owner. */
export function BrowserProfilePendingCreations() {
  const [requests, setRequests] = useState<Awaited<ReturnType<typeof submitProfileCreation.pending>>>([])
  const [busy, setBusy] = useState<ReadonlySet<BrowserProfileCreationOperation>>(() => new Set()), [issue, setIssue] = useState<string | null>(null)
  useEffect(() => {
    let mounted = true
    const read = () => { void submitProfileCreation.pending().then(value => { if (mounted) setRequests(value) }, error => { if (mounted) setIssue(presentError(error)) }) }
    const release = submitProfileCreation.subscribe(read)
    read()
    return () => { mounted = false; release() }
  }, [])
  const confirm = async (action: BrowserProfileCreationOperation) => {
    setBusy(current => new Set([...current, action])); setIssue(null)
    try { await submitProfileCreation.confirm(action) }
    catch (error) { setIssue(presentError(error)) }
    finally { setBusy(current => new Set([...current].filter(value => value !== action))) }
  }
  if (!requests.length && !issue) return null
  return <section className="browser-profile-editor__section" aria-label="Pending Profile creations">
    <h4>Creations awaiting confirmation</h4>
    <p className="browser-profile-editor__quiet">Original requests and later inputs are kept. Resolve each pending request before repeating that action.</p>
    {requests.map(request => <div className="settings-pane-toolbar" key={request.operationId}>
      <span className="browser-profile-editor__quiet" style={{ overflowWrap: 'anywhere' }}>{creationLabels[request.operation]} · {request.operation === 'browser.profile.proxy.create' ? request.edit.label : request.label}<br /><code style={{ fontSize: '0.85em' }}>{request.operationId}</code></span>
      <Button type="button" disabled={busy.has(request.operation) || submitProfileCreation.isInFlight(request.operation)} onClick={() => void confirm(request.operation)}>Confirm creation</Button>
    </div>)}
    {issue ? <p role="status" className="browser-profile-editor__quiet">{issue}</p> : null}
  </section>
}
