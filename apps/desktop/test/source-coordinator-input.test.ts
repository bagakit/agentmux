// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '../src/renderer/src/store'
import { sourceCoordinatorInput, sourceCoordinatorInputKey, type SourceCoordinatorInput } from '../src/renderer/src/lib/source-coordinator-input'

const initial = useAppStore.getState()
afterEach(() => useAppStore.setState(initial, true))
function input(createOperationId = 'original-C'): SourceCoordinatorInput {
  return { kind: 'source-coordinator-launch',
    origin: { launcherId: 'region:original-slot', slot: { tabId: 'original-tab', regionId: 'original-slot' }, project: { id: 'project-in-A', hostId: 'B-in-A', path: '/original/B/project' }, names: { agentName: ' Original Agent ', tabName: ' Original Tab ' } },
    target: { hostId: 'B-in-A', reference: { runtimeId: 'original-B', spaceId: 'original-space' }, zoneId: 'original-zone', workspaceId: 'project-in-B' },
    request: { hostId: 'local', sourceCoordinator: { hostId: 'local', runtimeId: 'original-A', resourceRuntimeId: 'original-B', workingDirectory: 'device-home' },
      agentSessionId: 'original-SID', createOperationId, executorId: 'selected-A-executor', executorRevision: 'original-revision', workspacePath: '/original/A/home',
      toolWorkspace: { id: 'project-in-A', hostId: 'B-in-A', path: '/original/B/project' }, prompt: '  exact original input\n', agentMuxNote: ' Separate note\n', launchOptions: { original_unknown_option: 'keep exact value' } },
    submitted: false, association: { operationId: 'original-L-' + createOperationId, submitted: false } }
}

it('the real native user-document projection keeps one complete C/L intention and opaque neighbors without registering mounted navigation', () => {
  const original = input(), key = sourceCoordinatorInputKey(original.request), opaque = { kind: 'future-private-input', bytes: [' Keep ', null, { unknown: true }] }
  useAppStore.setState({ mountedSpaceInputs: { unrelated: opaque }, selectedSpaceMount: null })
  const before = useAppStore.getState()
  useAppStore.getState().retainSourceCoordinatorInput(key, () => original)
  const retained = sourceCoordinatorInput(useAppStore.getState().mountedSpaceInputs, key)!
  expect(retained.request).toBe(original.request); expect(retained.association.operationId).toBe(original.association.operationId)
  const partialize = useAppStore.persist.getOptions().partialize!
  const recovered = JSON.parse(JSON.stringify(partialize(useAppStore.getState())))
  expect(sourceCoordinatorInput(recovered.mountedSpaceInputs, key)).toEqual(original)
  expect(recovered.mountedSpaceInputs.unrelated).toEqual(opaque)
  expect(useAppStore.getState().selectedSpaceMount).toBeNull(); expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().layouts).toBe(before.layouts)
})

it('an explicit new C on the same raw SID keeps the old request and L instead of merging or changing the frozen carrier', () => {
  const one = input(), two = input('another-C'), first = sourceCoordinatorInputKey(one.request), second = sourceCoordinatorInputKey(two.request)
  useAppStore.setState({ mountedSpaceInputs: {} })
  useAppStore.getState().retainSourceCoordinatorInput(first, () => one)
  useAppStore.getState().retainSourceCoordinatorInput(second, () => two)
  expect(sourceCoordinatorInput(useAppStore.getState().mountedSpaceInputs, first)).toBe(one)
  expect(sourceCoordinatorInput(useAppStore.getState().mountedSpaceInputs, second)).toBe(two)
  expect(() => useAppStore.getState().retainSourceCoordinatorInput(first, current => ({ ...current!, target: { ...current!.target, hostId: 'another-carrier' } }))).toThrow('retained')
  expect(() => useAppStore.getState().retainSourceCoordinatorInput(first, current => ({ ...current!, request: { ...current!.request, prompt: 'a replacement first input' } }))).toThrow('retained')
  expect(sourceCoordinatorInput(useAppStore.getState().mountedSpaceInputs, first)).toBe(one)
})

it('future bytes at an original intention key survive an attempted write and do not remove healthy work', () => {
  const original = input(), key = sourceCoordinatorInputKey(original.request), future = { kind: 'source-coordinator-launch-vNext', exact: [' original ', { opaque: 1 }] }
  useAppStore.setState({ mountedSpaceInputs: { [key]: future } })
  const before = useAppStore.getState()
  expect(() => useAppStore.getState().retainSourceCoordinatorInput(key, () => original)).toThrow('retained')
  expect(useAppStore.getState().mountedSpaceInputs).toBe(before.mountedSpaceInputs)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(JSON.parse(JSON.stringify(useAppStore.getState().mountedSpaceInputs))).toEqual({ [key]: future })
})
