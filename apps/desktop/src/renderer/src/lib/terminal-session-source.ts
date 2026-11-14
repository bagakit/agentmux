import type { api } from './api'
import type { SessionControl, SessionSnapshot, TerminalAttachResult } from '../../../shared/contracts'
import type { RunServiceProjection } from './run-service-projection'

/** One original finite Session reader. The caller owns its exact source/Run and release. */
export type TerminalSessionSource = {
  sessions: Pick<typeof api.sessions, 'replay' | 'detach' | 'resize' | 'write' | 'paste' | 'onEvent'> & {
    attach(...args: Parameters<typeof api.sessions.attach>): Promise<TerminalAttachResult>
    refreshAttachment(...args: Parameters<typeof api.sessions.refreshAttachment>): Promise<TerminalAttachResult>
  }
  refresh(control: SessionControl): Promise<SessionSnapshot>
  services: RunServiceProjection
}
