/** Proof input ownership only; product behavior is checked through mounted public consumers. */
export function goalEditProofScope(path, source) {
  const line = fragment => {
    const matches = source.split('\n').filter(value => value.includes(fragment))
    if (matches.length !== 1) throw Error('One nonempty Goal draft input scope is required: ' + path + ' / ' + fragment)
    return matches[0]
  }
  if (path === 'apps/desktop/src/renderer/src/store.ts') {
    const start = source.indexOf('  deleteDemand(id) {'), end = source.indexOf('  toggleProjectRail()', start)
    if (start < 0 || end <= start) throw Error('The original Goal delete consumer must be included')
    return [line("import type { GoalEditDrafts }"), line('goalEditDrafts: GoalEditDrafts'), line('goalEditDrafts?: GoalEditDrafts'),
      line('goalEditDrafts: state.goalEditDrafts,'), line('goalEditDrafts: {},'), source.slice(start, end)].join('\n')
  }
  if (path === 'apps/desktop/src/renderer/src/components/GoalProperties.tsx') return [
    line("import { editGoalDraft, saveGoalDrafts }"), line('const tagsDraft ='), line('const tags ='), line('<label>Tags<TextInput')
  ].join('\n')
  return source
}
