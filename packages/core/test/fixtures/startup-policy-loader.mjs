import { stripTypeScriptTypes } from 'node:module'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, relative, resolve as pathResolve } from 'node:path'
import * as original from './agent-session-recovery/source-loader.mjs'
import { mutatePolicySource } from './startup-policy-mutations.mjs'

const root = pathResolve(import.meta.dirname, '../../../..')
const owners = new Set(['client', 'headless-runtime', 'hosted-runtime-service', 'public-rpc-service',
  'agent-session-recovery/supervisor', 'agent-session-recovery/continuity-attempt',
  'agent-session-recovery/continuity-policy', 'agent-session-recovery/continuity-activity'].map(name => 'packages/core/src/' + name + '.ts'))
export const resolve = original.resolve
export async function load(url, context, next) {
  const file = url.startsWith('file:') ? relative(root, fileURLToPath(url)) : ''
  if (!owners.has(file)) return await original.load(url, context, next)
  const source = await readFile(fileURLToPath(url), 'utf8')
  let code = mutatePolicySource(source, file, process.env.STARTUP_POLICY_MUTANT)
  const legacy = file.endsWith('/continuity-attempt.ts') && process.env.AGENTMUX_STATE_DIRECTORY &&
    existsSync(join(process.env.AGENTMUX_STATE_DIRECTORY, 'legacy-projection'))
  if (legacy) {
    const anchor = 'admission = agentContinuityAdmission({ session: current, trigger: receipt.trigger, policy,'
    if (code.split(anchor).length !== 2) throw Error('Expected the original legacy admission producer once')
    code = code.replace(anchor, 'admission = agentContinuityAdmission({ session: ports.events.projectSession(current), trigger: receipt.trigger, policy,')
  }
  const hash = value => createHash('sha256').update(value).digest('hex')
  const fact = { file, pid: process.pid, originalSHA256: hash(source), loadedSHA256: hash(code), legacy: Boolean(legacy),
    mutation: !legacy && code !== source ? process.env.STARTUP_POLICY_MUTANT : null }
  if (process.env.STARTUP_POLICY_TRACE) code += '\nimport {appendFileSync as __policyTrace} from "node:fs";\n' +
    '__policyTrace(' + JSON.stringify(process.env.STARTUP_POLICY_TRACE) + ',' + JSON.stringify(JSON.stringify(fact) + '\n') + ');\n'
  return { format: 'module', source: stripTypeScriptTypes(code, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
}
