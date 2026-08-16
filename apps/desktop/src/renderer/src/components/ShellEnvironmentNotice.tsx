import { useEffect, useId, useState } from 'react'
import { Info, X } from 'lucide-react'
import { useAppStore } from '../store'
import { useServiceNotices, type ServiceNoticeItem } from '../lib/use-service-notices'
import { ServiceWindowNotice } from './ServiceWindowNotice'

export function ShellEnvironmentNotice() {
  const warning = useAppStore((state) => state.environmentWarning)
  const id = useId()
  const [open, setOpen] = useState(false)
  const notices: ServiceNoticeItem[] = warning ? [{ id: 'shell', notice: {
    kind: 'process-degraded',
    notice: {
      step: 'Local shell environment is incomplete',
      mode: warning,
      restore: 'Check your shell startup scripts, then restart AgentMux and create a new Agent or terminal. Existing processes keep their original environment.'
    }
  } }] : []
  // The snapshot owns recovery. An empty startup projection is not a resolved warning.
  const inbox = useServiceNotices('global:environment', notices, warning !== undefined)
  useEffect(() => {
    if (open && inbox.unread.length) inbox.acknowledge(inbox.unread)
  }, [open, inbox])
  useEffect(() => { if (!warning) setOpen(false) }, [warning])
  if (!warning) return null
  return <div className="shell-environment-notice">
    <button type="button" className="shell-environment-notice__trigger" data-unread={inbox.unread.length > 0}
      aria-label={`Environment notice: ${inbox.unread.length ? 'unread' : 'read'}`}
      aria-expanded={open} aria-controls={id} title="Local shell environment"
      popoverTarget={id} popoverTargetAction="toggle">
      <Info size={13} aria-hidden="true" />Environment
      {inbox.unread.length ? <span className="shell-environment-notice__dot" aria-hidden="true" /> : null}
    </button>
    <div id={id} popover="auto" className="shell-environment-notice__details" aria-label="Local shell environment"
      onToggle={(event) => setOpen(event.newState === 'open')}>
      <div className="shell-environment-notice__heading">
        <strong>Environment notice</strong>
        <button type="button" className="icon-button" aria-label="Collapse environment notice" title="Collapse environment notice"
          popoverTarget={id} popoverTargetAction="hide"><X size={14} /></button>
      </div>
      <ServiceWindowNotice notice={notices[0]!.notice} />
    </div>
  </div>
}
