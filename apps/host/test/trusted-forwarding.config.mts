import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const coreRequire = createRequire(resolve(root, 'packages/core/package.json'))
const variants = {
  'host-identity': ['apps/host/src/host.ts', "...(context.principal?.kind === 'device' ? { forwarding: context.forwarding! } : {})", '...{}'],
  'receiver-identity': ['packages/core/src/rpc-forwarding.ts', 'const actor = principal(claimed.principal)', "const actor = { kind: 'user' as const, id: 'local-user:mutation' }"],
  'request-binding': ['packages/core/src/rpc-forwarding.ts', 'grant.fingerprint !== p.fingerprint', 'false'],
  'destination-binding': ['packages/core/src/rpc-forwarding.ts', 'grant.destination !== p.destinationInstanceId', 'false'],
  'single-claim': ['packages/core/src/rpc-forwarding.ts', '!grant || grant.claimed ||', '!grant ||'],
  'reader-authority': ['packages/core/src/rpc-forwarding.ts', '// This is current *authorization*, independently of the original reader.', 'grant.context.signal?.throwIfAborted()'],
  'return-authority': ['apps/host/src/host.ts', '? await (await authorityReady).bindForwardedDevice(principal) : undefined', '? undefined : undefined'],
  'return-identity': ['apps/desktop/src/main/desktop-host.ts', "...(context.principal?.kind === 'device' ? { forwarding: context.forwarding! } : {})", '...{}'],
  'ssh-device-authority': ['packages/core/src/runtime-client.ts', "context.principal?.kind === 'device' && !context.forwarding", 'false'],
  'ssh-device-forwarding': ['packages/core/src/runtime-client.ts', "...(context.principal?.kind === 'device' ? { forwarding: context.forwarding! } : {})", '...{}']
} as const
const mutation = process.env.AGENTMUX_FORWARDING_MUTATION as keyof typeof variants | undefined
const report = process.env.AGENTMUX_FORWARDING_LOADED
if (mutation && !variants[mutation]) throw Error('Unknown trusted forwarding mutation')
function sourceEntry(source: string) {
  const matched = source.match(/^@agentmux\/(core|host|client-ui)(?:\/(.*))?$/u)
  if (!matched) return
  const directory = matched[1] === 'host' ? 'apps/host' : 'packages/' + matched[1]
  const exports = JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8')).exports
  const key = matched[2] ? './' + matched[2] : '.'
  const wildcard = Object.keys(exports).filter(value => value.endsWith('*') && key.startsWith(value.slice(0, -1))).sort((a, b) => b.length - a.length)[0]
  const entry = exports[key] ?? (wildcard ? exports[wildcard] : undefined)
  let path = entry?.types ?? entry?.import
  if (typeof path !== 'string') return
  if (wildcard && !exports[key]) path = path.replace('*', key.slice(wildcard.length - 1))
  path = path.replace(/^\.\/dist\//u, './src/').replace(/\.d\.ts$/u, '.ts').replace(/\.js$/u, '.ts')
  return resolve(root, directory, path)
}

export default defineConfig({ root, cacheDir: resolve(root, '.tmp/trusted-forwarding', mutation ?? 'normal'),
  plugins: [{ name: 'trusted-forwarding-actual-source', enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'json-rpc-2.0') return coreRequire.resolve(source)
      const entry = sourceEntry(source); if (entry) return entry
      if (!importer || !source.startsWith('.')) return
      const dist = resolve(dirname(importer), source).match(/\/packages\/core\/dist\/(.+)\.js$/u)
      if (dist) return resolve(root, 'packages/core/src', dist[1]! + '.ts')
    },
    transform(original, id) {
      const path = relative(root, id.split('?')[0]!)
      if (!/^(?:packages\/core|apps\/(?:host|desktop))\/src\/.+\.ts$/u.test(path)) return
      const selected = mutation && variants[mutation]
      let code = original
      if (selected && path === selected[0]) {
        if (original.split(selected[1]).length !== 2) throw Error('Trusted forwarding mutation must match one original expression')
        code = original.replace(selected[1], selected[2])
      }
      if (!report) return code === original ? undefined : { code, map: null }
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = { path, originalSHA256: sha(original), servedSHA256: sha(code), ...(code === original ? {} : { mutation }) }
      return { code: "import { appendFileSync as __forwardingLoaded } from 'node:fs'; __forwardingLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + code, map: null }
    }
  }], test: { include: ['apps/host/test/trusted-forwarding.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], environment: 'node', passWithNoTests: false,
    fileParallelism: false, maxWorkers: 1, testTimeout: 15_000, hookTimeout: 20_000 }
})
