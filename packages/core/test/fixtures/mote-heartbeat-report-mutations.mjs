import { createHash } from 'node:crypto'
const host = 'apps/host/src/mote-heartbeat-report.ts', service = 'packages/core/src/public-rpc-service.ts', codec = 'packages/core/src/mote/dialogue-contract.ts', store = 'packages/core/src/mote/dialogue-store.ts'
const owners = new Set(['packages/core/src/mote/heartbeat-report.ts', codec, store, service, 'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/rpc-native-codec.ts', host, 'apps/host/src/mote-dialogue.ts', 'apps/host/src/mote-presence.ts', 'apps/host/src/scheduled-input-source.ts', 'packages/core/test/helpers/mote-input-owner.ts'])
export const mutations = {
  'loose-idea-mapping': { pattern: 'strict public report rejects JSON coercion', edits: [['packages/core/src/mote/heartbeat-report.ts', "try { parseFileReadResult({ resource, result: { status: 'directory' } }, request) } catch { return fail(code) }", 'void request']] },
  'coerce-report-disposition': { pattern: 'strict public report rejects JSON coercion', edits: [['packages/core/src/mote/heartbeat-report.ts', 'includes(p.disposition as string)', 'includes(String(p.disposition))']] },
  'coerce-read-kind': { pattern: 'strict public report rejects JSON coercion', edits: [[codec, "!['main','work','heartbeat'].includes(p.kind as string)", "!['main','work','heartbeat'].includes(String(p.kind))"]] },
  'unqualified-source': { pattern: 'rejects a role source', edits: [[host, 'await options.qualifyHeartbeatSource(input.source, main, context)', 'void input.source', 2]] },
  'later-caller-run': { pattern: 'reporting Agent recovery', edits: [[service, 'current.session.run.runId !== originalCallerRun?.runId', 'false']] },
  'drop-journal-report': { pattern: 'actual source CLI records', edits: [[store, 'for (const source of sources) {', "for (const source of sources) { if (source.kind === 'heartbeat') continue;"]] },
  'ignore-report-body': { pattern: 'same operation payload conflicts', edits: [[host, "JSON.stringify({ kind: 'heartbeat-report', ...input, author })", "JSON.stringify({ kind: 'heartbeat-report', ...input, report: undefined, author })"], [codec, '||!dequal(link.report,(input as MoteHeartbeatReportRequest).report)', '']] },
  'promote-unknown-idea': { pattern: 'exact ordinary Idea read', edits: [[host, "ideaEvidence.push({ actionIndex, observedAt, status: 'unconfirmed', issue })", "ideaEvidence.push({ actionIndex, observedAt, status: 'observed-file', revision: action.revision })"]] },
  'uncommitted-note': { pattern: 'committed original Note event', edits: [[host, "event.status !== 'committed' || ", '']] },
  'foreign-note-actor': { pattern: 'committed original Note event', edits: [[host, ' || event.actor.id !== caller.agentSessionId', '']] },
  'foreign-idea-resource': { pattern: 'foreign Idea resource', edits: [[host, 'resource.zoneId !== target.zoneId ||', 'false ||']] },
  'foreign-coverage': { pattern: 'declared partial work page', edits: [[host, '!sameMoteDialogue(check.next.identity, main.identity) || ', '']] },
  'retarget-historical-role': { pattern: 'old-role report retains', edits: [[host, 'source: input.source, author, report:', 'source: { ...input.source, mainRoleRevision: main.roleRevision! }, author, report:']] }
}
export function instrumentHeartbeatReport(source, file) {
  if (!owners.has(file)) return source
  const selected = process.env.MOTE_HEARTBEAT_REPORT_MUTATION
  if (selected && !mutations[selected]) throw Error('Unknown report mutation')
  let loaded = source, edits = 0
  for (const [owner, before, after, count = 1] of mutations[selected]?.edits ?? []) if (owner === file) {
    if (loaded.split(before).length !== count + 1) throw Error('Exact report production mutation anchor: ' + selected + ' ' + file)
    loaded = loaded.replaceAll(before, after); edits += count
  }
  const sha = value => createHash('sha256').update(value).digest('hex')
  const entry = JSON.stringify({ file, originalSHA256: sha(source), loadedSHA256: sha(loaded), mutation: edits ? selected : null, edits })
  return process.env.MOTE_HEARTBEAT_REPORT_LOADED ? "import {appendFileSync as __heartbeatReportLoaded} from 'node:fs';\n__heartbeatReportLoaded(" + JSON.stringify(process.env.MOTE_HEARTBEAT_REPORT_LOADED) + ',' + JSON.stringify(entry + '\n') + ');\n' + loaded : loaded
}
