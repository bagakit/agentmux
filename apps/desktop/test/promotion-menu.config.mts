import { defineConfig, mergeConfig } from 'vitest/config'
import original from './agent-promotion-ui.config.mts'
const mutation = process.env.PROMOTION_MENU_MUTANT
const changes = {
  language: ['/components/AgentMenuContent.tsx', '<span>Promote to Mote…</span>', '<span>晋升为 Mote…</span>'],
  'topic-icon': ['/components/TopicContextMenu.tsx', "const PromotionIcon = semanticIconComponent('object.promotion')", "const PromotionIcon = semanticIconComponent('object.mote')"],
  'shared-drawing': ['/theme/icon-catalog.ts', "'object.promotion': { label: 'Promotion', glyph: 'promotion-rise' }", "'object.promotion': { label: 'Promotion', glyph: 'arrow-up-right' }"]
} as const
if (mutation && !Object.hasOwn(changes, mutation)) throw Error('Unknown Promotion menu mutation')
export default mergeConfig(original, defineConfig({ plugins: [{ name: 'promotion-menu-loaded-source', enforce: 'pre', transform(source, id) {
  if (!mutation) return
  const [suffix, before, after] = changes[mutation as keyof typeof changes]
  if (!id.split('?')[0]!.endsWith(suffix)) return
  if (source.split(before).length !== 2) throw Error('Expected one actual menu mutation anchor: ' + mutation)
  console.log('PROMOTION_MENU_MUTANT_LOADED ' + mutation)
  return { code: source.replace(before, after), map: null }
} }] }))
