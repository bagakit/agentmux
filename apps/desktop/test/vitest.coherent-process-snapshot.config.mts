import { defineConfig } from 'vitest/config'
import publicSources from './vitest.mote-context.config.mts'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
const repository = resolve(import.meta.dirname, '../../..')
if (process.platform !== 'darwin') throw Error('The coherent process consumer gate requires actual macOS kernel observations')
export default defineConfig({
  resolve: publicSources.resolve, ssr: publicSources.ssr,
  plugins: [{ name: 'coherent-process-consumer', enforce: 'pre', transform(source, id) {
    const file = relative(repository, id.split('?')[0]!)
    if (file !== 'apps/desktop/scripts/package-process-scope.mjs') return
    const originalSHA256 = createHash('sha256').update(source).digest('hex')
    const mutant = process.env.COHERENT_PROCESS_MUTANT
    const anchors = {
      'ignore-unknown': ["currentAdmissions.filter(row => row.classification !== 'external')", "currentAdmissions.filter(row => row.classification === 'gui')"],
      'global-tail': ['const observed = fence.size ? processRows(await processSnapshot([...fence]), true).filter(row => fence.has(row.pid)) : []', 'const observed = processRows(await processSnapshot())'],
      'drop-cut-births': ['const merged = rows.flatMap(row => fence.has(row.pid) ? current.has(row.pid) ? [current.get(row.pid)] : [] : [row])', 'const merged = rows.flatMap(row => fence.has(row.pid) ? current.has(row.pid) ? [current.get(row.pid)] : [] : [])'],
      'skip-late-modes': ['const nodeModes = await modes(selected.map(row => row.pid))', 'const nodeModes = []'],
      'ignore-ancestor-drift': ['if (unconfirmedAncestors.has(parent.pid)) uncertain = true', '/* mutant discards ancestor generation drift */'],
      'stale-fence': ['const scope = snapshot(text, nodeModes, admitted.admissions, unconfirmedAncestors)', 'const scope = snapshot(cut, nodeModes, admitted.admissions)']
    }
    if (mutant) {
      const pair = anchors[mutant as keyof typeof anchors]
      if (!pair || source.split(pair[0]!).length !== 2) throw Error('Choose one exact coherent snapshot mutation')
      source = source.replace(pair[0]!, pair[1]!)
    }
    const loadedSHA256 = createHash('sha256').update(source).digest('hex'), output = process.env.COHERENT_PROCESS_LOADED
    if (output) {
      const receipt = { file, originalSHA256, loadedSHA256, ...(mutant ? { mutant } : {}) }
      source = "import { appendFileSync as __coherentLoaded } from 'node:fs'; __coherentLoaded(" + JSON.stringify(output) + ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n' + source
    }
    return { code: source, map: null }
  } }],
  test: { include: ['apps/desktop/test/package-process-scope.test.ts', 'apps/desktop/test/package-coherent-process-snapshot.test.ts', 'apps/desktop/test/installer-activation-diagnostics.test.ts'], environment: 'node',
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 40_000 }
})
