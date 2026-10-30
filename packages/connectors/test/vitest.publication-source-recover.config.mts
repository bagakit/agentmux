import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import original from './vitest.publication-isolation.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.PUBLICATION_SOURCE_RECOVER_MUTANT
const changes = {
  'no-wake': ['if (!lane.work) this.wake(lane)', 'if (false) this.wake(lane)'],
  'wrong-scope': ['const binding = readRoomPublicationBinding(this.options.bindings, requested)', 'const binding = requested']
} as const
if (mutation && !(mutation in changes)) throw Error('Unknown source recover mutation')
export default defineConfig({ ...original, cacheDir: resolve(root, '.cache/publication-source-recover'),
  plugins: [...original.plugins!, { name: 'actual-original-source-recover', enforce: 'pre', transform(input, id) {
    const file = relative(root, id.split('?')[0]!), selected = mutation && changes[mutation as keyof typeof changes]
    if (!['packages/connectors/src/publication-host.ts', 'packages/connectors/src/connection-services.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/connection-delivery-codec.ts'].includes(file)) return
    let output = input
    if (selected && file === 'packages/connectors/src/publication-host.ts') {
      if (input.split(selected[0]).length !== 2) throw Error('Source recovery mutation boundary changed')
      output = input.replace(selected[0], selected[1])
    }
    const marker = process.env.PUBLICATION_SOURCE_RECOVER_LOADED
    if (!marker) return input === output ? undefined : { code: output, map: null }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = { file, originalSHA256: sha(input), loadedSHA256: sha(output), mutation: output === input ? null : mutation }
    return { code: "import {appendFileSync as __sourceRecoverLoaded} from 'node:fs'; __sourceRecoverLoaded(" + JSON.stringify(marker) + ',' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + output, map: null }
  } }], test: { ...original.test, include: ['packages/connectors/test/publication-source-recover-consumer.test.ts'], globalSetup: [], passWithNoTests: false, fileParallelism: false }
})
