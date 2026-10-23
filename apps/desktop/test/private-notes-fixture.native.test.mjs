import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { desktopFixture, preparePrivateNotesIsolation } from '../scripts/fixtures/settings-cli/desktop.mjs'

test('private App preflight accepts an internal alias and refuses escaped state, locator or Notes before spawn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notes-fixture-')), outside = await mkdtemp(join(tmpdir(), 'notes-outside-'))
  try {
    const privateHome = join(root, 'home'), state = join(root, 'state'), internal = join(root, 'notes')
    await mkdir(privateHome); await mkdir(state); await mkdir(internal)
    const internalAlias = join(root, 'notes-alias'), externalAlias = join(root, 'external-alias')
    await symlink(internal, internalAlias); await symlink(outside, externalAlias)
    const locator = join(state, 'notes-location.json')
    const writeLocator = directory => writeFile(locator, JSON.stringify({ schemaVersion: 1, directory, operations: {}, pending: null }) + '\n')
    await writeLocator(internalAlias)
    assert.equal((await preparePrivateNotesIsolation({ root, privateHome, environment: { AGENTMUX_STATE_DIRECTORY: state } })).directory, internalAlias)
    const children = new Set()
    const launch = stateDirectory => desktopFixture({ desktopRoot: new URL('..', import.meta.url).pathname, root, privateHome,
      environment: { AGENTMUX_STATE_DIRECTORY: stateDirectory }, children, connections: new Set(),
      waitFor: () => { throw new Error('No App or inspector may start for an escaped private path') } })('rejected')
    await assert.rejects(launch(externalAlias), /private Notes locator needs this fixture state directory/u)
    await writeLocator(externalAlias)
    const before = await readFile(locator)
    await assert.rejects(launch(state), /original private Notes locator is outside/u)
    assert.deepEqual(await readFile(locator), before)
    await rm(locator)
    const outsideLocator = join(outside, 'unread-locator')
    await writeFile(outsideLocator, 'deliberately not JSON\n'); await symlink(outsideLocator, locator)
    await assert.rejects(launch(state), /locator must resolve inside/u)
    assert.equal(children.size, 0)
    assert.deepEqual(await readdir(outside), ['unread-locator'])
    assert.equal(await readFile(outsideLocator, 'utf8'), 'deliberately not JSON\n')
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})

test('private App preflight initializes only its own fresh state and Notes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notes-fixture-'))
  try {
    const privateHome = join(root, 'home'), state = join(root, 'state')
    const result = await preparePrivateNotesIsolation({ root, privateHome, environment: { AGENTMUX_STATE_DIRECTORY: state } })
    assert.deepEqual(JSON.parse(await readFile(result.locator, 'utf8')), {
      schemaVersion: 1, directory: join(privateHome, '.agentmux', 'notes'), operations: {}, pending: null
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})
