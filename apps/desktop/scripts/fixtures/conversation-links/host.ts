// Only the final Desktop IO edges are adapted. The production link-opening hook,
// modifier policy, current-origin context selector and presentation hooks stay real.
export const opened: any[] = [], inputs: any[] = [], issues: unknown[] = []
const state = { mainSurface: 'agents', config: { workspaces: [], hosts: [], focus: {} }, sessions: [], tabs: {}, layouts: {}, localHome: '',
  demands: {}, spaceZoneBindings: {}, spatialRequests: {}, scratchTopicSnapshots: {}, topicCategories: [], projectGroups: [],
  openHttpLink: async (origin: unknown, url: string, destination: string) => opened.push({ url, origin, destination, modifiers: inputs.at(-1)?.modifiers }),
  reportError: (error: unknown) => issues.push(String(error)) }
export const useAppStore = Object.assign((selector: (value: any) => unknown) => selector(state), {
  getState: () => state, subscribe: () => () => {}
})
export const currentCoreSpatialGraph = () => null
// An unused Mote file-action import crosses the same Store edge. It has no simulated state.
export function fileNavigationSelection(): never { throw new Error('File navigation is outside the local link proof') }
export const api = new Proxy({}, { get(_target, key) { throw new Error(`Unexpected Desktop IO in local link proof: ${String(key)}`) } })
