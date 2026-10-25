import { ContentCopyButton } from '@agentmux/client-ui/components/ContentCopyButton'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { formatSessionAddress } from '@agentmux/core/sharing'
import type { LauncherResumeRow } from '../lib/launcher-resume'
import { launcherResumeActionIdentity } from '../lib/launcher-resume-actions'
import { useAppStore } from '../store'

const ForwardIcon = semanticIconComponent('navigation.forward')

/** These actions operate on the selected saved identity without resuming its original CLI. */
export function LauncherResumeActions({ row, onTakeOver, disabled = false }: {
  row: LauncherResumeRow
  onTakeOver?: ((row: LauncherResumeRow, trigger: HTMLButtonElement) => void) | undefined
  disabled?: boolean
}) {
  const identity = launcherResumeActionIdentity(row)
  const copyError = (error: unknown) => useAppStore.getState().reportError(error)
  return <div className="launcher-resume__actions" aria-label="Saved Session actions">
    {identity.agentSessionId ? <ContentCopyButton text={formatSessionAddress(identity.agentSessionId)}
      identity={identity.agentSessionId} label="Copy Agent link" actionLabel="Agent link" onCopyError={copyError} /> : null}
    {identity.nativeSessionId ? <ContentCopyButton text={identity.nativeSessionId} identity={identity.nativeSessionId}
      label="Copy origin session ID" actionLabel="Origin ID" onCopyError={copyError} /> : null}
    {onTakeOver ? <button type="button" className="small-button" disabled={disabled}
      onClick={event => onTakeOver(row, event.currentTarget)}><ForwardIcon size={13} aria-hidden="true" /> Take over</button> : null}
  </div>
}
