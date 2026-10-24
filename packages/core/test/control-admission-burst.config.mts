import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
const root = resolve(import.meta.dirname, '../../..')
const alias: Record<string, string> = {}
for (const name of readdirSync(resolve(root, 'packages'))) {
  const dir = resolve(root, 'packages', name), manifest = resolve(dir, 'package.json')
  if (!existsSync(manifest)) continue
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const entry = typeof value === 'string' ? value : (value as any)?.import
    if (typeof entry !== 'string' || !entry.startsWith('./dist/')) continue
    const source = resolve(dir, entry.replace(/^\.\/dist\/(?:src\/)?/, './src/').replace(/\.js$/, '.ts'))
    if (existsSync(source)) alias[key === '.' ? pkg.name : pkg.name + key.slice(1)] = source
  }
}
const mutation = process.env.CONTROL_ADMISSION_MUTANT
const rewrites: Record<string, { file: string; from: string; to: string }> = {
  'per-reader-unix': { file: 'public-rpc-client.ts', from: "} else if (route.endpoint.transport === 'unix' && !(options.forwarding ?? this.forwarding)) {", to: "} else if (false && route.endpoint.transport === 'unix' && !(options.forwarding ?? this.forwarding)) {" },
  'cancel-peers': { file: 'rpc-stream-transport.ts', from: 'if (disposed) return; disposed = true;', to: 'if (disposed) return; this.carrier.close(); disposed = true;' },
  'wrong-subscription': { file: 'rpc-stream-transport.ts', from: 'this.subscriptions.get(id)?.receive(frame)', to: 'this.subscriptions.values().next().value?.receive(frame)' },
  'replay-unknown': { file: 'public-rpc-client.ts', from: 'if (!responseDelivered) {', to: "if (!responseDelivered) { if (method === 'space.focus') void this.call(method, params).catch(() => {});" }
}
const sourceHash = (source: string) => createHash('sha256').update(source).digest('hex')
const ownTests = 'packages/core/test/control-admission-burst.test.ts'
export default defineConfig({ root, resolve: { alias: Object.entries(alias).map(([find, replacement]) => ({ find: new RegExp('^' + find + '$'), replacement })) },
  plugins: [{ name: 'source-bound-control-admission', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/')) return
    let loaded = original
    const edit = mutation ? rewrites[mutation] : undefined
    if (edit && path === 'packages/core/src/' + edit.file) {
      if (original.split(edit.from).length !== 2) throw Error('Unique actual source mutation anchor required: ' + mutation)
      loaded = original.replace(edit.from, edit.to)
    }
    const output = process.env.CONTROL_ADMISSION_LOADED
    if (output) {
      appendFileSync(output, JSON.stringify({ path, originalSHA256: sourceHash(original), loadedSHA256: sourceHash(loaded), ...(loaded === original ? {} : { mutation }) }) + '\n')
    }
    return loaded === original ? undefined : { code: loaded, map: null }
  } }], test: { include: mutation ? [ownTests] : [ownTests, 'packages/core/test/rpc-ssh-transport.test.ts',
    'packages/core/test/control-endpoint-socket-handoff.test.ts', 'packages/core/test/control-endpoint-publication.test.ts', 'packages/core/test/public-rpc-ssh-channel.test.ts'],
    ...(process.env.CONTROL_ADMISSION_CASE ? { testNamePattern: process.env.CONTROL_ADMISSION_CASE } : {}),
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false, hookTimeout: 20000 } })
