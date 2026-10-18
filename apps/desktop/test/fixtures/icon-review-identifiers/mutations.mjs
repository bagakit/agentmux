const actions = ['edit', 'restore', 'import-theme', 'import', 'restore-all', 'source-refresh']
export const iconIdentifierMutations = [...actions.map(action => ({ name: action + '-uuid', action })),
  { name: 'rewrite-original-history' }, { name: 'freeze-event-time', action: 'edit' }]
export function mutateIconIdentifierSource(code, name) {
  const mutation = iconIdentifierMutations.find(item => item.name === name)
  if (!mutation) throw Error('Unknown icon history mutation')
  if (name === 'rewrite-original-history') {
    const before = 'history:stored.history,unresolved:checked.unresolved'
    if (code.split(before).length !== 2) throw Error('Original history mutation anchor changed')
    return code.replace(before, 'history:stored.history.map(event=>({...event,event_id:mintObjectId()})),unresolved:checked.unresolved')
  }
  const lines = code.split('\n'), indices = lines.flatMap((line, index) => line.includes('event_id:mintObjectId()') && line.includes("action:'" + mutation.action + "'") ? [index] : [])
  if (indices.length !== 1) throw Error('Icon event mutation anchor changed: ' + name)
  const index = indices[0]
  lines[index] = name === 'freeze-event-time' ? lines[index].replace('at:new Date().toISOString()', 'at:new Date(0).toISOString()') : lines[index].replace('event_id:mintObjectId()', 'event_id:crypto.randomUUID()')
  return lines.join('\n')
}
