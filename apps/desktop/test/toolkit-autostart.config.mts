import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import base from '../scripts/fixtures/toolkit-custom/vitest.config.mts'

const mutation = process.env.AGENTMUX_AUTOSTART_MUTATION
const changes: Record<string, [string, string]> = {
  choice: ['tool.enabled && tool.autoStart !== false', 'tool.enabled'],
  types: ['tool.enabled && tool.autoStart !== false', "!('kind' in tool) && tool.mode === 'tui' && tool.enabled && tool.autoStart !== false"],
  once: ['const added = [...enabled].filter(id => !this.autoStartingTools.has(id))', 'const added = [...enabled]'],
  terminal: ['if (tool.admission) return', 'return'],
  bundled: ['toolkitTools(this.args.config.current).filter(tool => tool.enabled', 'this.configurations().filter(tool => tool.enabled'],
  'seed-enabled': ['enabled: false', 'enabled: true']
}
assert.ok(!mutation || changes[mutation], 'Known startup mutation')
const target = mutation === 'seed-enabled' ? 'apps/desktop/resources/toolkit/initial-packages.ts' : 'apps/desktop/src/main/toolkit-custom-owner.ts'
export default { ...base, plugins: [...(base.plugins ?? []), {
  name: 'autostart-consumed-mutation', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const file = relative(base.root!, id.split('?')[0]!)
    if (process.env.AGENTMUX_AUTOSTART_INPUT_RECEIPT && (file.startsWith('packages/') || file.startsWith('apps/desktop/src/'))) {
      const sha256 = createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex')
      appendFileSync(process.env.AGENTMUX_AUTOSTART_INPUT_RECEIPT, JSON.stringify({ file, sha256 }) + '\n')
    }
    if (!mutation || file !== target) return
    const [from, to] = changes[mutation]!
    assert.equal(source.split(from).length, 2, 'Mutation changes one actual loaded owner expression')
    if (process.env.AGENTMUX_AUTOSTART_MUTATION_RECEIPT) appendFileSync(process.env.AGENTMUX_AUTOSTART_MUTATION_RECEIPT, JSON.stringify({ mutation, file: id }) + '\n')
    return { code: source.replace(from, to), map: null }
  }
}], test: { ...base.test, passWithNoTests: false, include: [
  'apps/desktop/test/toolkit-autostart-main.test.ts', 'apps/desktop/test/toolkit-tui-owner.test.ts',
  'apps/desktop/test/toolkit-tui-process.test.ts', 'apps/desktop/test/toolkit-custom-drafts.test.tsx', 'apps/desktop/test/toolkit-custom-ui.test.tsx'
] } }
