import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from './vitest.retention.config.mts'
const variants = {
  writer: { from: 'return retainExecutionFocusHistory(entries, limit)', to: 'return entries.slice(0, limit)' },
  restore: { from: 'history: retainExecutionFocusHistory(history)', to: 'history: history.slice(0, MAX_EXECUTION_FOCUS_EVENTS)' }
} as const
const name = process.env.AGENTMUX_FOCUS_RETENTION_MUTATION as keyof typeof variants
if (!Object.hasOwn(variants, name)) throw new Error('Select one known history retention loaded mutation.')
const variant = variants[name]
let transformed = false
export default defineConfig({
  ...owning,
  cacheDir: resolve(import.meta.dirname, `../../../../../.tmp/focus-project-history-cache/retention-${name}`),
  plugins: [{ name: 'focus-retention-loaded-counterexample', enforce: 'pre', transform(source, id) {
    if (!id.split('?')[0]!.endsWith('/lib/agent-focus.ts')) return
    if (!source.includes(variant.from)) throw new Error(`Retention ${name} did not find its production source anchor.`)
    transformed = true
    return source.replace(variant.from, variant.to)
  }, buildEnd() { if (!transformed) throw new Error(`Retention ${name} production module was not loaded.`) } }]
})
