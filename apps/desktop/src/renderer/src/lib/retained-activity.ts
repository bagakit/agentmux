import { cloneElement, type ComponentProps, type ReactElement } from 'react'
import { shallow } from 'zustand/shallow'
import type { ActivityView } from '../components/ActivityView'

type Activity = ReactElement<ComponentProps<typeof ActivityView>>
type Controls = Pick<Activity['props'], 'conversationReading' | 'activitySemantic'>

/** Keep the retained body stable without freezing its live reading controls. */
export function retainActivityControls(content: Activity, controls: Controls): Activity {
  if (content.props.activitySemantic === controls.activitySemantic &&
    shallow(content.props.conversationReading, controls.conversationReading)) return content
  return cloneElement(content, controls)
}
