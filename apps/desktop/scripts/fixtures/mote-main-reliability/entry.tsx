import '../mote-conversation-start/entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { useLauncherState } from '../../../src/renderer/src/lib/launcher-state'
import { requestPmoTeamsTopicFloatingClose } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'

const original = (window as any).moteStartCapture, calls: Array<{ method: string; input: unknown }> = []
const read = api.spatial.read
let holdNext = false
api.spatial.read = async () => {
  if (holdNext) { holdNext = false; return await new Promise(() => {}) }
  return await read()
}
api.spatial.openAgent = async input => { calls.push({ method: 'agent.open', input }); return await new Promise(() => {}) }
api.moteDialogue.inspectSetup = async input => {
  calls.push({ method: 'setup.inspect', input })
  return { operationId: input.creation.operationId, ownerHostId: input.creation.hostId, record: null, reference: null,
    creation: 'unconfirmed', binding: 'unconfirmed', source: 'unconfirmed', issue: '原开始请求的创建结果尚未确认，原消息与已有工作保留。核对这个请求不会重复发送。' }
}
api.moteDialogue.advanceSetup = async input => { calls.push({ method: 'setup.advance', input }); throw Error('This private observation does not advance an unknown creation') }
original.history(false)
const facts = () => ({ ...original.facts(), calls, references: useAppStore.getState().moteMainCreationReferences,
  welcomeDrafts: useLauncherState.getState().drafts, sourceInputs: useAppStore.getState().sourceFilesInputs })
Object.assign(window, { moteReliabilityCapture: { ready: true, facts, theme: original.theme,
  holdNext() { holdNext = true },
  sourceFailure() {
    requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
    api.spaceMounts.call = async () => ({ runtimeId: 'private-original-source' }) as never
    api.sourceFiles.resolve = async () => ({ status: 'unconfirmed', issue: { code: 'SOURCE_FILES_UNAVAILABLE', message: 'The original Source directory is unconfirmed. Its files, editors and requests are kept; check that Source folder before discovering candidates.' } })
    api.files.readDirectory = async () => { throw Error('Could not read the original directory. Its editors and Agent work are kept.') }
    const state = useAppStore.getState(), workspace = state.config!.workspaces.find(value => value.id === '__scratch__')!
    useAppStore.setState({ activeWorkspaceId: workspace.id, mainSurface: 'workbench', explorerCollapsed: { ...state.explorerCollapsed, [workspace.id]: false } })
  }
} })
