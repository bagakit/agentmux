import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import original from './vitest.goal-cross-host.config.mts'

const mutations = {
  'skip-reconciliation': ["const reconcileRemote = remote && saved.linkedAt === undefined && method === 'goal.delegate'", 'const reconcileRemote = false'],
  'outbox-bind-link': ["const confirmBinding = remote && saved.linkedAt === undefined && method === 'goal.delegation.bind'", 'const confirmBinding = false'],
  'ignore-receipt': ["if (remote && (!received.provenance", "if (false && remote && (!received.provenance"]
} as const
const name = process.env.GOAL_DELIVERY_MUTATION
if (name && !Object.hasOwn(mutations, name)) throw Error('Choose one exact Goal delivery mutation')
export default defineConfig({ ...original, plugins: [{ name: 'goal-delivery-exact-owner', enforce: 'pre', transform(source, id) {
  if (!name || relative(process.cwd(), id.split('?')[0]!) !== 'apps/host/src/goal-delegation-owner.ts') return null
  const [before, after] = mutations[name as keyof typeof mutations]
  if (source.split(before).length !== 2) throw Error('The Goal delivery mutation must match one exact owner anchor')
  const changed = source.replace(before, after), hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const row = { mutation: name, path: 'apps/host/src/goal-delegation-owner.ts', originalSHA256: hash(source), loadedSHA256: hash(changed) }
  const header = process.env.GOAL_DELIVERY_PROOF ? "import { appendFileSync as __goalDeliveryProof } from 'node:fs'; __goalDeliveryProof(" + JSON.stringify(process.env.GOAL_DELIVERY_PROOF) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' : ''
  return header + changed
} }, ...(original.plugins ?? [])], test: { ...original.test, include: ['apps/host/test/goal-delegation-delivery.test.ts'], passWithNoTests: false } })
