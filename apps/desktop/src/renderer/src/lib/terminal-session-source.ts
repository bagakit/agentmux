import type { api } from './api'
import type { SessionControl, SessionSnapshot } from '../../../shared/contracts'
import type { RunServiceProjection } from './run-service-projection'

/** One original finite Session reader. The caller owns its exact source/Run and release. */
export type TerminalSessionSource = {
  sessions: Pick<typeof api.sessions, 'attach' | 'refreshAttachment' | 'replay' | 'detach' | 'resize' | 'write' | 'paste' | 'onEvent'>
  refresh(control: SessionControl): Promise<SessionSnapshot>
  services: RunServiceProjection
}
