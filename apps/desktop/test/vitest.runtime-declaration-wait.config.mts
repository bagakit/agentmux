import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const repository = resolve(import.meta.dirname, '../../..')
export default defineConfig({
  plugins: [{ name: 'runtime-declaration-selected-owner', enforce: 'pre', transform(source, id) {
    const file = relative(repository, id.split('?')[0]!)
    if (file !== 'apps/desktop/scripts/package-runtime-upgrade.mjs') return
    const originalSHA256 = createHash('sha256').update(source).digest('hex')
    const mutant = process.env.RUNTIME_DECLARATION_MUTANT
    if (mutant) {
      if (mutant !== 'ten-second-query-kill') throw Error('Select the exact declaration query mutation')
      const anchor = "const response = await exec(selected.daemonPath, ['--version'], { maxBuffer: 4096 })"
      if (source.split(anchor).length !== 2) throw Error('The declaration timeout mutation needs one exact owner anchor')
      source = source.replace(anchor, "const response = await exec(selected.daemonPath, ['--version'], { timeout: 10_000, maxBuffer: 4096 })")
    }
    const loadedSHA256 = createHash('sha256').update(source).digest('hex'), report = process.env.RUNTIME_DECLARATION_LOADED
    if (report) {
      const receipt = { file, pid: process.pid, originalSHA256, loadedSHA256, ...(mutant ? { mutant } : {}) }
      source = "import { appendFileSync as __declarationLoaded } from 'node:fs'; __declarationLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n' + source
    }
    return { code: source, map: null }
  } }],
  test: { include: ['apps/desktop/test/package-runtime-upgrade-owner.test.ts'], environment: 'node', passWithNoTests: false,
    maxWorkers: 1, fileParallelism: false, testTimeout: 30_000 }
})
