import assert from 'node:assert/strict'

// A leaf of the original ordinary-process restart. No Runtime, seed or reply owner.
export function createNativeFocusReadProof({ command, session, spaceId, regionId, receipt, run }) {
  const proof = receipt.focusRead = { passed: false, route: 'compiled CLI → original Host → Main controlBridge → original Renderer', observations: [] }
  let originalSource, originalInput, originalCursor
  const read = input => command(['focus', 'read', '--input', '-'], 'focus.read', true, input)
  const sourceOwner = async (probe, source) => {
    const value = await command(['app', 'inspect', '--input', '-'], 'app.inspect', true,
      { conversation: { hostId: 'local', agentSessionId: session.agentSessionId, expectedRunId: session.run.runId } })
    assert.equal(value.observation.main.pid, probe.child.pid)
    assert.equal(value.observation.main.renderer.id, source.rendererId)
    assert.equal(value.observation.main.documentGeneration, source.documentGeneration, 'Focus uses the original Main document generation')
    proof.observations.push({ label: 'original Main document owner', observation: value.observation })
  }
  const observed = (label, page) => { proof.observations.push({ label, page }); return page }
  const originalAgent = page => {
    const items = page.items.filter(item => item.agent?.agentSessionId === session.agentSessionId)
    assert.equal(items.length, 1, 'The original Session appears once in its exact Project')
    const item = items[0]
    assert.equal(item.availability, 'observed'); assert.equal(item.reference.hostId, 'local')
    assert.deepEqual(item.agent, { hostId: 'local', agentSessionId: session.agentSessionId, run: { runId: session.run.runId } })
    assert.equal(item.locations.status, 'confirmed')
    assert.ok(item.locations.occurrences.some(location => location.hostId === 'local' && location.regionId === regionId), 'Original Region comes from the original spatial owner')
    assert.ok(item.state && item.kind && item.name, 'Nonempty current facts, never merely an exported method')
    return item
  }
  const retainedRun = async (label, before) => {
    const after = await run()
    assert.equal(after.runId, before.runId); assert.equal(after.pid, before.pid); assert.equal(after.state, 'running')
    assert.equal(after.acceptedInputBytes, before.acceptedInputBytes, 'Focus observations submit no input')
    proof.observations.push({ label, before, after })
  }
  return {
    async first(probe) {
      const before = await run()
      const skill = await command(['focus', '--skill'], null), help = await command(['focus', 'read', '--help'], null)
      assert.ok(skill.includes('focus read') && skill.includes('focus ls'), 'Compiled public capability is discoverable')
      assert.ok(help.includes('--input'), 'Compiled Focus input contract is discoverable')
      proof.discovery = { skill, help }
      const directory = observed('original directory', await command(['focus', 'ls'], 'focus.ls'))
      const scope = { kind: 'project', hostId: 'local', projectSpaceId: spaceId }
      assert.equal(directory.items.filter(item => JSON.stringify(item.scope) === JSON.stringify(scope)).length, 1)
      const all = observed('original Project all', await read({ scope, selection: { kind: 'all' } }))
      const item = originalAgent(all)
      const loaded = await probe.cdp.evaluate('window.agentmux.ui.readLoadedIdentity()')
      assert.equal(all.source.rendererId, loaded.renderer.id, 'Focus provenance identifies the actual ordinary Renderer')
      assert.deepEqual(all.source, directory.source)
      assert.ok(all.source.clientId && Number.isSafeInteger(all.source.documentGeneration))
      await sourceOwner(probe, all.source)
      originalSource = all.source
      const exact = observed('exact displayed member', await read({ scope, selection: { kind: 'members', references: [item.reference] } }))
      assert.equal(exact.items.length, 1); assert.deepEqual(originalAgent(exact).reference, item.reference)
      const foreign = { hostId: 'foreign-proof', contextId: item.reference.contextId }
      originalInput = { scope, selection: { kind: 'members', references: [item.reference, foreign] }, limit: 1 }
      const first = observed('bounded member page one', await read(originalInput))
      assert.equal(first.items.length, 1); assert.ok(first.nextCursor); assert.equal(first.coverage.complete, false)
      originalCursor = first.nextCursor
      const second = observed('bounded member page two', await read({ ...originalInput, cursor: originalCursor }))
      assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null)
      const pages = { items: [...first.items, ...second.items] }
      originalAgent(pages)
      const unknown = pages.items.find(value => JSON.stringify(value.reference) === JSON.stringify(foreign))
      assert.ok(unknown); assert.equal(unknown.availability, 'unconfirmed'); assert.equal(unknown.agent, null)
      assert.equal(unknown.state, null); assert.equal(unknown.name, null); assert.deepEqual(unknown.locations.occurrences, [])
      const wrong = observed('wrong Host Project scope', await read({ scope: { ...scope, hostId: foreign.hostId }, selection: { kind: 'members', references: [item.reference] } }))
      assert.equal(wrong.status, 'unconfirmed'); assert.equal(wrong.coverage.complete, false)
      assert.ok(wrong.issues.some(issue => issue.code === 'FOCUS_GROUP_UNCONFIRMED'))
      assert.ok(wrong.items.every(value => value.agent === null && value.availability !== 'observed'))
      proof.originalMain = probe.controlBridgeOwner; proof.loadedRenderer = loaded.renderer
      await retainedRun('original Run retained through public reads', before)
    },
    async unavailable() {
      const failure = await command(['focus', 'read', '--input', '-'], 'focus.read', false, originalInput)
      assert.equal(failure.error.code, 'CONTROL_UNAVAILABLE', 'Missing original App is explicit unavailable, never an empty successful page')
      proof.unavailable = failure
    },
    async restored(probe) {
      const before = await run()
      const changed = observed('old document continuation after normal restart', await read({ ...originalInput, cursor: originalCursor }))
      assert.equal(changed.status, 'changed'); assert.equal(changed.coverage.complete, false)
      assert.equal(changed.items.length, 0); assert.equal(changed.nextCursor, null)
      assert.ok(changed.issues.some(issue => issue.code === 'FOCUS_CONTINUATION_CHANGED'))
      assert.notDeepEqual(changed.source, originalSource)
      const all = observed('same original Project after zero-seed restart', await read({ scope: originalInput.scope, selection: { kind: 'all' } }))
      originalAgent(all)
      const loaded = await probe.cdp.evaluate('window.agentmux.ui.readLoadedIdentity()')
      assert.equal(all.source.rendererId, loaded.renderer.id); assert.deepEqual(all.source, changed.source)
      await sourceOwner(probe, all.source)
      await retainedRun('restored Run retained through public reads', before)
      proof.restoredMain = probe.controlBridgeOwner; proof.passed = true
    }
  }
}
