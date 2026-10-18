import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../settings-recovery-choices/vitest.config.mts'
import { root } from '../settings-resource-library/environment.mjs'

const changes = {
  agents: ['AgentSettingsPane.tsx', 'onChange={(event) => update(id, { label: event.target.value })}', 'onChange={() => {}}'],
  prompts: ['ShortcutSettingsPane.tsx', "onChange={(event) => update(prompt.id, { states: event.target.checked ? [...(prompt.states ?? []), state] : (prompt.states ?? []).filter((candidate) => candidate !== state) })}", 'onChange={() => {}}'],
  toolkit: ['ToolkitToolEditor.tsx', 'const invalid = missingFields.length > 0', 'const invalid = false']
} as const
const mode = process.env.AGENTMUX_LIBRARIES_EXPRESSION_MUTANT as keyof typeof changes | undefined
if (mode && !Object.hasOwn(changes, mode)) throw new Error('Unknown library mutation')
export default defineConfig({ ...base,
  plugins: mode ? [{ name: 'library-expression-owner-mutation', enforce: 'pre', transform(source, id) {
    const [name, before, after] = changes[mode]
    const file = `apps/desktop/src/renderer/src/components/settings/${name}`
    if (id.split('?')[0] !== resolve(root, file)) return
    if (source.split(before).length !== 2) throw new Error('Expected one library owner mutation anchor')
    const changed = source.replace(before, after)
    if (process.env.AGENTMUX_LIBRARIES_EXPRESSION_EVIDENCE) appendFileSync(process.env.AGENTMUX_LIBRARIES_EXPRESSION_EVIDENCE, JSON.stringify({
      mutant: mode, file, count: 1,
      original: createHash('sha256').update(source).digest('hex'), consumed: createHash('sha256').update(changed).digest('hex')
    }) + '\n')
    return { code: changed, map: null }
  } }] : [],
  test: { ...base.test, include: ['apps/desktop/test/settings-libraries-expression.test.tsx'] }
})
