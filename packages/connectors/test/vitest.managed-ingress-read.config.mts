import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, relative, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import original from './vitest.feishu-question-card.config.mts'

const sources = ['packages/core/src/public-rpc-service.ts', 'packages/core/src/connection-agent-access.ts', 'packages/core/src/ingress-contract.ts',
  'packages/connectors/src/durable-ingress.ts', 'packages/connectors/src/connection-services.ts', 'apps/host/src/connections.ts',
  'packages/connectors/test/managed-ingress-read.test.ts']
const baseline = ['packages/connectors/src/adapters/feishu/question-card.ts', 'packages/connectors/src/adapters/feishu/action.ts',
  'packages/connectors/src/adapters/feishu/index.ts', 'packages/connectors/test/fixtures/permission-actions.ts']
export default defineConfig({ ...original, cacheDir: '.cache/managed-ingress-read', plugins: [{
  name: 'managed-ingress-runtime-source', enforce: 'pre', resolveId(source, importer) {
    // Preserve the actual Host connection owner while reusing unrelated compiled Host leaves.
    const host = source.startsWith('@agentmux/host/') ? resolve(original.root!, 'apps/host/src', source.slice('@agentmux/host/'.length) + '.ts')
      : importer && source.startsWith('.') ? resolve(dirname(importer), source) : source.startsWith('/') ? source : undefined
    const native = host?.match(/\/apps\/host\/(?:src|dist)\/(.+)\.mjs$/u)
    if (native) return resolve(original.root!, 'apps/host/src', native[1]! + '.mjs')
    const match = host?.match(/\/apps\/host\/(src|dist)\/(.+)\.(?:ts|js)$/u)
    if (match) {
      if (match[2] === 'connections') return resolve(original.root!, 'apps/host/src/connections.ts')
      const built = resolve(original.root!, 'apps/host/dist', match[2]! + '.js')
      if (existsSync(built)) return built
    }
    if (source.startsWith('@agentmux/client-ui/')) {
      const key = './' + source.slice('@agentmux/client-ui/'.length)
      const entries = JSON.parse(readFileSync(resolve(original.root!, 'packages/client-ui/package.json'), 'utf8')).exports
      const wildcard = Object.keys(entries).filter(name => name.includes('*') && key.startsWith(name.split('*')[0]!) && key.endsWith(name.split('*')[1]!)).sort((a, b) => b.length - a.length)[0]
      const entry = entries[key] ?? entries[wildcard!], file = entry?.import
      if (file) return resolve(original.root!, 'packages/client-ui', wildcard && !entries[key] ? file.replace('*', key.slice(wildcard.split('*')[0]!.length, key.length - wildcard.split('*')[1]!.length)) : file)
    }
  }, transform(source, id) {
    const path = relative(original.root!, id.split('?')[0]!)
    if (!sources.includes(path) && !baseline.includes(path)) return
    const baselineRef = baseline.includes(path) ? process.env.INGRESS_READ_BASELINE_REF : undefined
    let loaded = baselineRef ? execFileSync('git', ['show', `${baselineRef}:${path}`], { cwd: original.root, encoding: 'utf8' }) : source
    const mutant = process.env.INGRESS_READ_MUTANT
    if (mutant && !['remove-managed-reader', 'audience-overrides-foreign'].includes(mutant)) throw Error('Unknown ingress read mutation')
    let mutation: string | undefined
    const change = mutant === 'remove-managed-reader' && path === sources[0]
      ? ["if (caller && method === 'connection.ingress.inspect')", "if (false && caller && method === 'connection.ingress.inspect')"]
      : mutant === 'audience-overrides-foreign' && path === sources[1]
        ? ['    if (frozen.length) {', `    if (frozen.length && !frozen.every(self)) {
      const current = await owner.bindings!.list({ executionHostId: session.hostId, agentSessionId: session.agentSessionId })
      if (current.bindings.some(binding => self({ hostId: binding.executionHostId, agentSessionId: binding.agentSessionId }) && audience(binding, record))) return
    }
    if (frozen.length) {`] : undefined
    if (change) {
      if (loaded.split(change[0]!).length !== 2) throw Error('Exact ingress read mutation must load once')
      loaded = loaded.replace(change[0]!, change[1]!); mutation = mutant
    }
    if (process.env.INGRESS_READ_LOADED) {
      const hash = (s: string) => createHash('sha256').update(s).digest('hex')
      const row = { path, originalSHA256: hash(source), loadedSHA256: hash(loaded), ...(baselineRef ? { baselineRef } : {}), ...(mutation ? { mutation } : {}) }
      loaded = "import { appendFileSync as __ingressReadLoaded } from 'node:fs'; __ingressReadLoaded(" + JSON.stringify(process.env.INGRESS_READ_LOADED) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + loaded
    }
    return loaded === source ? undefined : { code: loaded, map: null }
  }
}, ...original.plugins!], test: { ...original.test, include: ['packages/connectors/test/managed-ingress-read.test.ts'],
  ...(process.env.INGRESS_READ_CASE ? { testNamePattern: process.env.INGRESS_READ_CASE } : {}), fileParallelism: false, passWithNoTests: false } })
