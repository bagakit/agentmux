import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../focus-browser-settings-visibility/vitest.owning.config.mjs'

const root = resolve(import.meta.dirname, '../../../../..')
const owner = resolve(root, 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx')
const retainedIntent = "          [...targets].reverse().find(target => target.surface !== 'space') ?? targets[0]"

export default defineConfig({ ...original,
  plugins: [{ name: 'loaded-browser-covered-presentation-intent', enforce: 'pre', transform(source, id) {
    const path = id.split('?')[0]!
    if (path !== owner) return
    const mutation = process.env.AGENTMUX_NATIVE_PRODUCT_ADJACENT_MUTATION
    if (mutation) assert.equal(mutation, 'return-covered-home', 'Known covered-presentation mutation')
    assert.equal(source.split(retainedIntent).length - 1, 1, 'One actual retained-presentation fallback')
    const loaded = mutation ? source.replace(retainedIntent, '          targets[0]') : source
    if (process.env.AGENTMUX_NATIVE_PRODUCT_ADJACENT_LOADED) appendFileSync(process.env.AGENTMUX_NATIVE_PRODUCT_ADJACENT_LOADED,
      JSON.stringify({ path: relative(root, path), sourceSHA256: createHash('sha256').update(source).digest('hex'),
        loadedSHA256: createHash('sha256').update(loaded).digest('hex'), mutation: mutation ?? null }) + '\n')
    return loaded === source ? undefined : { code: loaded, map: null }
  } }, ...(original.plugins ?? [])],
  cacheDir: resolve(root, '.tmp/native-product-adjacent-cache'),
  test: { ...original.test, include: ['apps/desktop/test/focus-browser-settings-visibility.test.tsx'], passWithNoTests: false,
    fileParallelism: false, maxWorkers: 1 }
})
