import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const core = resolve(import.meta.dirname, '..'), mutation = process.env.AGENTMUX_BACKUP_MUTATION ?? ''
const changes: Record<string, { file: string; edits: [string, string][] }> = {
  'reorder-original-receipt': { file: 'agent-session-store.ts', edits: [["const bytes = JSON.stringify(nativeResult === undefined ? stored : { ...stored, nativeResult })", 'const bytes = JSON.stringify(value)']] },
  'restore-trust-preflight': { file: 'storage-recovery-sources.ts', edits: [['if (unavailable.length) return', 'if (false) return']] },
  'restore-trust-publication': { file: 'storage-recovery-sources.ts', edits: [['if (authorityFile(member.target)) throw', 'if (false) throw']] },
  'republish-lost-point': { file: 'storage-restore.ts', edits: [['if (item.publicationAttempted && current === null)', 'if (false)']] },
  'spatial-default-after-loss': { file: 'spatial-state.ts', edits: [["throw new AgentMuxError('The original topology document is missing and its retained original remains available. Restore that owner; no empty topology was initialized.', 'SPATIAL_STATE_READ_UNCONFIRMED')", 'return null']] },
  'spatial-ignore-newer-point': { file: 'spatial-state.ts', edits: [['if (previous.revision > point.revision)', 'if (false)']] },
  'spatial-owner-unenrolled': { file: 'storage-recovery-maintenance.ts', edits: [["if (source.id === 'core.spatial') enrolled.set", "if (false) enrolled.set"]] },
  'headless-empty-after-recovery': { file: 'headless-runtime.ts', edits: [['return await retainedSessionRecovery(stateDirectory, storePath)', 'return false'], ['if (await retainedSessionRecovery(stateDirectory, storePath))', 'if (false)']] },
  'read-unrelated-artifacts': { file: 'storage-recovery.ts', edits: [['if (selected === undefined || selected.has(key)) await this.verifyObject(member, force)', 'await this.verifyObject(member, force)']] },
  'operation-without-lock': { file: 'storage-recovery.ts', edits: [['return await this.withOwnerLock(() => this.restoreOperations.preflight(request))', 'return await this.restoreOperations.preflight(request)']] },
  'same-path-no-sync': { file: 'storage-recovery.ts', edits: [['await syncFile(target); await confirmDirectoryAncestry(dirname(target))', '/* mutation: accept visible equal bytes */']] },
  'operation-rebind': { file: 'storage-restore.ts', edits: [['if (old.requestHash !== requestHash)', 'if (false)']] },
  'discard-input-hold': { file: 'storage-restore.ts', edits: [['if (!actor.prepareRestore)', 'if (true)']] },
  'omit-operation-pin': { file: 'storage-recovery.ts', edits: [['for (const id of operations) if', 'for (const id of [] as string[]) if']] },
  'skip-input-settlement': { file: 'storage-recovery-sources.ts', edits: [['await store.settlePromptAdmission(current, next)', '/* mutation: acknowledge without original settlement */']] },
  'accept-changed-manifest': { file: 'storage-restore.ts', edits: [["if ((await this.recovery.readManifest(op.generationId, true, new Set(actionable.map(item => JSON.stringify([item.sourceId, item.member.id]))))).hash !== op.manifestHash)", 'if (false)']] },
  'restore-permission-bypass': { file: 'public-rpc-service.ts', edits: [["if (context.transport !== 'unix' || context.principal?.kind !== 'user' || !context.principal.id || context.caller !== undefined || context.routeDelegation !== undefined)", 'if (false)']] },
  'partial-database': { file: 'agent-session-store.ts', edits: [['await backup(db!, file)', "await backup(db!, file); { const { DatabaseSync } = await import('node:sqlite'); const incomplete = new DatabaseSync(file); incomplete.exec('DROP TABLE IF EXISTS preservation_probe'); incomplete.close() }"]] },
  'hold-save-lock': { file: 'agent-session-store.ts', edits: [['finally { await release() }\n    // Do not hold', 'finally {}\n    // Do not hold'], ['finally { db!.close() }', 'finally { db!.close(); await release() }']] },
  'recopy-unrelated': { file: 'storage-recovery.ts', edits: [['if (selected && !selected.has(source.id) && retainedSource)', 'if (false)']] },
  'expire-only-member': { file: 'storage-recovery.ts', edits: [['if (incompleteSources.has(source.id)) for (const member of source.members)', 'if (false) for (const member of source.members)']] },
  'weak-manifest-ack': { file: 'storage-recovery.ts', edits: [["JSON.stringify(manifest) + '\\n', { mode: 0o600, requireDirectorySync: true })\n      const verified", "JSON.stringify(manifest) + '\\n', { mode: 0o600, requireDirectorySync: false })\n      const verified"]] },
  'accept-corrupt-object': { file: 'storage-recovery.ts', edits: [['const path = this.blobPath(member.sha256), before =', 'return; const path = this.blobPath(member.sha256), before =']] },
  'format-rebind': { file: 'agent-session-store.ts', edits: [[" || member.kind !== (member.id === 'database' ? 'session-database' : 'file')", '']] },
  'native-subject-rebind': { file: 'providers/claude-native-catalog.ts', edits: [['original.source.nativeHandle.sessionId !== context.source.nativeSessionId', 'false']] },
  'forget-cohort-frontier': { file: '../../providers/src/grok/native-history.ts', edits: [['if (await observe() !== before)', 'if (false)']] },
  'scan-application-data': { file: 'storage-recovery-sources.ts', edits: [['path !== directory && !selected', 'false']] }
}
if (mutation && !changes[mutation]) throw Error('Unknown backup causal mutation')
export default defineConfig({
  cacheDir: resolve(core, '../../.local/cache/recovery-capture-vite'),
  plugins: [{ name: 'actual-recovery-source', enforce: 'pre',
    resolveId(specifier) { if (specifier === '@agentmux/providers/grok/native-history') return resolve(core, '../providers/src/grok/native-history.ts') },
    transform(source, id) {
    const path = id.split('?')[0]!
    if ((!path.startsWith(resolve(core, 'src') + '/') && path !== resolve(core, '../providers/src/grok/native-history.ts')) || !path.endsWith('.ts')) return
    let code = source
    const change = changes[mutation]
    if (change && path === resolve(core, 'src', change.file)) for (const [before, after] of change.edits) {
      if (code.split(before).length !== 2) throw Error('Backup mutation anchor changed: ' + mutation)
      code = code.replace(before, after)
    }
    const output = process.env.AGENTMUX_BACKUP_SOURCE_LOADS
    if (output) appendFileSync(output, JSON.stringify({ path, diskSHA256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      mutation: source === code ? null : mutation, executedSHA256: createHash('sha256').update(code).digest('hex') }) + '\n', { mode: 0o600 })
    return source === code ? undefined : { code, map: null }
  } }],
  test: { include: [resolve(core, 'test/storage-recovery-capture.test.ts')], environment: 'node', maxWorkers: 1, minWorkers: 1,
    fileParallelism: false, passWithNoTests: false, testTimeout: 20000 }
})
