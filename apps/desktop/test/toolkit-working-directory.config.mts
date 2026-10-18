import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import base from '../scripts/fixtures/toolkit-custom/vitest.config.mts'

const edits = {
  'home-expansion': ['packages/core/src/toolkit-working-directory.ts', 'const suffix = value.slice(prefix.length)', 'const suffix = value'],
  'host-wiring': ['apps/desktop/src/main/toolkit-config.ts', 'if (fields.workspacePath === undefined) return fields', 'if (true) return fields'],
  'error-detail': ['apps/desktop/src/main/toolkit-config.ts', '${issue.message}', '${issue.code}']
} as const
const mutation = process.env.AGENTMUX_WORKING_DIRECTORY_MUTATION
assert.ok(!mutation || Object.hasOwn(edits, mutation), 'Known working directory mutation')
const selected = mutation ? edits[mutation as keyof typeof edits] : null
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default { ...base, plugins: [...(base.plugins ?? []), {
  name: 'working-directory-consumed-mutation', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const file = relative(base.root!, id.split('?')[0]!)
    if (!selected || file !== selected[0]) return
    assert.equal(source.split(selected[1]).length, 2, 'One exact owning mutation anchor')
    const consumed = source.replace(selected[1], selected[2])
    if (process.env.AGENTMUX_WORKING_DIRECTORY_RECEIPT) appendFileSync(process.env.AGENTMUX_WORKING_DIRECTORY_RECEIPT,
      JSON.stringify({ mutation, file, sourceSHA256: hash(source), consumedSHA256: hash(consumed) }) + '\n')
    return { code: consumed, map: null }
  }
}], test: { ...base.test, include: ['packages/core/test/toolkit-working-directory.test.ts',
  'packages/core/test/toolkit-package.test.ts', 'apps/desktop/test/toolkit-working-directory.test.ts',
  'apps/desktop/test/toolkit-working-directory-main.test.ts', 'apps/desktop/test/toolkit-tui-config.test.ts'] } }
