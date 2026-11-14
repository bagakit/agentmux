import { lstat } from 'node:fs/promises'
import { AgentMuxControlServer, connectAgentMuxRpc, openAgentMuxStorageRecovery, recoveryDigest,
  type RecoveryGeneration, type AgentMuxRpcClient } from '@agentmux/core'
import type { WorkbenchUserStateStore } from './workbench-user-state.js'
import type { WorkbenchWindowStore } from './workbench-window-store.js'
import type { WorkbenchCloseOwner } from './workbench-close-owner.js'
import type { DesktopStorageRecoveryExports } from './storage-recovery-exports.js'

type Options = { storePath: string; stateDirectory: string; socketPath: string; desktopSocketPath: string;
  user: WorkbenchUserStateStore; windows: WorkbenchWindowStore; close: WorkbenchCloseOwner; exports: DesktopStorageRecoveryExports }
export type WorkbenchRecoveryBootstrap = { state: 'unchanged' | 'restored' | 'not-created' | 'unavailable'; operationId?: string; generationId?: string; issue?: string }
const missing = async (path: string) => { try { await lstat(path); return false } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error } }
const sourceId = 'desktop.workbench'

/** Before load/default writes: borrow only the original data owners and Core maintenance API. */
export async function recoverWorkbenchBeforeLoad(options: Options): Promise<WorkbenchRecoveryBootstrap> {
  const primary = [
    { memberId: 'desktop.user-state/document', target: options.user.path },
    { memberId: 'desktop.windows/document', target: options.windows.path }
  ]
  const absent: typeof primary = []; let discoveryIssue: string | undefined
  for (const member of primary) try { if (await missing(member.target)) absent.push(member) }
  catch (error) { absent.push(member); discoveryIssue = (error as NodeJS.ErrnoException)?.code ?? 'DESKTOP_RECOVERY_DISCOVERY_UNCONFIRMED' }
  // Ordinary startup has no backup inventory, object hash or Native work.
  if (!absent.length) return { state: 'unchanged' }
  let owner: Awaited<ReturnType<typeof openAgentMuxStorageRecovery>> | undefined, rpc: AgentMuxRpcClient | undefined, server: AgentMuxControlServer | undefined
  let coverage: NonNullable<RecoveryGeneration['coverage']> = [], operationId: string | undefined, generationId: string | undefined
  const retain = (issue: string): WorkbenchRecoveryBootstrap => {
    const members = new Set([...absent.map(member => member.memberId), ...coverage.filter(member => member.sourceId === sourceId).map(member => member.memberId)])
    options.user.retainRecoveryGaps([...members].filter(id => id.startsWith('desktop.user-state/')).map(id => id.slice('desktop.user-state/'.length)), issue)
    options.windows.retainRecoveryGaps([...members].filter(id => id.startsWith('desktop.windows/')).map(id => id.slice('desktop.windows/'.length)))
    options.close.retainRecoveryGaps([...members].filter(id => id.startsWith('desktop.close-operations/')).map(id => id.slice('desktop.close-operations/'.length)))
    return { state: 'unavailable', issue, ...(operationId ? { operationId } : {}), ...(generationId ? { generationId } : {}) }
  }
  try {
    if (discoveryIssue) return retain(discoveryIssue)
    try { owner = await openAgentMuxStorageRecovery({ storePath: options.storePath, stateDirectory: options.stateDirectory, recoverySources: [options.exports.recoverySource()] }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'RECOVERY_OWNER_NOT_CREATED') return { state: 'not-created' }
      if ((error as NodeJS.ErrnoException).code !== 'RUNTIME_OWNER_BUSY') throw error
      // The original App's same private source owner is available before its
      // full UI service. Standard publication refuses another live endpoint.
      server = new AgentMuxControlServer({ socketPath: options.desktopSocketPath, storageRecoveryExports: options.exports,
        exposedMethods: new Set(['storage.source.capture', 'storage.source.inspect', 'storage.source.prepare', 'storage.source.restore', 'storage.source.release']) })
      await server.start()
      rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: options.socketPath } })
    }
    // list is manifest-only discovery; original Core preflight/apply verifies
    // only the selected original members against this exact manifest hash.
    const generations = owner ? await owner.recovery.list() : (await rpc!.call('storage.backup.list', {})).generations
    const generation = generations.find(generation => absent.every(member => generation.coverage?.some(value => value.sourceId === sourceId && value.memberId === member.memberId)))
    if (!generation?.coverage) return retain('DESKTOP_RECOVERY_COVERAGE_UNCONFIRMED')
    generationId = generation.generationId; coverage = generation.coverage
    const selectors = coverage.filter(member => member.sourceId === sourceId).map(({ sourceId, memberId }) => ({ sourceId, memberId }))
    operationId = 'desktop-bootstrap-' + recoveryDigest(JSON.stringify({ generationId, manifestHash: generation.manifestHash, selectors }))
    const request = { operationId, generationId, manifestHash: generation.manifestHash, selectors }
    const prepared = owner ? await owner.recovery.restorePreflight(request) : (await rpc!.call('storage.restore.preflight', request)).operation
    if (prepared.state === 'unavailable' || prepared.state === 'unknown') return retain('DESKTOP_RECOVERY_PREPARATION_UNAVAILABLE')
    const applied = owner ? await owner.recovery.restoreApply(operationId) : (await rpc!.call('storage.restore.apply', { operationId })).operation
    if (applied.state !== 'complete') return retain('DESKTOP_RECOVERY_RESULT_UNCONFIRMED')
    for (const member of absent) if (await missing(member.target)) return retain('DESKTOP_RECOVERY_MEMBER_STILL_MISSING')
    return { state: applied.items.some(item => item.state === 'restored') ? 'restored' : 'unchanged', operationId, generationId: generation.generationId }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return retain(typeof code === 'string' && /^[A-Z0-9_-]{1,100}$/u.test(code) ? code : 'DESKTOP_RECOVERY_UNAVAILABLE')
  } finally {
    try { try { await server?.stop() } finally { try { await rpc?.dispose() } finally { await owner?.close() } } }
    catch { return retain('DESKTOP_RECOVERY_CLEANUP_UNCONFIRMED') }
  }
}
