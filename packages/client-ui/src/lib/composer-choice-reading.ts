/** Measure only the choice being read; CSS owns motion, reset and reduced-motion. */
function prepareChoiceReading(choice: HTMLElement, disclosure: string): void {
  let overflowing = false
  for (const line of choice.querySelectorAll<HTMLElement>('[data-choice-reading]')) {
    const text = line.firstElementChild as HTMLElement | null
    if (!text) continue
    const distance = Math.max(0, text.scrollWidth - line.clientWidth)
    line.toggleAttribute('data-overflow', distance > 1)
    line.style.setProperty('--choice-reading-offset', `${-distance}px`)
    line.style.setProperty('--choice-reading-duration', `${Math.max(2, distance / 32)}s`)
    overflowing ||= distance > 1
  }
  const reduced = choice.ownerDocument.defaultView!.matchMedia('(prefers-reduced-motion: reduce)').matches
  choice.title = overflowing && !reduced ? '' : disclosure
}

export function composerChoiceReadingProps(disclosure: string) {
  return {
    title: disclosure,
    'data-composer-choice': '',
    onPointerEnter: (event: { currentTarget: HTMLElement }) => prepareChoiceReading(event.currentTarget, disclosure),
    onPointerLeave: (event: { currentTarget: HTMLElement }) => {
      if (!event.currentTarget.matches(':focus-visible')) event.currentTarget.title = disclosure
    },
    onFocus: (event: { currentTarget: HTMLElement }) => prepareChoiceReading(event.currentTarget, disclosure),
    onBlur: (event: { currentTarget: HTMLElement }) => {
      if (!event.currentTarget.matches(':hover')) event.currentTarget.title = disclosure
    }
  }
}
