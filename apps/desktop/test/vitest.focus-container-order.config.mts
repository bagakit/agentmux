import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.focus-zone-organization.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const selected = process.env.AGENTMUX_FOCUS_CONTAINER_ORDER_MUTANT
if (selected && selected !== 'shared-topic-rank') throw Error('Unknown container route mutation')
let applied = false
const hash = (code: string) => createHash('sha256').update(code).digest('hex')
export default defineConfig({ ...base, cacheDir: '.tmp/focus-container-order-cache', plugins: [...base.plugins ?? [], {
  name: 'original-container-route-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/')) return
    let code = source
    if (selected && path === 'apps/desktop/src/renderer/src/lib/use-focus-project-order.ts') {
      const before = 'import { focusLaneOrderKey, type FocusProjectLane }', after = 'import { focusLaneProjectKey as focusLaneOrderKey, type FocusProjectLane }'
      if (code.split(before).length !== 2) throw Error('One original route source anchor is required')
      code = code.replace(before, after); applied = true
      process.stderr.write('MUTATION_APPLIED=' + selected + '\n')
    }
    if (process.env.AGENTMUX_FOCUS_CONTAINER_ORDER_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_CONTAINER_ORDER_LOADED,
      JSON.stringify({ path, original_sha256: hash(source), loaded_sha256: hash(code), mutant: code === source ? null : selected }) + '\n')
    return code === source ? undefined : { code, map: null }
  }, buildEnd() { if (selected && !applied) throw Error('Original route source mutation was not consumed') }
}], test: { ...base.test, include: ['apps/desktop/test/focus-collection-layout.test.tsx', 'apps/desktop/test/focus-stable-routes.test.tsx'], maxWorkers: 1, fileParallelism: false, passWithNoTests: false } })
