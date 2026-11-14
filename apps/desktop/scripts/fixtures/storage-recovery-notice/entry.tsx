import { createRoot } from 'react-dom/client'
import { GlobalSystemNotices } from '../../../src/renderer/src/components/GlobalSystemNotices'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'
import type { DesktopStorageRecoveryRead } from '../../../src/shared/storage-recovery'

const owner = { runtimeId: 'original-local-host', ownerInstanceId: 'original-instance' }
let observation: DesktopStorageRecoveryRead = { owner, status: { state: 'unavailable', pending: false, issue: 'ENOSPC', lastGeneration: {
  generationId: 'original-saved-point', namespace: owner.runtimeId, createdAt: Date.parse('2026-11-16T01:20:00+08:00'), memberCount: 143, manifestHash: 'a'.repeat(64),
  gaps: [{ sourceId: 'desktop.workbench', memberId: 'desktop.user-state/document', code: 'ENOSPC' }]
} } }
const calls: string[] = []
api.ui.readStorageRecovery = async () => { calls.push('storage.recovery.status'); return structuredClone(observation) }
api.ui.createStorageBackup = async target => {
  if (JSON.stringify(target) !== JSON.stringify(owner)) throw Error('The original backup Host changed.')
  calls.push('storage.backup.create')
  observation = { owner, status: { state: 'idle', pending: false, issue: null,
    lastGeneration: { ...observation.status.lastGeneration!, generationId: 'confirmed-new-point', gaps: [] } } }
  return structuredClone(observation)
}
useAppStore.setState({ loading: false, sessions: [], tabs: {}, notificationEvents: [], noticeReadReceipts: {}, error: null, lastError: null,
  errorNoticeContext: null, environmentWarning: '', runtimeOwnershipWarnings: [], runtimeEndpointWarnings: [], displacedAgentSessionIds: [],
  agentSteerQueues: {}, agentSteerInFlight: {}, workbenchSaveWarning: null, workbenchSaveWarningOwner: null })
Object.assign(window, { recoveryNoticeGallery: { facts: () => ({ calls, observation }) } })
document.documentElement.dataset.appearance = 'dark'
createRoot(document.getElementById('root')!).render(<main style={{ height: '100vh', display: 'grid', gridTemplateRows: '1fr auto', background: 'var(--surface-0)', color: 'var(--text)' }}>
  <section style={{ padding: 36 }}><div style={{ color: 'var(--muted)', fontSize: 12 }}>LOCAL WORKSPACE</div><h2 style={{ fontWeight: 500, fontSize: 20 }}>Current work remains available</h2>
    <p style={{ color: 'var(--muted)', maxWidth: 440, lineHeight: 1.7 }}>A backup observation does not change the current work surface or send Agent input.</p></section>
  <footer style={{ display: 'flex', justifyContent: 'flex-end', padding: 12, borderTop: '1px solid var(--line)' }}><GlobalSystemNotices nativeOverlayWarning="" /></footer>
</main>)
