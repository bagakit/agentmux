import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { AgentMuxError, hashRecoveryFile, mintObjectId, snapshotRecoveryFile, type AgentMuxRpcClient, type RecoveryGap, type RecoverySource, type RecoverySourceMember } from '@agentmux/core'

const issue = (error: unknown) => {
  const value = (error as { code?: unknown })?.code
  return typeof value === 'string' && /^[A-Z_0-9-]{1,100}$/u.test(value) ? value : 'RECOVERY_DESKTOP_UNAVAILABLE'
}

/** Fixed local Desktop bridge. The Host never discovers or interprets Main files. */
export function createDesktopStorageRecoverySource(connect: () => Promise<AgentMuxRpcClient>): RecoverySource {
  const id = 'desktop.workbench'
  let revision: string | undefined
  return { id,
    async capture(directory) {
      const captureId = mintObjectId(), client = await connect()
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000)
      const members: RecoverySourceMember[] = [], gaps: RecoveryGap[] = []
      let currentRevision = revision ?? 'unavailable'
      try {
        const captured = await client.call('storage.source.capture', { captureId }, { signal: controller.signal })
        currentRevision = captured.revision
        gaps.push(...captured.gaps.map(gap => ({ sourceId: id, memberId: gap.sourceId + '/' + (gap.memberId ?? ''), code: gap.code })))
        for (const member of captured.members) {
          const file = join(directory, createHash('sha256').update(member.id).digest('hex'))
          try { await snapshotRecoveryFile(member.file, file); members.push({ ...member, file }) }
          catch (error) { gaps.push({ sourceId: id, memberId: member.id, code: issue(error) }) }
        }
      } catch (error) { gaps.push({ sourceId: id, code: issue(error) }) }
      finally {
        clearTimeout(timer)
        const release = new AbortController(), deadline = setTimeout(() => release.abort(), 15_000)
        try { await client.call('storage.source.release', { captureId }, { signal: release.signal }) }
        catch (error) { gaps.push({ sourceId: id, code: issue(error) }) }
        finally { clearTimeout(deadline); await client.dispose() }
      }
      revision = currentRevision
      return { revision: currentRevision, members, gaps }
    },
    async prepareRestore(members, directory) {
      const captureId = 'prepare-' + createHash('sha256').update(JSON.stringify(members.map(member => [member.operationId, member.id, member.sha256]))).digest('hex')
      const client = await connect(), controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000)
      try {
        const prepared = await client.call('storage.source.prepare', { captureId, members }, { signal: controller.signal })
        if (prepared.result.state === 'unavailable') return prepared.result
        const result = []
        // Preserve the original owner's dependency order, including close
        // ledger-before-marker publication. Host never interprets the JSON.
        for (const member of prepared.result.members) {
          const file = join(directory, createHash('sha256').update(member.id).digest('hex'))
          await snapshotRecoveryFile(member.file, file)
          if ((await hashRecoveryFile(file)).sha256 !== member.sha256) throw new AgentMuxError('The original Desktop preparation changed before retention.', 'RECOVERY_SOURCE_CHANGED')
          result.push({ ...member, file })
        }
        return { ...prepared.result, members: result }
      } finally {
        clearTimeout(timer)
        const release = new AbortController(), deadline = setTimeout(() => release.abort(), 15_000)
        try { await client.call('storage.source.release', { captureId }, { signal: release.signal }) }
        finally { clearTimeout(deadline); await client.dispose() }
      }
    },
    async restoreMissing(member) {
      const client = await connect(), controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000)
      try { return (await client.call('storage.source.restore', { member }, { signal: controller.signal })).outcome }
      finally { clearTimeout(timer); await client.dispose() }
    },
    subscribe(changed) {
      let disposed = false, polling = false, lastError: string | undefined, active: AbortController | undefined
      const poll = async () => {
        if (disposed || polling) return
        polling = true
        const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 15_000)
        active = controller
        let client: AgentMuxRpcClient | undefined
        try {
          client = await connect()
          const current = await client.call('storage.source.inspect', {}, { signal: controller.signal })
          if (!disposed && (lastError !== undefined || revision !== current.revision)) { revision = current.revision; changed() }
          lastError = undefined
        } catch (error) {
          const code = issue(error)
          if (!disposed && code !== lastError) { lastError = code; changed() }
        } finally { clearTimeout(deadline); try { await client?.dispose() } finally { polling = false; active = undefined } }
      }
      const timer = setInterval(() => { void poll().catch(() => {}) }, 30_000)
      timer.unref?.()
      return () => { disposed = true; clearInterval(timer); active?.abort() }
    }
  }
}
