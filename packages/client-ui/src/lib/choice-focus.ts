/** Move among currently available choices. Search inputs retain native editing keys. */
export function focusChoice(event: Pick<KeyboardEvent, 'key' | 'target'>, choices: readonly HTMLElement[]) {
  if (!choices.length) return false
  const index = choices.indexOf(event.target as HTMLElement)
  const next = event.key === 'ArrowDown' ? (index + 1) % choices.length
    : event.key === 'ArrowUp' ? (index <= 0 ? choices.length : index) - 1
    : event.key === 'Home' && index !== -1 ? 0
    : event.key === 'End' && index !== -1 ? choices.length - 1 : -1
  if (next === -1) return false
  const choice = choices[next]!
  choice.focus({ preventScroll: true })
  choice.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  return true
}
