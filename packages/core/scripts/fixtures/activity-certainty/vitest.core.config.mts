import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.tmp/activity-certainty-core-cache'), plugins: [{
  name: 'actual-loaded-activity-certainty', enforce: 'pre', transform(source, id) {
    const path = id.split('?')[0]!
    if (path !== resolve(root, 'packages/core/src/agent-status-freshness.ts')) return
    const mutation = process.env.AGENTMUX_ACTIVITY_CERTAINTY_MUTATION
    const rules: Record<string, readonly [string,string]> = {
      'bare-idle': [": !declared\n        ? 'unknown'", ": !declared\n        ? 'idle'"],
      'stale-idle': [": state === 'done' || state === 'error' ? 'idle' : 'unknown'", ": 'idle'"]
    }
    let code = source
    if (mutation && mutation in rules) {
      const rule = rules[mutation]!
      assert.equal(source.split(rule[0]).length - 1, 1, 'Exact actual loaded product anchor')
      code = source.replace(rule[0], rule[1])
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_ACTIVITY_CERTAINTY_LOADED) appendFileSync(process.env.AGENTMUX_ACTIVITY_CERTAINTY_LOADED,
      JSON.stringify({ path: relative(root, path), sourceSHA256: hash(source), loadedSHA256: hash(code), mutated: code !== source, mutation }) + '\n')
    if (code !== source) return { code, map: null }
  }
}], test: { ...original.test, globalSetup: [resolve(import.meta.dirname, 'demand-freshness.ts')], include: ['packages/core/test/activity-certainty.test.ts'],
  passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 15_000 } })
