import { defineConfig, mergeConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import original from './agent-promotion-ui.config.mts'
const mutation = process.env.PROMOTION_MENU_MUTANT
const changes = {
  language: ['/components/AgentMenuContent.tsx', '<span>Promotion…</span>', '<span>晋升为 Mote…</span>'],
  'topic-icon': ['/components/TopicContextMenu.tsx', "const PromotionIcon = semanticIconComponent('object.promotion')", "const PromotionIcon = semanticIconComponent('object.mote')"],
  'shared-drawing': ['/theme/icon-catalog.ts', "'object.promotion': { label: 'Promotion', glyph: 'promotion-rise' }", "'object.promotion': { label: 'Promotion', glyph: 'arrow-up-right' }"]
} as const
if (mutation && !Object.hasOwn(changes, mutation)) throw Error('Unknown Promotion menu mutation')
export default mergeConfig(original, defineConfig({ plugins: [{ name: 'promotion-menu-loaded-source', enforce: 'pre', transform(source, id) {
  const file = id.split('?')[0]!, path = relative(original.root!, file)
  let loaded = source
  if (mutation) {
    const [suffix, before, after] = changes[mutation as keyof typeof changes]
    if (file.endsWith(suffix)) {
      if (source.split(before).length !== 2) throw Error('Expected one actual menu mutation anchor: ' + mutation)
      loaded = source.replace(before, after)
      console.log('PROMOTION_MENU_MUTANT_LOADED ' + mutation)
    }
  }
  if (process.env.PROMOTION_MENU_LOADED && ['apps/desktop/src/', 'packages/client-ui/src/'].some(prefix => path.startsWith(prefix))) {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(process.env.PROMOTION_MENU_LOADED, JSON.stringify({ path, originalSHA256: hash(source), loadedSHA256: hash(loaded),
      ...(source === loaded ? {} : { mutation }) }) + '\n')
  }
  return source === loaded ? undefined : { code: loaded, map: null }
} }] }))
