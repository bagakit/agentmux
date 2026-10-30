import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.publication-isolation.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.DIAGNOSIS_SOURCE_KIND_MUTANT
if (mutation && mutation !== 'omit-original-source') throw Error('Unknown original gap source mutation')
export default defineConfig({ ...original, cacheDir: resolve(root, '.cache/diagnosis-source-kind'),
  plugins: [...original.plugins!, { name: 'actual-public-diagnosis-source-kind', enforce: 'pre', transform(input, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!['packages/core/src/connection-diagnosis.ts', 'packages/core/src/public-rpc-service.ts'].includes(file)) return
    let output = input
    if (mutation && file === 'packages/core/src/connection-diagnosis.ts') {
      const current = 'sourceKind: (gap.source ?? (gap.record ?? gap.part?.record)?.source)?.kind ?? null'
      if (input.split(current).length !== 2) throw Error('Original source projection mutation boundary changed')
      output = input.replace(current, 'sourceKind: gap.source?.kind ?? null')
    }
    const marker = process.env.DIAGNOSIS_SOURCE_KIND_LOADED
    if (!marker) return input === output ? undefined : { code: output, map: null }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = { file, originalSHA256: sha(input), loadedSHA256: sha(output), mutation: output === input ? null : mutation }
    return { code: "import {appendFileSync as __diagnosisSourceKindLoaded} from 'node:fs'; __diagnosisSourceKindLoaded(" + JSON.stringify(marker) + ',' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + output, map: null }
  } }], test: { ...original.test, include: ['packages/connectors/test/connection-diagnosis.test.ts'],
    testNamePattern: 'keeps original gap source kinds|explains source gaps through the real public diagnosis', globalSetup: [], passWithNoTests: false, fileParallelism: false }
})
