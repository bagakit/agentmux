import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const host = 'apps/host/src/mote-quick-preferences.ts'
const codec = 'packages/core/src/mote/preferences.ts'
export const moteDiscoveryVariants = {
  'collapse-source-failure': { file: host, before: "else if (locations.status === 'rejected') issues.locations = String(locations.reason)", after: "else if (locations.status === 'rejected') throw locations.reason" },
  'lose-independent-executors': { file: host, before: "if (executors.status === 'fulfilled' && executors.value) choices.executors = executors.value", after: "if (executors.status === 'fulfilled' && executors.value && locations.status === 'fulfilled' && locations.value) choices.executors = executors.value" },
  'lose-independent-locations': { file: host, before: "if (locations.status === 'fulfilled' && locations.value) Object.assign(choices, locations.value)", after: "if (locations.status === 'fulfilled' && locations.value && executors.status === 'fulfilled' && executors.value) Object.assign(choices, locations.value)" },
  'save-full-discovery': { file: host, before: "const read = await this.readOriginal({ kind: 'quick', target: input.target }), baseline = input.baseline", after: "const read = await this.read({ kind: 'quick', target: input.target }), baseline = input.baseline" },
  'skip-required-executor': { file: host, before: 'if (values.executorId !== read.defaults.executorId && values.executorId) {', after: 'if (false) {' },
  'skip-required-main': { file: host, before: 'if (roleChanged && values.conversation) {', after: 'if (false) {' },
  'ignore-file-conflict': { file: host, before: 'if (!sameBaseline && !(input.action && sameResource && sameControls))', after: 'if (false)' },
  'null-means-empty': { file: host, before: "if (!catalog) throw new Error('The original Mote display discovery is unavailable. Its saved Main and settings are kept.')", after: 'if (!catalog) return { conversations: [], destinations: [] }' },
  'accept-foreign-issue': { file: codec, before: "const issues = fields(c.issues, ['executors', 'locations'], [], code)", after: "const issues = fields(c.issues, ['executors', 'locations', 'foreign'], [], code)" },
  'accept-empty-issue': { file: codec, before: "if (!issue.trim()) fail('Mote choice discovery requires its original failure reason.', code)", after: '/* omitted scoped reason validation */' },
  'source-only-forges-choices': { file: host, before: 'let choices: MoteQuickChoices | null = null', after: 'let choices: MoteQuickChoices | null = { executors: [], conversations: [], destinations: [] }' },
  'ignore-requested-projection': { file: codec, before: "if (input?.kind === 'quick' && (input.includeChoices === false ? p.choices !== null : p.choices === null)) fail('Mote choice discovery does not match the original read projection.', code)", after: '/* original requested discovery projection ignored */' },
  'ignore-single-source-projection': { file: codec, before: "if ((source === 'locations') !== (choices.executors === null) || (source === 'executors') !== (choices.destinations === null)) fail('Mote candidates do not match the requested source.', code)", after: '/* requested candidate source projection ignored */' }
}

export function transformMoteDiscoverySource(source, path) {
  if (![host, codec].includes(path)) return source
  const selected = process.env.MOTE_DISCOVERY_MUTATION
  if (selected && !moteDiscoveryVariants[selected]) throw new Error('Unknown Mote discovery source mutation')
  const mutation = selected && moteDiscoveryVariants[selected]
  let loaded = source
  if (mutation && mutation.file === path) {
    if (source.split(mutation.before).length !== 2) throw new Error('One exact current discovery mutation anchor is required: ' + selected)
    loaded = source.replace(mutation.before, mutation.after)
  }
  if (process.env.MOTE_DISCOVERY_LOADED) {
    const sha = value => createHash('sha256').update(value).digest('hex')
    appendFileSync(process.env.MOTE_DISCOVERY_LOADED, JSON.stringify({ path, loader: 'vitest', sourceSHA256: sha(source),
      rawSHA256: sha(readFileSync(resolve(root, path))), loadedSHA256: sha(loaded), ...(loaded === source ? {} : { mutation: selected }) }) + '\n')
  }
  return loaded
}
