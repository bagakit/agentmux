import type { RecoveryGeneration } from '@agentmux/core'
import type { DesktopStorageRecoveryRead } from '../../../shared/storage-recovery'
import type { ServiceNoticeItem } from './use-service-notices'

/** Read-only presentation of the original Core DTO and an observation failure. */
export function storageRecoveryNotice(read: DesktopStorageRecoveryRead | null, point: RecoveryGeneration | null, error: string | null,
  retry: () => void, check: () => void): ServiceNoticeItem | null {
  const status = read?.status, gaps = status?.lastGeneration?.gaps ?? []
  const informational = gaps.length > 0 && gaps.every(gap => gap.code === 'RECOVERY_OWNER_NOT_CREATED')
  if (!error && (!status || status.state !== 'unavailable' && !status.issue && gaps.length === 0 ||
    informational && (!status.issue || status.issue === 'RECOVERY_COVERAGE_INCOMPLETE'))) return null
  const current = status?.lastGeneration ?? point
  const saved = current ? `Last recorded recovery point: ${new Date(current.createdAt).toLocaleString()} · ${current.memberCount} files (${current.generationId}).`
    : 'No recovery point has been confirmed yet.'
  const details = gaps.map(gap => `${gap.sourceId}${gap.memberId ? '/' + gap.memberId : ''}: ${gap.code}`).join('\n')
  const step = error ? 'Recovery point status is unavailable' : 'Recovery point needs attention'
  const mode = `${saved} ${error ? 'Current backup status is unknown.' : status?.state === 'capturing' ? 'A backup is in progress.' : 'A newer backup could not be confirmed.'} Existing work and healthy Agents remain usable.`
  const restore = [error ?? status?.issue, details, 'Check storage access and retry a backup on this same Host.'].filter(Boolean).join('\n')
  const issue = error ?? status?.issue
  const diagnostics = [issue && !gaps.some(gap => gap.code === issue) ? issue : null, details].filter(Boolean).join('\n')
  return { id: 'storage-recovery', cause: JSON.stringify([read?.owner.runtimeId, error, status?.issue, gaps]),
    notice: { kind: error ? 'indeterminate' : 'process-degraded', notice: { step, mode, restore } },
    summary: { step, mode: '', restore: 'Retry backup on the same Host.' },
    detail: [mode, diagnostics, 'Check storage access and retry a backup on this same Host.'].filter(Boolean).join('\n'),
    action: { label: read ? 'Retry backup' : 'Check backup status', run: read ? retry : check } }
}
