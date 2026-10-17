import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useAppStore } from '../store'

const ListIcon = semanticIconComponent('object.list')
const MapIcon = semanticIconComponent('object.map')

/** The same Focus presentation, with retained list and map owners. */
export function FocusViewSwitch() {
  const view = useAppStore(state => state.focusView)
  const setView = useAppStore(state => state.setFocusView)
  return <div className="focus-view-switch" role="group" aria-label="Focus view">
    <button type="button" aria-label="List" aria-pressed={view === 'list'} onClick={() => setView('list')}><ListIcon size={14} /><span>List</span></button>
    <button type="button" aria-label="Map" aria-pressed={view === 'map'} onClick={() => setView('map')}><MapIcon size={14} /><span>Map</span></button>
  </div>
}
