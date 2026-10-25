import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useAppStore } from '../store'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'

const ListIcon = semanticIconComponent('object.list')
const MapIcon = semanticIconComponent('object.map')

/** The same Focus presentation, with retained list and map owners. */
export function FocusViewSwitch() {
  const view = useAppStore(state => state.focusView)
  const setView = useAppStore(state => state.setFocusView)
  return <SurfaceModeSwitch value={view} onChange={setView} active semantics="pressed" className="focus-view-switch" ariaLabel="Focus view"
    options={[{ value: 'list', ariaLabel: 'List', label: <><ListIcon size={14} /><span>List</span></> },
      { value: 'map', ariaLabel: 'Map', label: <><MapIcon size={14} /><span>Map</span></> }]} />
}
