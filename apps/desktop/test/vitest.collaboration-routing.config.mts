import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'

export const collaborationRoutingMutations = [
  { name: 'fixed-geometry', before: "engine: 'nop2'", after: "engine: 'dot'" },
  { name: 'reverse-direction', before: "tailport: `${connection.kind}-out:${forward ? 'e' : 'w'}`", after: "tailport: `${connection.kind}-out:e`" },
  { name: 'role-ports', before: 'tailport: `${connection.kind}-out:', after: 'tailport: `communication-out:' },
  { name: 'pre-cancelled-initialization', before: '  signal?.throwIfAborted()\n  if (!connections.length)', after: '  if (!connections.length)' },
  { name: 'cancel-before-render', before: '  const viz = await engine\n  signal?.throwIfAborted()', after: '  const viz = await engine' },
  { name: 'engine-retry', before: 'engine = undefined; throw error', after: 'throw error' }
] as const
const selected = process.env.AGENTMUX_COLLABORATION_ROUTING_MUTATION
const mutation = collaborationRoutingMutations.find(item => item.name === selected)
if (selected && !mutation) throw Error('Unknown routing mutation')
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
export default defineConfig({ plugins: [{ name: 'collaboration-routing-source-proof', enforce: 'pre', transform(source, id) {
  const path = relative(process.cwd(), id.split('?')[0]!)
  if (path !== 'apps/desktop/src/renderer/src/lib/collaboration-routing.ts') return
  let code = source
  if (mutation) {
    if (code.split(mutation.before).length !== 2) throw Error('Unique routing mutation anchor required')
    code = code.replace(mutation.before, mutation.after)
  }
  if (process.env.AGENTMUX_COLLABORATION_ROUTING_LOADED) appendFileSync(process.env.AGENTMUX_COLLABORATION_ROUTING_LOADED,
    JSON.stringify({ path, originalSHA256: hash(source), effectiveSHA256: hash(code), mutated: code !== source }) + '\n')
  if (source !== code) return { code, map: null }
} }], test: {
  include: ['apps/desktop/test/collaboration-routing.test.ts'],
  environment: 'node',
  globalSetup: [],
  passWithNoTests: false,
  maxWorkers: 1,
  fileParallelism: false
} })
