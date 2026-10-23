import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const variants = {
  'ignore-original-baseline': [
    '        current.document?.revision !== baseline.document?.revision || current.document?.content !== baseline.document?.content ||\n', ''
  ],
  'unknown-file-as-saved': [
    "      return result(saved.result.status === 'unknown' ? 'unconfirmed' : 'refused-before-write', null, saved.result.message)",
    "      return result('saved', moteConnectionBaseline(await this.read(input)), null)"
  ]
} as const
const mutation = process.env.HOST_MOTE_CONNECTION_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown Node Mote owner mutation')
const observed = /^(?:apps\/host\/src\/.+\.(?:mjs|ts)|packages\/connectors\/dist\/mote-connection-operations\.js)$/u
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/mote-connections-consumer', mutation ?? 'normal'),
  plugins: [{ name: 'actual-node-mote-composition', enforce: 'pre',
    transform(original, id) {
      const path = relative(root, id.split('?')[0]!)
      if (!observed.test(path)) return
      let loaded = original
      if (mutation && path === 'apps/host/src/mote-connection-preferences.ts') {
        const [anchor, replacement] = variants[mutation]
        if (original.split(anchor).length !== 2) throw Error('The exact original preference owner mutation must load once')
        loaded = original.replace(anchor, replacement)
      }
      const report = process.env.HOST_MOTE_CONNECTION_LOADED
      if (!report) return loaded === original ? undefined : { code: loaded, map: null }
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      const marker = { path, diskSHA256: createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex'), originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(loaded === original ? {} : { mutation }) }
      return { code: "import { appendFileSync as __hostMoteOwnerLoaded } from 'node:fs'; __hostMoteOwnerLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(marker) + '\n') + ');\n' + loaded, map: null }
    }
  }], test: { include: ['apps/host/test/mote-connections-consumer.test.ts'], setupFiles: [resolve(root, 'vitest.setup.ts')],
    environment: 'node', passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 30_000, hookTimeout: 20_000 } })
