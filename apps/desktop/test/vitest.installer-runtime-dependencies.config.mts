import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ root,
  plugins: [{ name: 'installer-runtime-original-consumers', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!['apps/desktop/scripts/package-process-scope.mjs', 'apps/desktop/scripts/package-runtime-upgrade.mjs'].includes(file)) return
    const originalSHA256 = createHash('sha256').update(source).digest('hex')
    const mutant = process.env.INSTALLER_OWNER_MUTANT
    if (mutant && file.endsWith('/package-runtime-upgrade.mjs')) {
      if (mutant !== 'trust-reader-output') throw Error('Unknown original installer owner mutation.')
      const anchor = 'if (!reader.exitConfirmed || reader.code !== 0 || reader.signal !== null || reader.interruption !== null || reader.errors.length)'
      if (source.split(anchor).length !== 2) throw Error('Original reader completion guard is not unique.')
      source = source.replace(anchor, 'if (false)')
    }
    const receipt = { file, pid: process.pid, originalSHA256, loadedSHA256: createHash('sha256').update(source).digest('hex'), mutant: mutant ?? null }
    const output = process.env.INSTALLER_NATIVE_LOADED
    if (output) source = "import{appendFileSync as __installerLoaded}from'node:fs';__installerLoaded(" + JSON.stringify(output) + ',' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n' + source
    return { code: source, map: null }
  } }],
  test: { include: process.env.INSTALLER_RUNTIME_UNIT_ONLY
      ? ['apps/desktop/test/package-runtime-upgrade-owner.test.ts', 'apps/desktop/test/package-process-scope.test.ts',
        'apps/desktop/test/package-process-title.test.ts', 'apps/desktop/test/package-process-slow-probe.test.ts']
      : ['apps/desktop/test/package-installer-runtime-dependencies.test.ts'],
    environment: 'node', maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 60_000,
    globalSetup: [], setupFiles: [] }
})
