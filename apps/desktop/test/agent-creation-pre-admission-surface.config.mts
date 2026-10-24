import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './disk-start-recovery-surface.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...source, plugins: [{
  name: 'creation-preparation-surface-proof', enforce: 'pre',
  transform(code, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!['apps/desktop/src/renderer/src/components/SessionPane.tsx', 'apps/desktop/src/renderer/src/lib/session-state.ts'].includes(file)) return
    const original = code
    const mutation = process.env.AGENTMUX_CREATION_PREPARATION_UI_MUTATION
    if (mutation && file.endsWith('/SessionPane.tsx')) {
      assert.equal(mutation, 'unconfirmed-as-not-started')
      const from = "mode: 'The original request and initial prompt are kept.'"
      assert.equal(code.split(from).length - 1, 1, 'Exact production surface decision')
      code = code.replace(from, "mode: 'Agent has not started. The original request and initial prompt are kept.'")
    }
    if (process.env.AGENTMUX_CREATION_PREPARATION_UI_LOADED) appendFileSync(process.env.AGENTMUX_CREATION_PREPARATION_UI_LOADED,
      JSON.stringify({ file, sourceSHA256: hash(original), loadedSHA256: hash(code), mutation: code === original ? null : mutation }) + '\n')
    return { code, map: null }
  }
}] })
