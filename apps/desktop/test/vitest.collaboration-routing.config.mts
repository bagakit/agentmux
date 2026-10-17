import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'

const collision = 'routes actual SVG around every card and heading for same-column, reciprocal, cross-area and uneven districts'
const ports = 'keeps original role ports, arrow direction and reciprocal lanes at exact fixed card boundaries'
export const collaborationRoutingMutations = [
  { name: 'input-role-port', file: 'collaboration-geometry.ts', before: "direction === 'out' ? .5 : 1.5", after: "direction === 'out' ? .5 : .5", assertion: ports },
  { name: 'role-port-height', file: 'collaboration-geometry.ts', before: 'kinds.indexOf(kind) * 2', after: '0 * 2', assertion: ports },
  { name: 'reciprocal-lanes', file: 'collaboration-routing.ts', before: 'const lane = lanes[kind] + direction', after: 'const lane = lanes[kind] + 1', assertion: ports },
  { name: 'role-lanes', file: 'collaboration-routing.ts', before: 'const lane = lanes[kind] + direction', after: 'const lane = lanes.communication + direction', assertion: ports },
  { name: 'neighbor-escape', file: 'collaboration-routing.ts', before: "if (box.kind === 'area' || box.column !== box.cardColumn)", after: 'if (true)', assertion: collision },
  { name: 'empty-row-corridor', file: 'collaboration-routing.ts', before: 'box.y + box.height + 7 + lane / 2', after: 'box.y + box.height / 2', assertion: collision },
  { name: 'detour-bounds', file: 'collaboration-routing.ts', before: 'width: Math.max(...xs) - Math.min(...xs)', after: 'width: 0', assertion: 'bounds include a corridor detour even when both endpoint cards lie outside that viewport' },
  { name: 'geometry-reuse', file: 'collaboration-geometry.ts', before: 'if (unchanged) return boxes', after: 'if (false && unchanged) return boxes', assertion: 'reuses exact world geometry through metadata clones and only recalculates for actual membership or folding' },
  { name: 'unrelated-world-scan', file: 'collaboration-routing.ts', before: '  const from = boxes.get(connection.source)!', after: '  for (const _box of boxes.values()) {}\n  const from = boxes.get(connection.source)!', assertion: 'reads exactly the two endpoints regardless of unrelated world size' }
] as const
const selected = process.env.AGENTMUX_COLLABORATION_ROUTING_MUTATION
const mutation = collaborationRoutingMutations.find(item => item.name === selected)
if (selected && !mutation) throw Error('Unknown routing mutation')
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
let loaded = false
export default defineConfig({ plugins: [{ name: 'collaboration-routing-source-proof', enforce: 'pre', transform(source, id) {
  const path = relative(process.cwd(), id.split('?')[0]!)
  if (!/^apps\/desktop\/src\/renderer\/src\/lib\/collaboration-(routing|geometry|presentation)\.ts$/u.test(path)) return
  const applied = mutation && path.endsWith('/' + mutation.file)
  let code = source
  if (applied) {
    if (code.split(mutation.before).length !== 2) throw Error('Unique routing mutation anchor required')
    code = code.replace(mutation.before, mutation.after); loaded = true
  }
  if (process.env.AGENTMUX_COLLABORATION_ROUTING_LOADED) appendFileSync(process.env.AGENTMUX_COLLABORATION_ROUTING_LOADED,
    JSON.stringify({ path, originalSHA256: hash(source), effectiveSHA256: hash(code), mutant: applied ? selected : null }) + '\n')
  if (source !== code) return { code, map: null }
}, buildEnd() { if (selected && !loaded) throw Error('The actual routing mutation source must be loaded') } }], test: {
  include: ['apps/desktop/test/collaboration-routing.test.ts'],
  environment: 'node',
  globalSetup: [],
  passWithNoTests: false,
  maxWorkers: 1,
  fileParallelism: false
} })
