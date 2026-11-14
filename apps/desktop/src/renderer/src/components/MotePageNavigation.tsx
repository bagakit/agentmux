import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { MoteThreadView } from '@agentmux/client-ui/components/MoteConversationThreads'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import { MoteConversationIdentity } from './MoteConversationIdentity'
import { moteThreadOptions, type MoteThreadCounts } from './MoteThreadNavigation'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'
import '../styles/mote-page-navigation.css'

type CommonPage = 'discussion' | 'calendar' | MoteThreadView
type SpacePage = CommonPage | 'ideas' | 'profile'

type Props = {
  scope: MoteWorkfaceScope
  counts: MoteThreadCounts
  active: boolean
  leading?: ReactNode
  actions?: ReactNode
} & (
  | { surface: 'space'; value: SpacePage; onChange(page: SpacePage): void }
  | { surface: 'floating'; value: CommonPage; onChange(page: CommonPage): void }
)

/** A page belongs to the surface that was opened. Each host supplies its original actions and selection. */
export function MotePageNavigation(props: Props) {
  const pages = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!props.active) return
    const track = pages.current?.querySelector<HTMLElement>('[role="tablist"]')
    const tab = track?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!track || !tab) return
    const reveal = () => {
      if (track.scrollWidth <= track.clientWidth) return
      const bounds = track.getBoundingClientRect(), current = tab.getBoundingClientRect()
      if (current.right > bounds.right) track.scrollLeft += current.right - bounds.right
      else if (current.left < bounds.left) track.scrollLeft -= bounds.left - current.left
    }
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(track)
    return () => observer.disconnect()
  }, [props.active, props.value])
  const space = props.surface === 'space'
  const options = [
    { value: 'discussion', label: space ? 'Discussion' : '主对话' },
    { value: 'calendar', label: 'Calendar' },
    ...(space ? [{ value: 'ideas', label: 'Ideas' }, { value: 'profile', label: 'Profile' }] as const : []),
    ...moteThreadOptions(props.counts)
  ] as const

  function select(page: SpacePage) {
    if (page === 'ideas' || page === 'profile') {
      if (props.surface === 'space') props.onChange(page)
    } else props.onChange(page)
  }

  return <header className={'mote-page-bar ' + (space ? 'mote-space-frame__header' : 'mote-workface__navigation')} hidden={!props.active}>
    <div className="mote-page-bar__identity">
      {props.leading}
      <MoteConversationIdentity scope={props.scope} visible={props.active} />
    </div>
    <div ref={pages} className={'mote-page-bar__pages' + (space ? ' mote-space-frame__navigation' : '')}>
      <SurfaceModeSwitch<SpacePage> value={props.value} options={options} onChange={select}
        active={props.active} ariaLabel={space ? 'Mote pages' : 'Mote 内容'} />
    </div>
    <div className="mote-page-bar__actions">{props.actions}</div>
  </header>
}
