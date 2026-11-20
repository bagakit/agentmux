export function desktopRunInputOccupation(input: {
  known: boolean
  owners: readonly string[]
  drafts: Readonly<Record<string, string>>
  notes: Readonly<Record<string, string>>
  pending: boolean
}): 'unknown' | 'draft' | 'pending' | 'clear' {
  if (!input.known) return 'unknown'
  if (input.owners.some(owner => Boolean(input.drafts[owner] || input.notes[owner]))) return 'draft'
  return input.pending ? 'pending' : 'clear'
}
