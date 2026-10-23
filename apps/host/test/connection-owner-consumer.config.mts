import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const connectorRequire = createRequire(resolve(root, 'packages/connectors/package.json'))
const variants = {
  'desktop-required-for-local-input': ['apps/host/src/connections.ts', "hostId === 'local' ? runtime!.client : remoteIngress(hostId)", "hostId === 'local' ? undefined : remoteIngress(hostId)"],
  'publication-loses-original-core': ['apps/host/src/connections.ts', 'const publication = createPublicationConversationPort(clients)', 'const publication = createPublicationConversationPort(() => [])'],
  'authority-loses-original-ingress': ['apps/host/src/external-input-authority.ts', 'const result = await ingress.recordAuthority(input)', "throw new AgentMuxError('Mutated original authority', 'EXTERNAL_RECORD_TARGET_UNCONFIRMED'); const result = await ingress.recordAuthority(input)"],
  'host-rejoin-requires-desktop': ['apps/host/src/host.ts', 'options.externalInputAuthority ?? connectionOwner?.authority ?? createDesktopExternalInputAuthority', 'options.externalInputAuthority ?? undefined ?? createDesktopExternalInputAuthority'],
  'flush-aborts-owner-release': ['apps/host/src/host.ts', 'try { await close() } catch (error) { errors.push(error) }', 'try { await close() } catch (error) { throw error }'],
  'unknown-request-replayed': ['packages/connectors/src/publication-store.ts', "if (original.state !== 'not-applied') throw new AgentMuxError", 'if (false) throw new AgentMuxError']
} as const
const mutation = process.env.HOST_CONNECTION_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown Host connection mutation')
export default defineConfig({ root, plugins: [{ name: 'actual-host-owner-source', enforce: 'pre',
  transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:apps\/host|packages\/(?:core|connectors))\/src\/.+\.[cm]?[jt]s$/u.test(path)) return
    const selected = mutation && variants[mutation]
    let served = original
    if (selected && selected[0] === path) {
      if (original.split(selected[1]).length !== 2) throw Error('Host mutation must match one owning expression')
      served = original.replace(selected[1], selected[2])
    }
    if (!process.env.HOST_CONNECTION_TRACE) return served === original ? undefined : { code: served, map: null }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = { path, originalSHA: sha(readFileSync(id.split('?')[0]!, 'utf8')), servedSHA: sha(served), ...(served !== original ? { mutation } : {}) }
    return { code: "import { appendFileSync as __hostOwnerLoad } from 'node:fs'; __hostOwnerLoad(" + JSON.stringify(process.env.HOST_CONNECTION_TRACE) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + served, map: null }
  },
  resolveId(source, importer) {
    if (source === '@larksuiteoapi/node-sdk' || source === '@discordjs/rest') return connectorRequire.resolve(source)
    if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
    if (source === '@agentmux/connectors') return resolve(root, 'packages/connectors/src/index.ts')
    if (source.startsWith('@agentmux/core/')) {
      const entry = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports['./' + source.slice('@agentmux/core/'.length)]?.import
      if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice(7).replace(/\.js$/u, '.ts'))
    }
    if (!importer || !source.startsWith('.')) return
    const dist = resolve(dirname(importer), source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
    if (dist) return resolve(root, 'packages', dist[1]!, 'src', dist[2]! + '.ts')
  }
}], test: { include: ['apps/host/test/connection-owner-consumer.test.ts'], environment: 'node', fileParallelism: false,
  passWithNoTests: false, testTimeout: 35_000, hookTimeout: 15_000 } })
