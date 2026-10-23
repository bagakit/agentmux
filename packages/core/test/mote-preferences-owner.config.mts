import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.MOTE_PREFERENCES_OWNER_MUTANT
const report = process.env.MOTE_PREFERENCES_OWNER_LOADED
if (mutation && mutation !== 'omit-owner-dispatch') throw Error('Unknown Mote preference owner mutation')
const exports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
const observed = new Set(['public-rpc-service', 'mote-preferences', 'public-rpc-server', 'public-rpc-client',
  'public-rpc-wire', 'client', 'agent-capability', 'agent-session-store', 'hosted-runtime-service'])

export default defineConfig({ root, cacheDir: resolve(root, '.tmp/mote-preferences-owner', mutation ?? 'normal'),
  plugins: [{ name: 'mote-preferences-original-owner', enforce: 'pre',
    resolveId(source) {
      if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
      if (source.startsWith('@agentmux/core/')) {
        const entry = exports['./' + source.slice('@agentmux/core/'.length)]?.import
        if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice(7).replace(/\.js$/u, '.ts'))
      }
    },
    transform(original, id) {
      const path = relative(root, id.split('?')[0]!)
      const match = /^packages\/core\/src\/([^/]+)\.ts$/u.exec(path)
      if (!match || !observed.has(match[1]!)) return
      let loaded = original
      if (mutation && path === 'packages/core/src/public-rpc-service.ts') {
        const anchor = "if (this.ports.motePreferences && p.kind === 'connection' &&"
        if (original.split(anchor).length !== 2) throw Error('The exact narrow preference dispatch must load once')
        loaded = original.replace(anchor, "if (false && this.ports.motePreferences && p.kind === 'connection' &&")
      }
      if (!report) return loaded === original ? undefined : { code: loaded, map: null }
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      const record = { path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(loaded === original ? {} : { mutation }) }
      // Execute the record inside the actual loaded module, not only its transform.
      return { code: "import { appendFileSync as __motePreferenceLoaded } from 'node:fs'; __motePreferenceLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(record) + '\n') + ');\n' + loaded, map: null }
    }
  }], test: { include: ['packages/core/test/mote-preferences-owner.test.ts'], environment: 'node',
    setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false, fileParallelism: false,
    maxWorkers: 1, testTimeout: 15_000, hookTimeout: 15_000 } })
