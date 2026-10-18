import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import base from '../terminal-frame-lifetime/vitest.config.mts'

const product = 'apps/desktop/src/renderer/src/components/TerminalView.tsx'
const consumer = 'apps/desktop/test/terminal-incident-product.test.tsx'
const interaction = 'apps/desktop/src/renderer/src/lib/terminal-interaction-observation.ts'
const mutations = {
  frame: [product, 'cleanup(() => focusWindow.cancelAnimationFrame(focusFrame))', 'cleanup(() => undefined /* mutation: retain the old scheduled frame */)'],
  render: [product, 'cleanup(() => incidentRender.dispose())', 'cleanup(() => undefined /* mutation: retain the old render observer */)'],
  interaction: [interaction, 'owner = null', 'void owner /* mutation: keep the retired observer owner */']
} as const
export default { ...base, plugins: [...(base.plugins ?? []), {
  name: 'terminal-restart-memory', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (path !== product && path !== consumer && path !== interaction) return
    let code = source
    const mutation = process.env.AGENTMUX_TERMINAL_RESTART_MUTATION
    let applied: string | null = null
    if (mutation) {
      assert.ok(Object.hasOwn(mutations, mutation), 'Unknown terminal restart memory mutation')
      const [target, from, to] = mutations[mutation as keyof typeof mutations]
      if (path === target) {
        assert.equal(code.split(from).length - 1, 1, 'Mutation requires one original owner')
        code = code.replace(from, to)
        applied = mutation
      }
    }
    if (process.env.AGENTMUX_TERMINAL_RESTART_LOADED) appendFileSync(process.env.AGENTMUX_TERMINAL_RESTART_LOADED,
      JSON.stringify({ path, mutation: applied,
        sourceSHA256: createHash('sha256').update(source).digest('hex'), effectiveSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}] }
