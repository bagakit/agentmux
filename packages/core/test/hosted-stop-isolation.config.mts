import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const variants = {
  'stop-global-observation': ['packages/core/src/hosted-client-contract.ts', "stopAgent: 'runtime'", "stopAgent: 'session-observation'"],
  'stop-cold-metadata': ['packages/core/src/client.ts', 'private async prepareAgentStop(agentSessionId: string, expectedRun: AgentMuxRunRef) {\n    const session = await this.resolveRawAgentSession(agentSessionId)', 'private async prepareAgentStop(agentSessionId: string, expectedRun: AgentMuxRunRef) {\n    const session = this.requireAgentSession(agentSessionId)'],
  'desktop-stop-observation': ['apps/desktop/src/main/runtime-controller.ts', "this.forgetSessionAttachmentOwner(attachmentKey)\n    const client = await this.connectedClient(control.hostId, 'runtime')", 'this.forgetSessionAttachmentOwner(attachmentKey)\n    const client = await this.connectedClient(control.hostId)'],
  'stop-stale-run': ['packages/core/src/client.ts', "if (!sameRun(session.run, expectedRun)) {\n      throw new AgentMuxError('Agent Session changed before its Run was stopped.', 'STALE_AGENT_SESSION')", "if (false) {\n      throw new AgentMuxError('Agent Session changed before its Run was stopped.', 'STALE_AGENT_SESSION')"],
  'durable-read-native': ['packages/core/src/hosted-client-contract.ts', "readAgentSession: 'owner'", "readAgentSession: 'runtime'"],
  'manual-input-observation': ['packages/core/src/hosted-runtime-service.ts', "if (!messageIntake && !['manual-actor', 'native-conversation'].includes(", "if (!messageIntake && ![].includes("],
  'reference-intake-observation': ['packages/core/src/hosted-runtime-service.ts', "messageIntake = retained === null || retained.deliveryMode === 'reference'", 'messageIntake = false'],
  'notify-native': ['packages/core/src/hosted-client-contract.ts', "notifyMessages: 'owner'", "notifyMessages: 'runtime'"]
} as const
const mutation = process.env.AGENTMUX_HOSTED_STOP_MUTATION as keyof typeof variants | undefined
const report = process.env.AGENTMUX_HOSTED_STOP_LOADED
if (mutation && !variants[mutation]) throw Error('Unknown Hosted Stop mutation')
const packages = readdirSync(resolve(root, 'packages')).map(name => resolve(root, 'packages', name))
const manifests = [...packages, resolve(root, 'apps/host')].filter(base => existsSync(resolve(base, 'package.json')))
const aliases: Record<string, string> = Object.fromEntries(manifests.flatMap(base => {
  const pkg = JSON.parse(readFileSync(resolve(base, 'package.json'), 'utf8'))
  return Object.entries(pkg.exports ?? {}).flatMap(([key, value]) => {
    const entry = typeof value === 'string' ? value : (value as { import?: string }).import
    if (typeof entry !== 'string' || !entry.startsWith('./dist/')) return []
    const source = resolve(base, entry.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
    return existsSync(source) || source.includes('*') ? [[key === '.' ? pkg.name : pkg.name + key.slice(1), source]] : []
  })
}))
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/hosted-stop-isolation', mutation ?? 'normal'),
  plugins: [{ name: 'hosted-stop-actual-owner', enforce: 'pre',
    resolveId(source, importer) {
      if (aliases[source]) return aliases[source]
      for (const [pattern, target] of Object.entries(aliases)) {
        if (!pattern.includes('*')) continue
        const [prefix, suffix] = pattern.split('*') as [string, string]
        if (source.startsWith(prefix) && source.endsWith(suffix)) {
          const resolved = target.replace('*', source.slice(prefix.length, suffix ? -suffix.length : undefined))
          if (existsSync(resolved)) return resolved
        }
      }
      if (!importer || !source.startsWith('.')) return
      const dist = resolve(dirname(importer), source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
      if (dist) return resolve(root, 'packages', dist[1]!, 'src', dist[2]! + '.ts')
    },
    transform(original, id) {
      const path = relative(root, id.split('?')[0]!)
      if (!/^(packages\/core|apps\/desktop)\/src\/.+\.ts$/u.test(path)) return
      const selected = mutation && variants[mutation]
      let code = original
      if (selected && path === selected[0]) {
        if (original.split(selected[1]).length !== 2) throw Error('Hosted Stop mutation must match exactly one owning expression')
        code = original.replace(selected[1], selected[2])
      }
      if (!report) return code === original ? undefined : { code, map: null }
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = { path, originalSHA256: sha(original), servedSHA256: sha(code), ...(code === original ? {} : { mutation }) }
      return { code: "import { appendFileSync as __stopOwnerLoaded } from 'node:fs'; __stopOwnerLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + code, map: null }
    }
  }], test: { include: ['packages/core/test/hosted-stop-isolation.test.ts', 'packages/core/test/stop-explicit-retry.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts'), resolve(root, 'packages/core/test/helpers/hosted-stop-private-state.ts')],
    environment: 'node', passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 10_000, hookTimeout: 15_000,
    ...(process.env.AGENTMUX_HOSTED_STOP_PATTERN ? { testNamePattern: process.env.AGENTMUX_HOSTED_STOP_PATTERN } : {}) }
})
