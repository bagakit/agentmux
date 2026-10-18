import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import base from '../scripts/fixtures/toolkit-custom/vitest.config.mts'

const mutation = process.env.AGENTMUX_TOOLKIT_REASON_MUTATION
assert.ok(!mutation || ['ordinary-reason', 'display-reason'].includes(mutation), 'Known current-reason mutation')
export default { ...base, plugins: [...(base.plugins ?? []), {
  name: 'toolkit-current-reason-mutation', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(base.root!, id.split('?')[0]!)
    if (file !== 'apps/desktop/src/main/toolkit-custom-owner.ts') return
    let loaded = source
    if (mutation) {
      const prefix = mutation === 'ordinary-reason' ? 'tool.error ?? tool.loadError ?? ' : 'tool.error ?? tool.sourceError ?? '
      const before = prefix + '(tool.admission ?? tool.latest)?.reason ?? null'
      assert.equal(source.split(before).length, 2, 'One current-reason production anchor')
      loaded = source.replace(before, prefix + 'tool.admission?.reason ?? tool.latest?.reason ?? null')
    }
    if (process.env.AGENTMUX_TOOLKIT_REASON_RECEIPT) appendFileSync(process.env.AGENTMUX_TOOLKIT_REASON_RECEIPT,
      JSON.stringify({ file, mutation, sourceSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex') }) + '\n')
    return { code: loaded, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/toolkit-custom-owner.test.ts', 'apps/desktop/test/toolkit-current-reason-ui.test.tsx'] } }
