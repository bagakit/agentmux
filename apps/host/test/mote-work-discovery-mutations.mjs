export function instrumentWorkDiscovery(code, file, mutation = process.env.MOTE_WORK_MUTATION) {
  const edits = {
    'projection-disconnected': ['apps/host/src/mote-dialogue.ts', 'entries: selected.slice(0, limit).map', 'entries: selected.slice(0, 0).map'],
    'all-managed-hidden': ['apps/host/src/mote-dialogue.ts', 'return !(loop.managedSource?.sourceId === maintenanceSource && loop.managedSource.revision === main.roleRevision)', 'return !loop.managedSource'],
    'wrong-schedule-owner': ['apps/host/src/mote-dialogue.ts', "ownerHostId: main.target.expectedResource.hostId, coverage: 'current-main-schedules'", "ownerHostId: main.current?.hostId ?? main.target.expectedResource.hostId, coverage: 'current-main-schedules'"],
    'join-delayed': ['apps/host/src/mote-dialogue.ts', 'const observationsPromise = Promise.all(page.links.map', 'const observationsPromise = await Promise.all(page.links.map'],
    'consumer-disconnected': ['packages/core/src/public-rpc-service.ts', "return await this.call('schedule.list', { target: { hostId: reference.hostId, agentSessionId: session.agentSessionId,\n            providerId: session.providerId, workspacePath: session.workspacePath } }, context)", 'return { schedules: [] }'],
  }
  if (!mutation) return code
  const edit = edits[mutation]
  if (!edit) throw Error('Unknown work discovery mutation: ' + mutation)
  if (file !== edit[0]) return code
  if (code.split(edit[1]).length !== 2) throw Error('The production mutation anchor is not unique: ' + mutation)
  return code.replace(edit[1], edit[2])
}
