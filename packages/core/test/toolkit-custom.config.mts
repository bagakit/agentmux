import { defineConfig } from 'vitest/config'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import owning from '../../../apps/desktop/scripts/fixtures/performance-toolkit/vitest.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const evidence = process.env.AGENTMUX_TOOLKIT_EVIDENCE ?? resolve(root, '.bagakit/toolkit-custom-core-test')
const mutant = process.env.AGENTMUX_TOOLKIT_CORE_MUTANT ?? 'baseline'
const changes: Record<string, [string, string, string]> = {
  budget: ['packages/core/src/toolkit.ts', 'if (Buffer.byteLength(JSON.stringify(r)) > TOOLKIT_TOOL_FIELDS_MAX_BYTES) invalid(code)', 'void r'],
  descriptor: ['packages/core/src/toolkit.ts', "if (key === 'name') encodedText(value, 768, code)\n  if (key === 'icon') encodedText(value, 192, code)", 'void key'],
  header: ['packages/core/src/control-host.ts', 'if (isToolkitOperation(operation?.value)) return parseToolkitRequest(source)', 'void operation'],
  target: ['packages/core/src/toolkit.ts', 'if (toolId !== request.toolId) throw', 'if (false) throw'],
  input: ['packages/core/src/toolkit.ts', "case 'toolkit.run': record(source, source.toolId === 'performance' ? base : [...base, 'input'], [], code); if (source.toolId !== 'performance') parseToolkitRunInput(source.input, code); break", "case 'toolkit.run': record(source, base, ['input'], code); break"],
  utf8: ['packages/core/src/cli-json-input.ts', "new TextDecoder('utf-8', { fatal: true }).decode", "new TextDecoder('utf-8', { fatal: false }).decode"],
  'action-count': ['packages/core/src/toolkit.ts', 'value.length > TOOLKIT_MAX_ACTIONS', 'value.length > 32'],
  'action-input': ['packages/core/src/toolkit.ts', 'identity(source.actionId, code); parseToolkitActionInput(source.input, code); break', 'identity(source.actionId, code); void source.input; break']
}
assert.ok(mutant === 'baseline' || changes[mutant], 'The Core mutation must name an actual owning Source change.')
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
// Consume current Source aliases and real module input recording, with a bounded Core boundary suite.
export default defineConfig({ ...owning, plugins: [...(owning.plugins ?? []), {
  name: 'actual-custom-toolkit-core-mutation', enforce: 'pre', transform(input, id) {
    const path = relative(root, id.split('?')[0]!)
    const change = changes[mutant]
    if (!change || change[0] !== path) return
    assert.equal(input.split(change[1]).length - 1, 1, `Mutation must own exactly one real Source anchor: ${path}`)
    const consumed = input.replace(change[1], change[2])
    appendFileSync(resolve(evidence, 'core-mutation.jsonl'), JSON.stringify({ path, mutant,
      originalSHA256: sha(input), consumedSHA256: sha(consumed), bytes: Buffer.byteLength(consumed) }) + '\n')
    return { code: consumed, map: null }
  }
}], test: { ...owning.test,
  include: ['packages/core/test/toolkit-control.test.ts', 'packages/core/test/toolkit-custom.test.ts'] } })
