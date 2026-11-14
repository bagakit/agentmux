import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import base from './vitest.mote-context.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_BOOTSTRAP_MUTATION
const edits: Record<string, [string, string, string]> = {
  'main-load-before-recovery': ['apps/desktop/src/main/index.ts', '    await recoverWorkbench()', '    void recoverWorkbench()'],
  'main-load-before-identity': ['apps/desktop/src/main/index.ts', '    await runtimeIdentityRecovery.check()', '    void runtimeIdentityRecovery.check()'],
  'accept-wrong-runtime-binding': ['packages/core/src/semantic-runtime-identity.ts', 'value.authority !== authority', 'false'],
  'select-only-newest-identity-backup': ['packages/core/src/storage-recovery-maintenance.ts', 'of await owner.recovery.list()', 'of (await owner.recovery.list()).slice(0, 1)'],
  'reuse-completed-identity-receipt': ['packages/core/src/storage-recovery-maintenance.ts', "prior?.state === 'complete'; attempt++", 'false; attempt++'],
  'skip-missing-originals': ['apps/desktop/src/main/workbench-recovery-bootstrap.ts', "if (!absent.length) return { state: 'unchanged' }", "if (true) return { state: 'unchanged' }"],
  'unknown-default-write': ['apps/desktop/src/main/workbench-recovery-bootstrap.ts', 'options.user.retainRecoveryGaps(', 'options.user.observe('],
  'disconnect-host-source': ['apps/host/src/host.ts', "recoverySources: [createDesktopStorageRecoverySource(() => desktopClient({ transport: 'unix' }))],", 'recoverySources: [],']
}
if (mutation && !edits[mutation]) throw Error('Unknown bootstrap mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/workbench-recovery-bootstrap'),
  plugins: [...base.plugins ?? [], { name: 'bootstrap-actual-owner-source-proof', enforce: 'pre', transform(source, id) {
    const path = id.split('?')[0]!, output = process.env.AGENTMUX_BOOTSTRAP_SOURCE_PROOF, edit = mutation && edits[mutation]
    let code = source
    if (edit && path === resolve(root, edit[0])) {
      if (!code.includes(edit[1])) throw Error('Missing exact bootstrap mutation anchor')
      code = code.replace(edit[1], edit[2])
    }
    if (output && (path.startsWith(root + '/apps/') || path.startsWith(root + '/packages/core/src/'))) appendFileSync(output,
      JSON.stringify({ path,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), compiledSHA256: createHash('sha256').update(code).digest('hex'), mutation: code === source ? null : mutation }) + '\n', { mode: 0o600 })
    return code === source ? undefined : { code, map: null }
  } }], test: { ...base.test, include: ['apps/desktop/test/workbench-recovery-bootstrap.test.ts'],
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 40_000 }
})
