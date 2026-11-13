// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { settingsElementVisible } from '../scripts/fixtures/settings-evaluation/visibility'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })
function box(element: Element) { vi.spyOn(element, 'getClientRects').mockReturnValue([new DOMRect(10, 10, 100, 50)] as unknown as DOMRectList) }

it('does not count cached layout boxes in a closed explanation as visible brand content', () => {
  document.body.innerHTML = '<details><summary><span>Read more</span></summary><section>Long explanation</section></details>'
  const details = document.querySelector('details')!, summary = document.querySelector('span')!, story = document.querySelector('section')!
  box(summary); box(story)
  expect(settingsElementVisible(summary)).toBe(true)
  expect(settingsElementVisible(story)).toBe(false)
  details.open = true
  expect(settingsElementVisible(story)).toBe(true)
  details.hidden = true
  expect(settingsElementVisible(story)).toBe(false)
})

it('keeps an inner summary hidden until its outer explanation is opened', () => {
  document.body.innerHTML = '<details id="outer"><summary>Outer</summary><details open><summary><span>Inner</span></summary></details></details>'
  const element = document.querySelector('span')!; box(element)
  expect(settingsElementVisible(element)).toBe(false)
  document.querySelector<HTMLDetailsElement>('#outer')!.open = true
  expect(settingsElementVisible(element)).toBe(true)
})
