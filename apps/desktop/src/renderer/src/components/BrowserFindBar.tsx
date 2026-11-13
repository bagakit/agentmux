import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { BROWSER_FIND_MAX_LENGTH } from '../../../shared/contracts'
import { api } from '../lib/api'

const ThemeActionSearchIcon = semanticIconComponent('action.search')
const ThemeNavigationUpIcon = semanticIconComponent('navigation.up')
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')
const ThemeActionCloseIcon = semanticIconComponent('action.close')

type FindCount =
  | { kind: 'none' }
  | { kind: 'found'; ordinal: number; matches: number }
  | { kind: 'unconfirmed' }
  | { kind: 'failed'; message: string }

/** Find in this exact Browser's page. The query lives only in this row; it is not written to history or records. */
export function BrowserFindBar({ browserId, navigationId, loading, agentControlled, focusRequest, onClose }: {
  browserId: string
  navigationId: string
  loading: boolean
  agentControlled: boolean
  focusRequest: number
  onClose(): void
}) {
  const [query, setQuery] = useState('')
  const [count, setCount] = useState<FindCount>({ kind: 'none' })
  const input = useRef<HTMLInputElement>(null)
  const latest = useRef(0)
  const session = useRef<string | null>(null)
  const current = useRef({ query, navigationId })
  current.current = { query, navigationId }

  const find = (text: string, forward: boolean) => {
    const request = ++latest.current
    if (!text) {
      const searched = session.current !== null
      session.current = null
      setCount({ kind: 'none' })
      if (searched) void api.browser.stopFindInPage(browserId, { focusPage: false }).catch(error => setCount({ kind: 'failed', message: presentError(error) }))
      return
    }
    const sessionKey = `${navigationId}\n${text}`, newSession = session.current !== sessionKey
    session.current = sessionKey
    api.browser.findInPage(browserId, text, { forward, newSession }).then(result => {
      // A slower answer for an earlier query or document never replaces the current one.
      if (request !== latest.current || result.navigationId !== current.current.navigationId) return
      setCount(result.status === 'found' ? { kind: 'found', ordinal: result.activeMatchOrdinal, matches: result.matches } : { kind: 'unconfirmed' })
    }, error => {
      if (request !== latest.current) return
      session.current = null
      setCount({ kind: 'failed', message: presentError(error) })
    })
  }

  useEffect(() => { input.current?.focus(); input.current?.select() }, [focusRequest])

  // A new document gets the kept query once it has loaded; results of the previous document are void.
  useEffect(() => {
    if (loading || agentControlled || !current.current.query || session.current?.startsWith(`${navigationId}\n`)) return
    find(current.current.query, true)
  }, [navigationId, loading, agentControlled])

  const close = () => {
    ++latest.current
    if (!agentControlled && session.current) {
      void api.browser.stopFindInPage(browserId, { focusPage: true }).catch(error => console.warn('Find highlights could not be cleared. The page is unchanged.', error))
    }
    onClose()
  }

  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    close()
  }
  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (query && !agentControlled) find(query, !event.shiftKey)
  }

  const countText = agentControlled ? 'Take control to search' : count.kind === 'found'
    ? count.matches ? `${count.ordinal}/${count.matches}` : '0 results'
    : count.kind === 'unconfirmed' ? '? results' : count.kind === 'failed' ? 'Find failed' : ''
  const countTitle = agentControlled ? 'An Agent controls this page. Take control to search it.'
    : count.kind === 'unconfirmed' ? 'The page did not confirm a result. Press Enter to search again.'
      : count.kind === 'failed' ? count.message : undefined
  const countTone = agentControlled ? ' browser-find__count--control' : count.kind === 'failed' || count.kind === 'unconfirmed' ? ' browser-find__count--note' : ''
  // A confirmed zero leaves no match to move to; Enter still searches again.
  const navigable = Boolean(query) && !agentControlled && !(count.kind === 'found' && count.matches === 0)

  return (
    <div className="browser-find" role="search" aria-label="Find in page" onKeyDown={onRowKeyDown}>
      <label className="browser-find__field">
        <ThemeActionSearchIcon size={12} aria-hidden="true" />
        <input ref={input} type="text" aria-label="Find in page" placeholder="Find in page" spellCheck={false} autoComplete="off"
          maxLength={BROWSER_FIND_MAX_LENGTH} value={query} disabled={agentControlled}
          onChange={event => { setQuery(event.target.value); find(event.target.value, true) }} onKeyDown={onInputKeyDown} />
      </label>
      <span className={`browser-find__count${countTone}`} role="status" title={countTitle}>{countText}</span>
      <button type="button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!navigable} onClick={() => find(query, false)}>
        <ThemeNavigationUpIcon size={13} />
      </button>
      <button type="button" aria-label="Next match" title="Next match (Enter)" disabled={!navigable} onClick={() => find(query, true)}>
        <ThemeNavigationDownIcon size={13} />
      </button>
      <button type="button" aria-label="Close find" title="Close find (Escape)" onClick={close}>
        <ThemeActionCloseIcon size={13} />
      </button>
    </div>
  )
}
