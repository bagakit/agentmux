import { desktopUserFragments } from './desktop-user-state'
import {
  environmentDraftKey,
  parseEnvironmentDraft,
  type ProfileEnvironmentDraft
} from './browser-profile-environment-form'

type Record = { active: ProfileEnvironmentDraft | null; retained: ProfileEnvironmentDraft[] }
type Document = { schema: 'agentmux.profile-environment-drafts.v1'; profiles: { [id: string]: Record } }
const member = 'profileEnvironmentDrafts' as const
function parse(raw: string | null | undefined): Document {
  if (raw === null || raw === undefined)
    return { schema: 'agentmux.profile-environment-drafts.v1', profiles: {} }
  const value = JSON.parse(raw)
  if (
    value?.schema !== 'agentmux.profile-environment-drafts.v1' ||
    !value.profiles ||
    typeof value.profiles !== 'object' ||
    Array.isArray(value.profiles) ||
    Object.keys(value).some((key) => !['schema', 'profiles'].includes(key))
  )
    throw new Error('The original Profile drafts could not be read. Their bytes are retained.')
  for (const [id, record] of Object.entries(value.profiles) as [string, Record][]) {
    if (
      !id ||
      !record ||
      typeof record !== 'object' ||
      Object.keys(record).some((key) => !['active', 'retained'].includes(key)) ||
      !Array.isArray(record.retained)
    )
      throw new Error('The original Profile draft identity is unreadable. Its bytes are retained.')
    if (record.active !== null) parseEnvironmentDraft(record.active)
    record.retained.forEach(parseEnvironmentDraft)
  }
  return value
}

/** A narrow input adapter on the original Desktop document; it owns no native/application facts. */
export const profileEnvironmentDrafts = {
  async load() {
    await desktopUserFragments.load(member, parse)
  },
  get(id: string): Record | undefined {
    return parse(desktopUserFragments.read(member)).profiles[id]
  },
  write(id: string, draft: ProfileEnvironmentDraft, retain?: ProfileEnvironmentDraft) {
    const document = parse(desktopUserFragments.read(member)),
      previous = document.profiles[id] ?? { active: null, retained: [] }
    const retained = [...previous.retained]
    if (
      retain &&
      environmentDraftKey(retain) !== environmentDraftKey(draft) &&
      !retained.some((value) => environmentDraftKey(value) === environmentDraftKey(retain))
    )
      retained.push(retain)
    document.profiles[id] = { active: structuredClone(draft), retained }
    desktopUserFragments.write(member, JSON.stringify(document))
  },
  clearSubmitted(id: string, submitted: ProfileEnvironmentDraft): boolean {
    const document = parse(desktopUserFragments.read(member)),
      record = document.profiles[id]
    if (!record?.active || environmentDraftKey(record.active) !== environmentDraftKey(submitted)) return false
    if (record.retained.length) document.profiles[id] = { ...record, active: null }
    else delete document.profiles[id]
    desktopUserFragments.write(member, JSON.stringify(document))
    return true
  },
  discard(id: string) {
    const document = parse(desktopUserFragments.read(member)),
      record = document.profiles[id]
    if (!record) return
    if (record.retained.length) document.profiles[id] = { ...record, active: null }
    else delete document.profiles[id]
    desktopUserFragments.write(member, JSON.stringify(document))
  },
  restore(id: string, index: number) {
    const document = parse(desktopUserFragments.read(member)),
      record = document.profiles[id],
      draft = record?.retained[index]
    if (!record || !draft) throw new Error('The earlier draft is no longer available. Refresh draft storage.')
    const retained = record.retained.filter((_, i) => i !== index)
    if (record.active && environmentDraftKey(record.active) !== environmentDraftKey(draft))
      retained.push(record.active)
    document.profiles[id] = { active: draft, retained }
    desktopUserFragments.write(member, JSON.stringify(document))
    return structuredClone(draft)
  },
  retainActive(id: string) {
    const document = parse(desktopUserFragments.read(member)),
      record = document.profiles[id]
    if (!record?.active) return
    const retained = [...record.retained]
    if (!retained.some((draft) => environmentDraftKey(draft) === environmentDraftKey(record.active!)))
      retained.push(record.active)
    document.profiles[id] = { active: null, retained }
    desktopUserFragments.write(member, JSON.stringify(document))
  },
  async checkpoint() {
    await desktopUserFragments.checkpoint(member)
  }
}
