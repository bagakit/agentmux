import assert from 'node:assert/strict'

/** Identity/layout oracle; live navigation and cold native admission are separate facts. */
export function persistentTask(tab: any) {
  assert.ok(tab, 'The original Task Tab must be present; no replacement may be seeded')
  const regions = Object.fromEntries(Object.entries(tab.regions).map(([id, value]) => {
    const region = value as Record<string, unknown>
    const fields = ['kind', 'regionId', 'workspaceId', ...(region.kind === 'browser'
      ? ['browserId', 'profileId', 'mode', 'url', 'title']
      : region.kind === 'file' ? ['path', 'preview'] : ['sessionId'])]
    assert.equal(region.regionId, id)
    if (region.kind === 'browser') {
      for (const field of ['browserId', 'profileId', 'url']) assert.equal(typeof region[field], 'string', 'Original Browser must retain ' + field)
    } else if (region.kind === 'agent' || region.kind === 'terminal') assert.equal(typeof region.sessionId, 'string')
    return [id, Object.fromEntries(fields.filter(field => Object.hasOwn(region, field) && region[field] !== undefined).map(field => [field, region[field]]))]
  }))
  return { id: tab.id, layout: tab.layout, ...(tab.space === undefined ? {} : { space: tab.space }), ...(tab.name === undefined ? {} : { name: tab.name }), regions }
}
