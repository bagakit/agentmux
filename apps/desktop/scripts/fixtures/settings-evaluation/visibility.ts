/** Layout boxes can survive inside a closed details element; they are not painted content. */
export function settingsElementVisible(element: Element): boolean {
  if (element.closest('[hidden], [inert]') || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return false
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName !== 'DETAILS' || (parent as HTMLDetailsElement).open) continue
    const summary = [...parent.children].find(child => child.tagName === 'SUMMARY')
    if (!summary?.contains(element)) return false
  }
  return true
}
