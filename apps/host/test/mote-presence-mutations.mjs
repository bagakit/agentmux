import { createHash } from 'node:crypto'
export const presenceSharedSource = {
  'packages/core/src/public-rpc-service.ts': [
    {line:'type MoteQuickPreferencesPort'}, {line:'  moteQuickPreferences?: MoteQuickPreferencesPort'},
    {start:"    const preferences = p.kind === 'quick'",end:'    if (Object.hasOwn(AGENTMUX_RPC_CONTROL_METHODS, method))'}
  ],
  'apps/host/src/host.ts': [
    {line:"import { HostMoteQuickPreferences }"}, {line:"import { createHostMotePresence }"},
    {line:'  let motePresence:'}, {line:'() => motePresence?.dispose()'},
    {start:'  if (configurationPath && content?.files && moteMain && goals)',end:'  const service = {'},
    {line:'    ...(moteQuickPreferences ? { moteQuickPreferences } : {}),'}, {line:'    await motePresence?.start()'}
  ],
  'packages/core/src/agentmux-cli-commands.ts': [
    {line:"  command('space.mote.preferences.read'"}, {line:"  command('space.mote.preferences.save'"}
  ],
  'packages/core/package.json': [{line:'    "./automatic-input-source":'}]
}
export function presenceSharedSlices(path,source) {
  return (presenceSharedSource[path] ?? []).map(boundary=>{
    let content
    if(boundary.line){const lines=source.split('\n').filter(line=>line.includes(boundary.line));if(lines.length!==1)throw Error('Presence source line must be unique: '+path+' '+boundary.line);content=lines[0]}
    else{if(source.split(boundary.start).length!==2||source.split(boundary.end).length!==2)throw Error('Presence source boundaries must be unique: '+path);const start=source.indexOf(boundary.start),end=source.indexOf(boundary.end,start);if(end<=start)throw Error('Presence source boundaries changed order: '+path);content=source.slice(start,end)}
    return {boundary,sha256:createHash('sha256').update(content).digest('hex')}
  })
}
export const presenceMutants = {
  'preferences-host': ['packages/core/src/public-rpc-service.ts', "p.kind === 'quick' ? this.ports.moteQuickPreferences", "p.kind === 'quick' ? undefined"],
  'role-generation': ['packages/core/src/mote-preferences.ts', 'conversationRevision: same ? before.conversationRevision', 'conversationRevision: false ? before.conversationRevision'],
  'standing-implicit-trigger': ['packages/core/src/agent-session-recovery/service.ts', "input.trigger === undefined || input.trigger === 'manual'", "input.trigger === 'manual'"],
  'standing-admission': ['packages/core/src/agent-session-recovery/continuity-attempt.ts', '} else if (standing) {', '} else if (false && standing) {'],
  'standing-revoked': ['packages/core/src/agent-session-recovery/continuity-attempt.ts', '!intent?.active || intent.operationId', '(!intent) || intent.operationId'],
  'interval-update': ['apps/host/src/continuous-progress-loop-manager.ts', 'everyMs: p.everyMs, revision: p.expectedRevision', 'everyMs: loop.everyMs, revision: p.expectedRevision'],
  'startup-hard-failure': ['apps/host/src/mote-presence.ts', "} catch (error) { serviceIssue = 'Starting original Mote maintenance", "} catch (error) { throw error; serviceIssue = 'Starting original Mote maintenance"],
  'source-isolation': ['packages/core/src/continuous-progress-scheduler.ts', "return [...(this.sourceLoops.get(sourceId) ?? [])].sort((a,b) => a[1]-b[1]).map(([id]) => structuredClone(this.loops.get(id)!))", 'return this.list()'],
  'headless-observation': ['apps/host/src/mote-presence.ts', 'for (const [id, reading] of readings) {', 'for (const [id, reading] of []) {'],
  'source-reobservation': ['apps/host/src/mote-presence.ts', "if (reading.status === 'unconfirmed') dirty.add(id)", "if (false) dirty.add(id)"],
  'disabled-resume': ['apps/host/src/mote-presence.ts', "const method = loop.managedSource!.revision === main.roleRevision && main.current && !preference.enabled ? 'schedule.pause' : 'schedule.cancel'", "const method = 'schedule.cancel'"],
  'role-fence': ['apps/host/src/mote-presence.ts', 'main.roleRevision !== loop.managedSource.revision', 'false']
}
export function instrumentPresence(original, path, surface) {
  const mutant = process.env.MOTE_PRESENCE_MUTANT, report = process.env.MOTE_PRESENCE_LOADED
  if (mutant && !Object.hasOwn(presenceMutants, mutant)) throw Error('Unknown Mote presence mutant')
  const selected = mutant && presenceMutants[mutant]
  let source = original
  if (selected && selected[0] === path) {
    if (source.split(selected[1]).length !== 2) throw Error('Presence mutant must modify one actual loaded owner: ' + mutant)
    source = source.replace(selected[1], selected[2])
  }
  const owned = path === 'apps/desktop/src/main/mote-preferences-ipc.ts' || /^apps\/host\/src\/(mote-presence|mote-quick-preferences|mote-quick-mode|continuous-progress-loop-manager|host)\.ts$|^packages\/core\/src\/(mote-preferences|automatic-input-source|continuous-progress-scheduler|agentmux-cli-commands|client|public-rpc-service|agent-session-recovery\/(?:continuity-attempt|service))\.ts$/u.test(path)
  if (report && owned) {
    const hash = s => createHash('sha256').update(s).digest('hex')
    const fact = { path, surface, originalSHA256: hash(original), loadedSHA256: hash(source), ...(presenceSharedSource[path] ? {sharedSlices:presenceSharedSlices(path,original)} : {}), ...(source !== original ? { mutant } : {}) }
    source = "import { appendFileSync as __presenceFact } from 'node:fs'; __presenceFact(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(fact) + '\n') + ');\n' + source
  }
  return source
}
