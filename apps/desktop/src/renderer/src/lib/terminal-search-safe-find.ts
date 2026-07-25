import type { SearchAddon, ISearchOptions } from '@xterm/addon-search'

// Terminal find, made crash-proof. xterm's registerDecoration rejects a non-positive width by
// throwing synchronously — "This API only accepts positive integers". The search addon can hit this
// when the live viewport is narrower than the buffer column a match begins at: it computes a negative
// decoration width and throws from inside findNext/findPrevious. Because that call runs from a React
// event handler, an uncaught throw unmounts the whole terminal surface (there is no error boundary
// between them). Match navigation, though, completes BEFORE the decoration is drawn, so the search
// itself succeeded — only the highlight for that one pathological frame is impossible. Catching this
// one message (and rethrowing everything else, so real bugs still surface) keeps find working.
const DECORATION_WIDTH_THROW = 'This API only accepts positive integers'

// Match highlight colours. xterm paints decorations on its own canvas, so these must be literal
// #RRGGBB — CSS custom properties and color-mix cannot reach the canvas layer. They are derived from
// the AgentMux --amber token (#ecc16a, "Amber = Attention": a find sweep is an attention scan)
// mixed toward the terminal's black ground, so the value stays anchored to the design SSOT even
// though it is frozen to hex here. The active match is the same hue, only brighter — the one state
// emphasis, honouring "accent expresses state, not decoration".
//   matchBackground        = color-mix(in srgb, var(--amber) 40%, #000000) → #5e4d2a
//   matchBorder / ruler    = color-mix(in srgb, var(--amber) 55%, #000000) → #826a3a
//   activeMatchBackground  = color-mix(in srgb, var(--amber) 70%, #000000) → #a5874a
//   activeMatch border/ruler = var(--amber)                                → #ecc16a
export const TERMINAL_SEARCH_DECORATIONS: NonNullable<ISearchOptions['decorations']> = Object.freeze({
  matchBackground: '#5e4d2a',
  matchBorder: '#826a3a',
  matchOverviewRuler: '#826a3a',
  activeMatchBackground: '#a5874a',
  activeMatchBorder: '#ecc16a',
  activeMatchColorOverviewRuler: '#ecc16a'
})

// The one xterm exception this guard is allowed to swallow. Kept narrow: only the exact
// positive-integer decoration message, and only when it is an Error. Anything else — a real
// programming fault in the search path — must still propagate.
function isDecorationWidthThrow(error: unknown): boolean {
  return error instanceof Error && error.message === DECORATION_WIDTH_THROW
}

// Run one search step with the guard in place. Returns the addon's own boolean result on success,
// and false when the decoration-width throw was contained (the match still moved; only its highlight
// was skipped this frame). Any other error is rethrown unchanged.
export function safeTerminalFind(
  addon: Pick<SearchAddon, 'findNext' | 'findPrevious'>,
  query: string,
  direction: 'next' | 'previous',
  options: ISearchOptions
): boolean {
  try {
    return direction === 'previous'
      ? addon.findPrevious(query, options)
      : addon.findNext(query, options)
  } catch (error) {
    if (isDecorationWidthThrow(error)) return false
    throw error
  }
}
