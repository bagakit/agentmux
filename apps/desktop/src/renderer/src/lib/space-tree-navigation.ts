import type { KeyboardEvent } from 'react'

/** Navigate the rendered projection; never activate an object just by moving focus. */
export function navigateSpaceTree(event: KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const target = event.target as HTMLElement
  const row = target.closest<HTMLButtonElement>('button[data-space-nav]')
  if (!row || !event.currentTarget.contains(row)) return
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-space-nav]')].filter((item) => !item.disabled)
  const index = rows.indexOf(row)
  let next: HTMLButtonElement | undefined
  switch (event.key) {
    case 'ArrowDown': next = rows[Math.min(index + 1, rows.length - 1)]; break
    case 'ArrowUp': next = rows[Math.max(index - 1, 0)]; break
    case 'Home': next = rows[0]; break
    case 'End': next = rows.at(-1); break
    case 'ArrowRight':
      if (row.dataset.spaceExpanded === 'false') {
        row.closest('[data-space-entry]')?.querySelector<HTMLButtonElement>('[data-space-disclosure]')?.click()
      } else {
        next = rows.find((item) => item.dataset.spaceParent === row.dataset.spaceNav)
      }
      break
    case 'ArrowLeft':
      if (row.dataset.spaceExpanded === 'true') {
        row.closest('[data-space-entry]')?.querySelector<HTMLButtonElement>('[data-space-disclosure]')?.click()
      } else {
        next = rows.find((item) => item.dataset.spaceNav === row.dataset.spaceParent)
      }
      break
    default: return
  }
  event.preventDefault()
  if (next) {
    next.focus({ preventScroll: true })
    next.scrollIntoView?.({ block: 'nearest' })
  }
}

export function matchesSpaceQuery(query: string, ...fields: (string | undefined)[]): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const text = fields.filter(Boolean).join('\n').toLocaleLowerCase()
  return terms.every((term) => text.includes(term))
}
