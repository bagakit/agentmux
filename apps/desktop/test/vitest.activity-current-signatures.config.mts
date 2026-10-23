import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.conversation-unified-consumers.config.mts'
import { candidateAlias, candidateModule } from '../scripts/candidate-package-resolve.mjs'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...base, root, cacheDir: resolve(root, '.cache/activity-current-signatures'),
  resolve: { ...base.resolve, alias: [candidateAlias(root, { source: true, browser: true }),
    ...(Array.isArray(base.resolve?.alias) ? base.resolve.alias : [])] },
  plugins: [...base.plugins ?? [], { name: 'current-activity-source-inputs', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!isAbsolute(file)) return
    const actual = candidateModule(root, file)
    if (!actual.startsWith(root + '/') || actual.includes('/node_modules/')) return
    if (process.env.AGENTMUX_ACTIVITY_TYPES_LOADED) {
      const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_ACTIVITY_TYPES_LOADED, JSON.stringify({ path: relative(root, actual),
        fileSHA256: sha(readFileSync(actual)), originalSHA256: sha(source), loadedSHA256: sha(source) }) + '\n')
    }
  // A runtime consumer may reach Activity through production SessionPane without
  // sharing its Props signature. Runtime commands select their exact files;
  // the independent type checker keeps its bounded direct/helper caller roots.
  } }], test: { ...base.test, include: ['apps/desktop/test/**/*.{test,spec}.?(c|m)[jt]s?(x)',
    'packages/client-ui/test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
