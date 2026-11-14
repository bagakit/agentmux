import './mobile-web-node-loader.mjs'
import { registerHooks } from 'node:module'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(import.meta.dirname, '../../..')
const mutations = {
  'old-success-cache': ['apps/host/src/index.ts', 'if (environmentReady && !intent?.refresh)', 'if (environmentReady)'],
  'skip-inventory-preparation': ['packages/core/src/client.ts', 'if (input?.refresh) await this.prepareExecutionEnvironment({ refresh: true })', 'if (false) await this.prepareExecutionEnvironment({ refresh: true })'],
  'skip-probe-refresh': ['packages/core/src/client.ts', 'async probeExecutorAvailability(providerId: AgentProviderId, commandOverride?: string, context: AgentExecutableProbeContext = {}): Promise<AgentMuxExecutorProbeResult> {\n    await this.prepareExecutionEnvironment({ refresh: true })',
    'async probeExecutorAvailability(providerId: AgentProviderId, commandOverride?: string, context: AgentExecutableProbeContext = {}): Promise<AgentMuxExecutorProbeResult> {\n    await this.prepareExecutionEnvironment()']
}
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (!url.startsWith('file:') || result.source == null) return result
  const path = relative(root, fileURLToPath(url))
  if (!['apps/host/src/index.ts', 'packages/core/src/client.ts'].includes(path)) return result
  const original = String(result.source), mutation = mutations[process.env.EXECUTOR_ENVIRONMENT_MUTANT]
  let source = original
  if (mutation?.[0] === path) {
    if (source.split(mutation[1]).length !== 2) throw Error('One loaded environment mutation target required')
    source = source.replace(mutation[1], mutation[2])
  }
  const hash = value => createHash('sha256').update(value).digest('hex')
  if (process.env.EXECUTOR_ENVIRONMENT_LOADED) appendFileSync(process.env.EXECUTOR_ENVIRONMENT_LOADED, JSON.stringify({
    path, pid: process.pid, originalSHA256: hash(original), loadedSHA256: hash(source),
    mutant: source === original ? null : process.env.EXECUTOR_ENVIRONMENT_MUTANT
  }) + '\n')
  return source === original ? result : { ...result, source }
} })
