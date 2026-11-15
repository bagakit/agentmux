import { join, relative, resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'
import { sourceAliases } from '../../host/test/goal-cross-host-source.mjs'

const root = resolve(import.meta.dirname, '../../..')
const managerMutation = process.env.GOAL_MANAGER_ROLE_MUTATION ? JSON.parse(process.env.GOAL_MANAGER_ROLE_MUTATION) : null
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, plugins: [{
  name: 'original-plan-manager-owner', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (path !== (managerMutation?.path ?? 'apps/host/src/continuous-progress-loop-manager.ts')) return
    const hash = (text: string) => createHash('sha256').update(text).digest('hex'), originalSHA256 = hash(source)
    if (managerMutation) {
      if (source.split(managerMutation.anchor).length !== 2) throw new Error('The manager mutation must name one exact original owner')
      source = source.replace(managerMutation.anchor, () => managerMutation.replacement)
    }
    const output = process.env.GOAL_MANAGER_ROLE_LOADED
    if (!output) return source
    appendFileSync(output, '')
    const row = { path, originalSHA256, loadedSHA256: hash(source), ...(managerMutation ? { mutant: managerMutation.id } : {}) }
    return `import {appendFileSync as __managerLoaded} from 'node:fs'; __managerLoaded(${JSON.stringify(output)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + source
  }
}], resolve: { alias: sourceAliases.map(({ find, replacement }) => ({
  find: new RegExp('^' + find.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace('*', '(.*)') + '$', 'u'), replacement: replacement.replace('*', '$1')
})) }, test: { include: ['apps/desktop/test/goal-plan-continuation-product.test.ts', 'apps/host/test/goal-plan-progress.test.ts'],
  setupFiles: [join(root, 'vitest.setup.ts')], maxWorkers: 1, fileParallelism: false, testTimeout: 60_000, hookTimeout: 60_000 } })
