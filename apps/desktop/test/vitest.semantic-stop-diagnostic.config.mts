import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const repository = resolve(import.meta.dirname, '../../..')
export default defineConfig({
  plugins: [{ name: 'semantic-stop-selected-owners', enforce: 'pre', transform(source, id) {
    const file = relative(repository, id.split('?')[0]!)
    if (!['package-semantic-host.mjs', 'package-process-scope.mjs', 'package-macos.mjs']
      .some(name => file === `apps/desktop/scripts/${name}`)) return
    const originalSHA256 = createHash('sha256').update(source).digest('hex')
    const mutant = process.env.SEMANTIC_STOP_MUTANT
    if (mutant && file === 'apps/desktop/scripts/package-semantic-host.mjs') {
      if (mutant !== 'drop-stop-diagnostic') throw Error('Select the exact Semantic Host stop diagnostic mutation')
      const anchor = '  { ownershipDiagnostic: {\n'
      if (source.split(anchor).length !== 2) throw Error('The stop diagnostic mutation requires one exact owner anchor')
      source = source.replace(anchor, '  { suppressedOwnershipDiagnostic: {\n')
    }
    const loadedSHA256 = createHash('sha256').update(source).digest('hex'), report = process.env.SEMANTIC_STOP_LOADED
    if (report) {
      const receipt = { file, pid: process.pid, originalSHA256, loadedSHA256,
        ...(mutant && file.endsWith('/package-semantic-host.mjs') ? { mutant } : {}) }
      source = "import { appendFileSync as __semanticStopLoaded } from 'node:fs'; __semanticStopLoaded(" + JSON.stringify(report) +
        ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n' + source
    }
    return { code: source, map: null }
  } }],
  test: { include: ['apps/desktop/test/package-install-semantic-quit.test.ts', 'apps/desktop/test/package-semantic-host-reload.test.ts'],
    environment: 'node', passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 30_000 }
})
