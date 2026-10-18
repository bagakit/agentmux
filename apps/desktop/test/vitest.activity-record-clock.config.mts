import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.conversation-unified-consumers.config.mts'
import { candidateAlias, candidateModule } from '../scripts/candidate-package-resolve.mjs'

const root = resolve(import.meta.dirname, '../../..')
const owner = 'packages/client-ui/src/components/NativeProcessObservation.tsx'
const mutation = process.env.AGENTMUX_RECORDED_TIME_MUTATION ?? ''
const changes: Record<string, readonly [string, string]> = {
  'native-only-time': ['const recordedTime = groupRecordTime(records)', "const recordedTime = nativeOnly ? groupRecordTime(records) : undefined"],
  'last-member-time': ['last = Math.max(last, to)', 'last = to']
}
export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/activity-record-clock'),
  resolve: { ...base.resolve, alias: [candidateAlias(root, { source: true, browser: true }),
    ...(Array.isArray(base.resolve?.alias) ? base.resolve.alias : [])] },
  plugins: [...base.plugins ?? [], { name: 'original-recorded-time-owner', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!isAbsolute(file)) return
    const actual = candidateModule(root, file), path = relative(root, actual)
    if (!actual.startsWith(root + '/') || actual.includes('/node_modules/')) return
    let loaded = source, applied: string | null = null
    if (path === owner && mutation) {
      const change = changes[mutation]
      if (!change || source.split(change[0]).length !== 2) throw new Error('Missing exact original recorded-time mutation: ' + mutation)
      loaded = source.replace(change[0], change[1]); applied = mutation
    }
    if (process.env.AGENTMUX_RECORDED_TIME_LOADED) {
      const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_RECORDED_TIME_LOADED, JSON.stringify({ path,
        fileSHA256: sha(readFileSync(actual)), originalSHA256: sha(source), loadedSHA256: sha(loaded), mutation: applied }) + '\n')
    }
    return loaded
  } }], test: { ...base.test, fileParallelism: false, maxWorkers: 1, passWithNoTests: false,
    include: ['apps/desktop/test/activity-record-clock.integration.test.tsx', 'apps/desktop/test/conversation-source-disclosure.test.tsx'] }
})
