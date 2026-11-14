import type { RuntimeEvent, SessionControl } from '../../../shared/contracts'
import type { SpaceMemberTarget } from '@agentmux/core/space-member'
import type { SpaceMountMemberSurface } from '../../../shared/space-mount'
import { createRunServiceProjection } from './run-service-projection'
import type { TerminalSessionSource } from './terminal-session-source'

/** Adapts one fixed Main member handle to the existing Terminal reader; no global lookup. */
export function spaceMemberTerminalSource(surface: SpaceMountMemberSurface, target: SpaceMemberTarget,
  subscribe: (listener: (event: RuntimeEvent) => void) => () => void): TerminalSessionSource {
  const expected = { hostId: surface.initial.hostId, agentSessionId: target.agentSessionId, runId: target.expectedRun.runId }
  const assertControl = (control: SessionControl | undefined) => {
    if (control?.kind !== 'agent' || control.hostId !== expected.hostId || control.agentSessionId !== expected.agentSessionId || control.run.runId !== expected.runId)
      throw new Error('This view targets another original Session or Run. The original member reader is kept.')
  }
  return {
    services: createRunServiceProjection(),
    refresh: async control => { assertControl(control); return await surface.call('read', {}) },
    sessions: {
      attach: async (control, afterByte) => { assertControl(control); return await surface.call('attach', { afterByte: afterByte ?? 0 }) },
      refreshAttachment: async (control, attachmentId, afterByte) => { assertControl(control); return await surface.call('refreshAttachment', { attachmentId, afterByte }) },
      replay: (attachmentId, afterByte) => surface.call('replay', { attachmentId, afterByte }),
      detach: attachmentId => surface.call('detach', { attachmentId }),
      resize: (attachmentId, cols, rows) => surface.call('resize', { attachmentId, cols, rows }),
      write: async (control, data, source = 'user', observation) => { assertControl(control); await surface.call('write', { data, source, ...(observation ? { observation } : {}) }) },
      paste: async (control, text, terminalData, observation) => { assertControl(control); await surface.call('paste', { text, terminalData, ...(observation ? { observation } : {}) }) },
      onEvent: (listener, control) => { assertControl(control); return subscribe(listener) }
    }
  }
}
