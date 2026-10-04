import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../..')
const mutations = {
  'survey-in-work': ['SurfaceNavigation.tsx', "navigationContext: 'survey',", "navigationContext: 'work',"],
  'visible-work-label': ['TopRowChrome.tsx', '<div className="surface-navigation__surfaces" role="group" aria-label="Work surfaces">', '<div className="surface-navigation__surfaces" role="group" aria-label="Work surfaces"><span aria-hidden="true">Work</span>']
} as const
const mutation = process.env.AGENTMUX_FOOTER_MUTATION as keyof typeof mutations | undefined
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.tmp/footer-implicit-work-groups/cache'),
  plugins: [...original.plugins ?? [], { name: 'footer-source-mutation', enforce: 'pre', transform(source, id) {
    if (!mutation) return
    const [file, before, after] = mutations[mutation], owner = resolve(root, 'apps/desktop/src/renderer/src/components', file)
    if (id.split('?')[0] !== owner) return
    assert.equal(source.split(before).length - 1, 1, 'Unique actual source anchor')
    const code = source.replace(before, after), hash = (s: string) => createHash('sha256').update(s).digest('hex')
    appendFileSync(process.env.AGENTMUX_FOOTER_WITNESS!, JSON.stringify({ mutation, owner, original: hash(source), loaded: hash(code) }) + '\n')
    return { code, map: null }
  } }], test: { ...original.test, passWithNoTests: false, maxWorkers: 1, fileParallelism: false }
})
