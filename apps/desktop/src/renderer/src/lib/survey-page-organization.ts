import type { AgentMuxSurveyPageReference as Page } from '@agentmux/core/control'

export type SurveyPageTimes = Readonly<Record<string, number>>
export const surveyPageKey = (page: Page) => JSON.stringify([page.regionId, page.browserId])

/** Read only exact retained references. An old reference without a time stays undated. */
export function surveyPageTimes(value: unknown, pages: readonly Page[]): SurveyPageTimes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  return Object.fromEntries(pages.flatMap(page => {
    const key = surveyPageKey(page), time = source[key]
    return typeof time === 'number' && Number.isSafeInteger(time) && time >= 0 && time <= 8.64e15 ? [[key, time]] : []
  }))
}

export function updateSurveyPageTimes(before: readonly Page[], pages: readonly Page[], times: SurveyPageTimes, addedAt: number): SurveyPageTimes {
  const existing = new Set(before.map(surveyPageKey))
  const next = surveyPageTimes(times, pages) as Record<string, number>
  for (const page of pages) {
    const key = surveyPageKey(page)
    if (!existing.has(key)) next[key] = addedAt
  }
  return next
}

type Group = { id: string; pages: Page[]; site?: string; start?: number }

export function surveyPagesBySite(pages: readonly Page[], siteFor: (page: Page) => string | undefined): Group[] {
  const groups = new Map<string, Group>()
  for (const page of pages) {
    const site = siteFor(page), id = site ? 'site:' + site : 'other'
    let group = groups.get(id)
    if (!group) { group = { id, ...(site ? { site } : {}), pages: [] }; groups.set(id, group) }
    group.pages.push(page)
  }
  const other = groups.get('other')
  groups.delete('other')
  return [...groups.values(), ...(other ? [other] : [])]
}

export function surveyPagesByTime(pages: readonly Page[], times: SurveyPageTimes, gapMinutes: number): Group[] {
  const chronologic = pages.flatMap(page => {
    const time = times[surveyPageKey(page)]
    return time === undefined ? [] : [{ page, time }]
  }).sort((a, b) => a.time - b.time)
  const groups: Group[] = [], memberships = new Map<Page, Group>()
  let last: number | undefined
  for (const { page, time } of chronologic) {
    if (last === undefined || time - last >= gapMinutes * 60_000)
      groups.push({ id: 'time:' + time, start: time, pages: [] })
    memberships.set(page, groups.at(-1)!)
    last = time
  }
  const undated: Group = { id: 'undated', pages: [] }
  for (const page of pages) (memberships.get(page) ?? undated).pages.push(page)
  return [...groups.reverse(), ...(undated.pages.length ? [undated] : [])]
}
