import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import base from '../terminal-frame-lifetime/vitest.config.mts'
const product = 'packages/client-ui/src/terminal/live-output.ts'
const tracked = new Set([product, 'apps/desktop/src/renderer/src/components/TerminalView.tsx',
  'apps/desktop/test/terminal-live-output.test.ts', 'apps/desktop/test/terminal-webgl-visibility.test.tsx'])
const mutations = {
  copy: ['  if (parts.length === 1) return { dataBytes: parts[0]!, cursor: nextCursor, gap }', '  /* mutation: merge a single source span */'],
  overlap: ['Math.max(0, afterByte - chunk.startByte)', '0 /* mutation: repeat overlapped bytes */']
} as const
export default { ...base, plugins: [...(base.plugins ?? []), {
  name: 'terminal-original-live-spans', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (!tracked.has(path)) return
    const name = process.env.AGENTMUX_TERMINAL_SPAN_MUTATION
    let code = source
    if (path === product && name) {
      assert.ok(Object.hasOwn(mutations, name), 'Unknown terminal span mutation')
      const [from, to] = mutations[name as keyof typeof mutations]
      assert.equal(code.split(from).length - 1, 1, 'Mutation requires one original source anchor')
      code = code.replace(from, to)
    }
    if (process.env.AGENTMUX_TERMINAL_SPAN_LOADED) appendFileSync(process.env.AGENTMUX_TERMINAL_SPAN_LOADED,
      JSON.stringify({ path, mutation: path === product ? name ?? null : null,
        sourceSHA256: createHash('sha256').update(source).digest('hex'), effectiveSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: [...base.test!.include!, 'apps/desktop/test/terminal-live-output.test.ts', 'apps/desktop/test/terminal-work-bounds.test.ts'] } }
