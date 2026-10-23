import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.HOST_SPATIAL_MUTANT, report = process.env.HOST_SPATIAL_LOADED
if (mutation && mutation !== 'desktop-before-spatial') throw Error('Unknown spatial owner mutation')
const manifest = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
const observed = /^(?:apps\/host\/src\/(?:host|connections)\.ts|packages\/core\/src\/(?:public-rpc-service|public-rpc-server|public-rpc-client|rpc-business-codec|space-control-parser|spatial-state|spatial-graph|headless-runtime)\.ts)$/u
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/host-spatial-catalog', mutation ?? 'normal'),
  plugins: [{ name: 'actual-headless-spatial-owner', enforce: 'pre',
    resolveId(source) {
      if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
      if (source === '@agentmux/connectors') return resolve(root, 'packages/connectors/src/index.ts')
      if (source.startsWith('@agentmux/core/')) {
        const entry = manifest['./' + source.slice('@agentmux/core/'.length)]?.import
        if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice(7).replace(/\.js$/u, '.ts'))
      }
    },
    transform(original, id) {
      const path = relative(root, id.split('?')[0]!)
      if (!observed.test(path)) return
      let loaded = original
      if (mutation && path === 'packages/core/src/public-rpc-service.ts') {
        const anchor = '      if (this.ports.spatialState && !this.ports.execute &&\n'
        if (original.split(anchor).length !== 2) throw Error('The exact Headless spatial route must load once')
        loaded = original.replace(anchor, '      if (false && this.ports.spatialState && !this.ports.execute &&\n')
      }
      if (!report) return loaded === original ? undefined : { code: loaded, map: null }
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      const record = { path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(loaded === original ? {} : { mutation }) }
      return { code: "import { appendFileSync as __hostSpatialLoaded } from 'node:fs'; __hostSpatialLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(record) + '\n') + ');\n' + loaded, map: null }
    }
  }], test: { include: ['apps/host/test/spatial-catalog-consumer.test.ts'], setupFiles: [resolve(root, 'vitest.setup.ts')],
    environment: 'node', passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 20_000, hookTimeout: 15_000 } })
