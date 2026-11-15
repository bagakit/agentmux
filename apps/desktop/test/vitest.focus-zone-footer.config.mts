import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.focus-zone-organization.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutations = {
  'top-placement': ['renderer/src/components/FocusContextCards.tsx', [
    ['      {full ? <FocusContextCardBody', '      <FocusZoneFooter zone={topic} />\n      {full ? <FocusContextCardBody'],
    ['      <FocusZoneFooter zone={topic} />\n    </FocusCardSlot>', '    </FocusCardSlot>']]],
  'topic-body': ['renderer/src/components/FocusContextCards.tsx', [['topic={list ? topic : undefined}', 'topic={topic?.content ? undefined : topic}']]],
  'multiple-zones': ['renderer/src/lib/focus-collection-lanes.ts', [['if (!held.some(item => item.id === heading.id)) held.push(heading)', 'held.splice(0, held.length, heading)']]],
  'drop-notice': ['renderer/src/lib/focus-collection-lanes.ts', [['notice: held.map(item => item.notice)', 'notice: undefined']]],
  'example-top': ['renderer/src/components/settings/FocusSettingsPreview.tsx', [
    ['>{card(context)}{topic?.notice ?', '><FocusZoneFooter zone={topic} />{card(context)}{topic?.notice ?'],
    ['<FocusZoneFooter zone={topic} /></div></Fragment>', '</div></Fragment>']]]
} as const
const selected = process.env.AGENTMUX_FOCUS_FOOTER_MUTANT as keyof typeof mutations | undefined
if (selected && !mutations[selected]) throw Error('Unknown Zone footer mutation')
let applied = false
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...source, cacheDir: '.tmp/focus-zone-footer-cache',
  plugins: [...source.plugins ?? [], { name: 'actual-zone-footer-source', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!), local = path.replace(/^apps\/desktop\/src\//, '')
    let code = original
    if (selected && local === mutations[selected][0]) {
      for (const [before, after] of mutations[selected][1]) {
        if (code.split(before).length !== 2) throw Error('One exact Footer source anchor required')
        code = code.replace(before, after)
      }
      applied = true; process.stderr.write(`MUTATION_APPLIED=${selected}\n`)
    }
    if (process.env.AGENTMUX_FOCUS_FOOTER_LOADED && path.startsWith('apps/desktop/src/') && /\.[jt]sx?$/.test(path)) appendFileSync(process.env.AGENTMUX_FOCUS_FOOTER_LOADED,
      JSON.stringify({ path, original_sha256: sha(original), loaded_sha256: sha(code), mutant: code === original ? null : selected }) + '\n')
    return code === original ? undefined : { code, map: null }
  }, buildEnd() { if (selected && !applied) throw Error('The actual Footer mutation consumer was not loaded') } }],
  test: { ...source.test, include: process.env.AGENTMUX_FOCUS_FOOTER_ADJACENT
    ? ['apps/desktop/test/focus-project-appearance.test.tsx', 'apps/desktop/test/focus-collection-layout.test.tsx', 'apps/desktop/test/focus-topic-presentation-settings.test.tsx', 'apps/desktop/test/focus-zone-organization.test.tsx']
    : ['apps/desktop/test/focus-zone-footer.test.tsx'], maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
