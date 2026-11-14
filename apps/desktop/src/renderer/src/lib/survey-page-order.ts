import type { AgentMuxSurveyPageReference as Page } from '@agentmux/core/control'
import { arrayMove } from '@dnd-kit/sortable'
import { samePage } from './survey-list'

export type SurveyPageOrderDrop = { kind: 'page-order'; reference: Page; order: readonly Page[] }
export const surveyPageOrderKey = (page: Page) => 'survey-page-order:' + JSON.stringify([page.regionId, page.browserId])

/** Swap only visible slots; filtered or pinned originals stay in place, and unavailable references remain. */
export function reorderSurveyPages(base: readonly Page[], visible: readonly Page[], from: Page, to: Page): readonly Page[] {
  const start = visible.findIndex(page => samePage(page, from)), end = visible.findIndex(page => samePage(page, to))
  if (start < 0 || end < 0 || start === end || visible.some(page => !base.some(original => samePage(original, page)))) return base
  const reordered = arrayMove([...visible], start, end)
  let index = 0
  return base.map(page => visible.some(member => samePage(member, page)) ? reordered[index++]! : page)
}
