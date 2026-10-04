/** Read saved public space.ls/goal.ls receipts; no user Store or Runtime is opened. */
import { readFile } from 'node:fs/promises'
import { previewGoalContentReferences } from '../src/shared/goal-content-references.ts'
const [catalogFile, goalsFile] = process.argv.slice(2)
if (!catalogFile || !goalsFile) throw new Error('Usage: node preview-goal-content-references.ts SPACE_LS_JSON GOAL_LS_JSON')
const unwrap = (value: any) => value.result ?? value
const catalog = unwrap(JSON.parse(await readFile(catalogFile, 'utf8'))).catalog
const goals = unwrap(JSON.parse(await readFile(goalsFile, 'utf8'))).goals
if (!catalog || !['spaces', 'zones', 'tabs', 'regions', 'bindings', 'locations'].every(key => Array.isArray(catalog[key])) || !Array.isArray(goals)) throw new Error('Complete original public catalog and Goal list receipts are required.')
const rows = previewGoalContentReferences(catalog, goals).map(row => {
  // Existing Mote maintenance only: a foreign bound Zone is never its identity.
  const isMote = row.contentRefs.every(ref => {
    const zones = catalog.zones.filter((zone: any) => zone.zoneId === ref.zoneId && zone.kind === 'home' && zone.hostId === ref.hostId && zone.workspaceId === ref.workspaceId)
    const spaces = catalog.spaces.filter((space: any) => space.kind === 'mote' && space.hostId === ref.hostId && JSON.stringify([space.spaceId, 'home']) === ref.zoneId)
    return zones.length === 1 && spaces.length === 1
  })
  return row.state === 'confirmed' && !isMote ? { ...row, contentRefs: [], state: 'unresolved', reason: 'Confirmed resource is not an original Mote home Zone.' } : row
})
console.log(JSON.stringify({ schema: 'agentmux.goal-content-reference-preview.v1', readOnly: true, rows }, null, 2))
