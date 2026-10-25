import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ConnectionResultMap, RoomBindingBindInput, RoomBindingInspection } from '@agentmux/core/connections'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { AgentConnectorDialog } from '../../../src/renderer/src/components/AgentConnectorDialog'
import { SettingsNavigation } from '../../../src/renderer/src/components/SettingsNavigation'
import { MoteWorkfaceContext } from '../../../src/renderer/src/lib/mote-workface'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { channelFixture } from './facts'

const { proof, settingsCatalog, session, connection, hostingTarget, target } = channelFixture
const input: RoomBindingBindInput = { ...target, operationId: 'preview-original-refused-bind', bindingId: 'preview-requested-binding', connectionId: connection.config.connectionId,
  expectedConnectionRevision: connection.revision, externalConversationId: 'preview-requested-group', scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' },
  expectedSource: { providerId: session.providerId, nativeSessionId: session.nativeHandle.sessionId } }
let state: 'refused' | 'unknown' = 'refused'
const refusal: RoomBindingInspection = { binding: null, current: null, grants: [], operation: { operationId: input.operationId, action: 'bind', state: 'refused', code: 'ROOM_BINDING_MAPPING_CONFLICT' },
  mappingConflict: { status: 'checked', current: [{ binding: { bindingId: 'preview-existing-peer-binding', revision: 3, state: 'active', connectionId: connection.config.connectionId, application: connection.config.application,
    externalConversationId: input.externalConversationId, executionHostId: target.executionHostId, agentSessionId: 'preview-original-peer-agent' }, differences: ['target', 'source'] }] } }
const originalCall = api.connections.call
api.connections.call = async (method, params, owner) => {
  if (method === 'connection.binding.inspect' && 'operationId' in params && params.operationId === input.operationId) {
    proof.calls.push(method); proof.targets.push(owner); proof.requests.push({ method, input: structuredClone(params), owner })
    if (JSON.stringify(owner) !== JSON.stringify(hostingTarget)) throw Error('Original recovery fixture owner required')
    return structuredClone(state === 'refused' ? refusal : { binding: null, current: null, operation: null, grants: [] }) as ConnectionResultMap[typeof method]
  }
  return originalCall(method, params, owner)
}
Object.assign(proof, { setRecovery(value: typeof state) {
  state = value; proof.setScenario('unbound')
  useAppStore.setState({ connectorRoomDrafts: {}, connectorRoomIntents: { [input.operationId]: { target, hostingTarget, method: 'connection.bind', input, phase: 'may-have-dispatched' } } })
}, recovery: () => ({ state, operationId: input.operationId, groupId: input.externalConversationId, intents: useAppStore.getState().connectorRoomIntents }) })

/** Original product dialog; only its external inspection leaf is the controlled typed original receipt. */
function SetupRecoveryDialogFixture() {
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => { Object.assign(proof, { dialogReady: true }) }, [])
  return <DesktopClientUiProvider><SettingsNavigation.Provider value={{
    open: section => { proof.routes.push(section) }, openToolkit() {}, openHost() {}, chooseAgent() {}, openMoteLark() {},
    channelPresentation: settingsCatalog.channelPresentation, channelEntries: settingsCatalog.channelEntries,
    openChannel: origin => { proof.routes.push(origin.connection.adapterId) }
  }}><MoteWorkfaceContext.Provider value={null}>
    <button type="button" id="recovery-fixture-open" className="small-button" style={{ alignSelf: 'flex-start', margin: 24 }} ref={trigger} onClick={() => setOpen(true)}>Open original setup</button>
    {open ? <AgentConnectorDialog mode="existing" original={{ target, session, name: session.label, connectionId: connection.config.connectionId,
      hostingTarget, channel: 'feishu', identity: { providerId: session.providerId, executorId: session.executorId ?? undefined } }}
      onClose={() => setOpen(false)} returnFocus={() => trigger.current} /> : null}
  </MoteWorkfaceContext.Provider></SettingsNavigation.Provider></DesktopClientUiProvider>
}

createRoot(document.getElementById('root')!).render(<SetupRecoveryDialogFixture />)
proof.ready = true
