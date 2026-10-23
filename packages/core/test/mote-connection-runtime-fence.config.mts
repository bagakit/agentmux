import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.MOTE_PARENT_FENCE_MUTANT
const report = process.env.MOTE_PARENT_FENCE_LOADED
if (mutation && !['omit-initial-fence', 'omit-effect-fence'].includes(mutation)) throw Error('Unknown Mote parent fence mutation')
const exports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
const observed = new Set(['public-rpc-service', 'mote-connection-codec', 'public-rpc-server', 'public-rpc-client',
  'public-rpc-wire', 'client', 'hosted-runtime-service'])

export default defineConfig({ root, cacheDir: resolve(root, '.tmp/mote-parent-fence', mutation ?? 'normal'),
  plugins: [{ name: 'original-mote-parent-runtime-fence', enforce: 'pre',
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
        const start = original.indexOf('    if (isMoteConnectionMethod(method)) {')
        const end = original.indexOf('    if (isConnectionMethod(method)) {', start)
        if (start < 0 || end < start) throw Error('Original Mote parent branch must load')
        let branch = original.slice(start, end)
        const anchor = mutation === 'omit-initial-fence'
          ? '      await this.assertRuntimeFence(context)\n'
          : ' await this.assertRuntimeFence(context);'
        if (branch.split(anchor).length !== 2) throw Error('The exact parent fence must load once')
        branch = branch.replace(anchor, '')
        loaded = original.slice(0, start) + branch + original.slice(end)
      }
      if (!report) return loaded === original ? undefined : { code: loaded, map: null }
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      const record = { path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(loaded === original ? {} : { mutation }) }
      return { code: "import { appendFileSync as __moteParentFenceLoaded } from 'node:fs'; __moteParentFenceLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(record) + '\n') + ');\n' + loaded, map: null }
    }
  }], test: { include: ['packages/core/test/mote-connection-runtime-fence.test.ts'], environment: 'node',
    setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false, fileParallelism: false,
    maxWorkers: 1, testTimeout: 15_000, hookTimeout: 15_000 } })
