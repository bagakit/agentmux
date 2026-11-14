import { restoreMissingSemanticIdentity, type SemanticIdentityRecoveryResult } from '@agentmux/core'

/** Main owns the original local Store and the native file picker. No Renderer path is accepted. */
export function localRuntimeRecovery(location: { storePath: string; stateDirectory: string }) {
  let current: Promise<SemanticIdentityRecoveryResult> | undefined
  let selecting: Promise<SemanticIdentityRecoveryResult> | undefined
  const report = (error: unknown): SemanticIdentityRecoveryResult => {
    const code = (error as NodeJS.ErrnoException)?.code
    return { state: 'needs-backup', code: typeof code === 'string' && /^[A-Z0-9_-]+$/u.test(code) ? code : 'IDENTITY_RECOVERY_UNCONFIRMED' }
  }
  const check = () => current ??= restoreMissingSemanticIdentity(location).catch(report).then(result => {
    if (result.state === 'deferred') current = undefined
    return result
  })
  const choose = (pick: () => Promise<string | null>) => {
    if (!selecting) {
      selecting = (async () => {
        const previous = await check()
        if (previous.state !== 'needs-backup') return previous
        const selected = await pick()
        if (!selected) return previous
        current = restoreMissingSemanticIdentity(location, selected).catch(error =>
          (error as NodeJS.ErrnoException)?.code === 'RUNTIME_OWNER_BUSY' ? report(error) :
            { state: 'needs-backup', code: 'IDENTITY_BACKUP_UNVERIFIED' })
        return await current
      })().finally(() => { selecting = undefined })
    }
    return selecting
  }
  return { check, choose }
}
