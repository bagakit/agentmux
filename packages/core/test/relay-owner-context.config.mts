import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_RELAY_OWNER_MUTATION
const report = process.env.AGENTMUX_RELAY_OWNER_LOADED
if (mutation && mutation !== 'drop-relay-owner-fence') throw Error('Unknown relay owner mutation')
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/relay-owner-context', mutation ?? 'normal'),
  plugins: [{ name: 'relay-owner-actual-source', enforce: 'pre',
    resolveId(source) {
      if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
      if (source.startsWith('@agentmux/core/')) {
        const entry = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports['./' + source.slice('@agentmux/core/'.length)]?.import
        if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice(7).replace(/\.js$/u, '.ts'))
      }
      if (source === '@agentmux/connectors') return resolve(root, 'packages/connectors/src/index.ts')
      if (source === '@agentmux/relay/e2ee') return resolve(root, 'packages/relay/src/e2ee.ts')
      if (source === '@agentmux/relay/endpoint') return resolve(root, 'packages/relay/src/daemon-endpoints.ts')
      if (source === '@agentmux/relay/offer') return resolve(root, 'packages/relay/src/connection-offer.ts')
    },
    transform(original, id) {
      const path = relative(root, id.split('?')[0]!)
      if (!/^(packages\/(core|connectors|relay)|apps\/host)\/src\/.+\.ts$/u.test(path)) return
      let code = original
      if (mutation && path === 'packages/core/src/relay-hosted.ts') {
        const anchor = '...(runtimeFence ? { runtimeFence } : {})'
        if (code.split(anchor).length !== 2) throw Error('Relay owner mutation must hit exactly one wire field')
        code = code.replace(anchor, '...{}')
      }
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      if (report) appendFileSync(report, JSON.stringify({ path, originalSHA256: hash(original), servedSHA256: hash(code),
        ...(code === original ? {} : { mutation }) }) + '\n')
      return code === original ? undefined : { code, map: null }
    }
  }], test: { include: ['packages/core/test/relay-owner-context.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], environment: 'node', passWithNoTests: false,
    fileParallelism: false, maxWorkers: 1, testTimeout: 20_000, hookTimeout: 15_000 } })
