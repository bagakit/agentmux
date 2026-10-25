import type { LauncherResumeRow } from './launcher-resume'
import type { OpenHttpLinkOrigin } from './open-destination'
import type { TakeoverSource } from './session-takeover'

/** Provider-native identities and Core Session identities remain separate. */
export function launcherResumeActionIdentity(row: LauncherResumeRow): { agentSessionId?: string | undefined; nativeSessionId?: string | undefined } {
  const candidate = row.candidate
  return 'native' in candidate
    ? { agentSessionId: candidate.native.managed?.agentSessionId, nativeSessionId: candidate.nativeSessionId }
    : { agentSessionId: candidate.agentSessionId, nativeSessionId: candidate.nativeSessionId ?? candidate.nativeHandle?.sessionId }
}

/** Freeze the selected Core candidate and the exact Launcher presentation independently. */
export function launcherTakeoverSource(row: LauncherResumeRow, origin: OpenHttpLinkOrigin): TakeoverSource {
  const candidate = row.candidate
  const details = { hostId: candidate.hostId, cwd: candidate.workspacePath, executorId: candidate.executorId, label: row.name,
    origin: { ...origin }, diagnostic: JSON.stringify({ source: candidate, state: { label: row.stateLabel, detail: row.stateDetail } }, null, 2) }
  return 'native' in candidate
    ? { ...details, kind: 'saved', ...(candidate.native.managed ? { agentSessionId: candidate.native.managed.agentSessionId } : {}),
      nativeSource: structuredClone(candidate.native.source) }
    : { ...details, kind: 'saved', agentSessionId: candidate.agentSessionId }
}
