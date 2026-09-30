import { Globe2 } from 'lucide-react'
import type { AgentMuxSpaceCatalog, AgentMuxZoneFact } from '@agentmux/core/control'
import { GlobalSurveySurface } from '../../../src/renderer/src/components/GlobalSurveySurface'
import { SurveyZoneItem } from '../../../src/renderer/src/components/SurveyZoneItem'
import { surveyZoneItems } from '../../../src/renderer/src/lib/survey-workface'
import { useAppStore } from '../../../src/renderer/src/store'

const zone: AgentMuxZoneFact = { zoneId: 'opaque-zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: '/resource', branch: null }
const catalog: AgentMuxSpaceCatalog = {
  spaces: [], bindings: [], zones: [zone],
  tabs: [{ tabId: 'original-tab', zoneId: zone.zoneId, workspaceId: 'resource', name: null, regionIds: ['original-page'] }],
  regions: [{ tabId: 'original-tab', regionId: 'original-page', kind: 'browser', agentSessionId: null, runId: null, execution: null }],
  locations: [{ spaceId: null, zoneId: zone.zoneId, workspaceId: 'resource', displayWorkspaceId: 'display', groupId: 'group', tabId: 'original-tab', regionId: 'original-page' }]
}
const state = useAppStore.getState()
export const items = surveyZoneItems(catalog, state.surveyCollectedZones)
export const confirmed: boolean = state.setSurveyZoneCollected(zone.zoneId, true)
export const retainedNoteIntent = state.createNote
export const originalFileOpen = state.openFile
export const inputs = <><GlobalSurveySurface catalog={catalog} projection={null} />
  <SurveyZoneItem zone={zone} title="Original page" glyph={<Globe2 size={16} />} selected={false}
    activity={null} onSelect={() => {}} /></>
