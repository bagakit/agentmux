import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import original from './vitest.publication-isolation.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.SOURCE_READ_EVIDENCE_MUTANT
if (mutation && !['current-cut', 'cli-opt-in'].includes(mutation)) throw Error('Unknown source evidence mutation')
export default defineConfig({ ...original, cacheDir: resolve(root, '.cache/publication-source-read-evidence'),
  plugins: [...original.plugins!, { name: 'loaded-source-evidence', enforce: 'pre', transform(input, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!/^packages\/(core|connectors)\/src\/.+\.ts$/u.test(file)) return
    let output = input
    if (mutation === 'current-cut' && file === 'packages/connectors/src/publication-host.ts') {
      const needle = 'const lane = this.lanes.get(binding.bindingId), sourceRead = lane?.binding.revision === binding.revision ? lane.sourceRead : undefined'
      if (input.split(needle).length !== 2) throw Error('Current-cut mutation anchor changed')
      output = input.replace(needle, `const lane = this.lanes.get(binding.bindingId), sourceRead = (() => {
        const original = lane?.binding.revision === binding.revision ? lane.sourceRead : undefined
        if (!original) return
        const checkpoint = this.store.retainedCheckpoint(binding)
        return { observation: { ...original.observation, checkpointKey: checkpoint ? connectionDiagnosisCheckpointKey(checkpoint) : null }, checkpoint }
      })()`)
    }
    const marker = process.env.SOURCE_READ_EVIDENCE_LOADED
    if (!marker) return input === output ? undefined : { code: output, map: null }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = { file, originalSHA256: sha(input), loadedSHA256: sha(output), mutation: output === input ? null : mutation }
    return { code: "import {appendFileSync as __sourceEvidenceLoaded} from 'node:fs'; __sourceEvidenceLoaded(" + JSON.stringify(marker) + ',' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + output, map: null }
  } }], test: { ...original.test, include: ['packages/connectors/test/publication-source-read-evidence.test.ts'], globalSetup: [], passWithNoTests: false, fileParallelism: false }
})
