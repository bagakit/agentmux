import { cloneElement, type ComponentProps, type ReactElement } from 'react'
import { shallow } from 'zustand/shallow'
import type { ActivityView } from '../components/ActivityView'

type Activity = ReactElement<ComponentProps<typeof ActivityView>>
type Controls = Pick<Activity['props'], 'conversationReading' | 'activitySemantic' | 'revealRequest'>

function sameReadingControls(previous: Controls['conversationReading'], current: Controls['conversationReading']): boolean {
  if (previous === current) return true
  if (!previous || !current) return false
  // Hosts rebuild these flat placement facts; sources and callbacks still compare by identity.
  const { consumer: previousConsumer, ...previousControls } = previous
  const { consumer: currentConsumer, ...currentControls } = current
  return shallow(previousConsumer, currentConsumer) && shallow(previousControls, currentControls)
}

/** Keep the retained body stable without freezing its live reading controls. */
export function retainActivityControls(content: Activity, controls: Controls): Activity {
  if (content.props.revealRequest === controls.revealRequest &&
    content.props.activitySemantic === controls.activitySemantic &&
    sameReadingControls(content.props.conversationReading, controls.conversationReading)) return content
  return cloneElement(content, controls)
}
