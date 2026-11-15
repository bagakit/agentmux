import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from '../settings-overview/vitest.config.mts'

const root = resolve(import.meta.dirname, '../../../../..')
const client = 'packages/client-ui'
const composition = `${client}/src/lib/composer-composition.ts`
const textarea = `${client}/src/input/ComposerTextarea.tsx`
const queued = 'apps/desktop/src/renderer/src/components/ComposerQueuedMessageEditor.tsx'
const question = `${client}/src/components/AgentAsyncQuestionCard.tsx`
const product = [composition, textarea, queued, question]
const mutations = {
  'stale-composition': [composition, 'nextComposerCompositionState(state, {', 'nextComposerCompositionState(deps.state, {'],
  'detached-editor-size': [textarea, "data-expanded={variant === 'compact' && expanded || undefined}", 'data-expanded={undefined}']
} as const
const browserEntries = JSON.parse(readFileSync(resolve(root, client, 'package.json'), 'utf8')).exports
const aliases = Object.entries(browserEntries).flatMap(([key, entry]) => {
  const browser = (entry as { browser?: string })?.browser
  if (!browser || key.includes('*')) return []
  return [{ find: new RegExp(`^@agentmux/client-ui${key === '.' ? '' : key.slice(1)}$`), replacement: resolve(root, client, browser) }]
})
const digest = (code: string) => createHash('sha256').update(code).digest('hex')

export default defineConfig({
  ...source,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: [...aliases, ...source.resolve!.alias] },
  plugins: [{ name: 'actual-multiline-editor', enforce: 'pre', transform(code, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!product.includes(file)) return
    const variant = process.env.AGENTMUX_SETTINGS_EDITOR_INPUT_MUTATION as keyof typeof mutations | undefined
    const mutation = variant ? mutations[variant] : undefined
    const original = digest(code)
    if (mutation && file === mutation[0]) {
      assert.equal(code.split(mutation[1]).length, 2, `Unique loaded product anchor: ${variant}`)
      code = code.replace(mutation[1], mutation[2])
    }
    const loads = process.env.AGENTMUX_SETTINGS_EDITOR_INPUT_LOADS
    const loaded = digest(code)
    if (loads) appendFileSync(loads, JSON.stringify({ file, original, loaded }) + '\n')
    if (original !== loaded) return { code, map: null }
  } }],
  test: { ...source.test, include: ['apps/desktop/test/queued-message-input.test.tsx', `${client}/test/async-question-input.test.tsx`],
    maxWorkers: 1, fileParallelism: false }
})
