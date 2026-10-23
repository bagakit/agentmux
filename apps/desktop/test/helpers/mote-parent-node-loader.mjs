import { registerHooks } from 'node:module'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const moteParentMutations = {
  'actor-disconnected': ['if (row && !sameActor(row.actor, context.actor))', 'if (false)'],
  'foreign-child-adopted': ['input.enrollment.operationId !== row.enrollmentInput?.operationId', 'false'],
  'dispatching-not-unknown': ["if (row.defaultPhase === 'dispatching')", 'if (false)']
}
export function mutateMoteParent(source, mutation) {
  if (!mutation) return source
  const variant = moteParentMutations[mutation]
  if (!variant || source.split(variant[0]).length !== 2) throw Error('The exact finite parent mutation must match once')
  return source.replace(variant[0], variant[1])
}
const sha = value => createHash('sha256').update(value).digest('hex')
// A real owner subprocess imports the same package artifact, outside Vitest's transform graph.
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (!url.startsWith('file:') || !process.env.MOTE_PARENT_REPOSITORY || !process.env.MOTE_PARENT_LOADED) return result
  const file = fileURLToPath(url), path = relative(process.env.MOTE_PARENT_REPOSITORY, file)
  if (!['packages/connectors/dist/mote-connection-operations.js', 'packages/core/dist/agentmux.js'].includes(path)) return result
  const disk = readFileSync(file), original = result.source == null ? disk.toString() : Buffer.from(result.source).toString()
  const loaded = path.startsWith('packages/connectors/') ? mutateMoteParent(original, process.env.MOTE_PARENT_MUTANT) : original
  appendFileSync(process.env.MOTE_PARENT_LOADED, JSON.stringify({ path, diskSHA256: sha(disk), originalSHA256: sha(original), loadedSHA256: sha(loaded),
    producer: 'native-node-loader', ...(loaded !== original ? { mutation: process.env.MOTE_PARENT_MUTANT } : {}) }) + '\n')
  return loaded === original ? result : { ...result, source: loaded }
} })
