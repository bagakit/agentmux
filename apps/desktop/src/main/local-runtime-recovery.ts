import { restoreMissingSemanticIdentity, type SemanticIdentityRecoveryResult } from '@agentmux/core'

/** Main owns the original local Store and the native file picker. No Renderer path is accepted. */
export function localRuntimeRecovery(location: { storePath: string; stateDirectory: string }) {
  let current: Promise<SemanticIdentityRecoveryResult> | undefined
  let selecting: Promise<SemanticIdentityRecoveryResult> | undefined
  const report = (error: unknown, picked = false): SemanticIdentityRecoveryResult => {
    const detail = (error as NodeJS.ErrnoException)?.code
    const code = typeof detail === 'string' && /^[A-Z0-9_-]+$/u.test(detail) ? detail : 'IDENTITY_RECOVERY_UNCONFIRMED'
    if (['IDENTITY_SOURCE_MISSING', 'IDENTITY_SOURCE_UNCONFIRMED',
      'RUNTIME_AUTHORITY_MISMATCH', 'AGENT_CREATION_AUTHORITY_INVALID'].includes(code))
      return { state: 'needs-backup', code: picked ? 'IDENTITY_BACKUP_UNVERIFIED' : code }
    return { state: 'blocked', code }
  }
  const run = (work: Promise<SemanticIdentityRecoveryResult>) => {
    const result = work.finally(() => { if (current === result) current = undefined })
    current = result
    return result
  }
  const check = () => current ?? run(restoreMissingSemanticIdentity(location).catch(error => report(error)))
  const choose = (pick: () => Promise<string | null>) => {
    if (!selecting) {
      selecting = (async () => {
        const previous = await check()
        if (previous.state !== 'needs-backup') return previous
        const selected = await pick()
        if (!selected) return previous
        if (current) await current
        return await run(restoreMissingSemanticIdentity(location, selected).catch(error => report(error, true)))
      })().finally(() => { selecting = undefined })
    }
    return selecting
  }
  return { check, choose }
}
