import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from '../../../vitest.config.js'

const root = resolve(import.meta.dirname, '../../..')
const variants = {
  'requires-region': ['packages/connectors/src/room-target.ts', 'if (!target.regionAnchor) {', 'if (!target.regionAnchor) return false; if (!target.regionAnchor) {'],
  'accepts-foreign-session': ['packages/connectors/src/room-target.ts', 'return session?.hostId === target.executionHostId && session.agentSessionId === target.agentSessionId', 'return true'],
  'accepts-foreign-region': ['packages/connectors/src/room-target.ts', "return !!state && region?.kind === 'agent' && region.execution?.hostId === target.executionHostId && region.agentSessionId === target.agentSessionId", 'return true']
} as const
const mutation = process.env.ROOM_OWNER_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown room owner mutation')
export default defineConfig({ ...base, root, plugins: [{ name: 'original-room-owner', enforce: 'pre', transform(original, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!['packages/connectors/src/room-target.ts', 'packages/connectors/src/room-binding.ts'].includes(path)) return
  const selected = mutation && variants[mutation]
  let served = original
  if (selected && path === selected[0]) {
    if (original.split(selected[1]).length !== 2) throw Error('Room mutation must select one owner expression')
    served = original.replace(selected[1], selected[2])
  }
  if (!process.env.ROOM_OWNER_TRACE) return served === original ? undefined : served
  const sha = (value: string) => createHash('sha256').update(value).digest('hex')
  const row = { path, sourceSHA: sha(readFileSync(id.split('?')[0]!, 'utf8')), loadedSHA: sha(served), mutation: selected && path === selected[0] ? mutation : null }
  return "import { appendFileSync as __roomLoad } from 'node:fs'; __roomLoad(" + JSON.stringify(process.env.ROOM_OWNER_TRACE) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + served
} }], test: { ...base.test, include: ['packages/connectors/test/room-binding-public-consumer.test.ts'], passWithNoTests: false, fileParallelism: false } })
