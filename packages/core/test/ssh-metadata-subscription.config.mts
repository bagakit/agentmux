import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.SSH_METADATA_MUTANT, report = process.env.SSH_METADATA_LOADED
if (mutation && mutation !== 'omit-subscription-delegate') throw Error('Unknown SSH metadata mutation')
const observed = /^(?:runtime-client|hosted-client|hosted-runtime-service|public-rpc-client|public-rpc-server|public-rpc-service|rpc-ssh-transport)\.ts$/u
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/ssh-metadata-subscription', mutation ?? 'normal'),
  plugins: [{ name: 'original-ssh-metadata-consumer', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') || !observed.test(path.slice('packages/core/src/'.length))) return
    let loaded = original
    if (mutation && path === 'packages/core/src/runtime-client.ts') {
      const anchor = '      subscribeRpc: (method, params, handlers) => rpc.subscribe(method, params, handlers),\n'
      if (original.split(anchor).length !== 2) throw Error('The exact SSH subscription delegate must load once')
      loaded = original.replace(anchor, '')
    }
    if (!report) return loaded === original ? undefined : { code: loaded, map: null }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const record = { path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(loaded === original ? {} : { mutation }) }
    return { code: "import { appendFileSync as __sshMetadataLoaded } from 'node:fs'; __sshMetadataLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(record) + '\n') + ');\n' + loaded, map: null }
  } }], test: { include: ['packages/core/test/public-rpc-ssh-channel.test.ts'],
    testNamePattern: 'the SSH Hosted client consumes exact metadata hints', setupFiles: [resolve(root, 'vitest.setup.ts')],
    environment: 'node', passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 20_000, hookTimeout: 15_000 } })
