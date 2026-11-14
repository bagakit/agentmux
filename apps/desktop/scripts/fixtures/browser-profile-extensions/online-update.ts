import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { get } from 'node:https'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { extensionFixtureId, signExtensionFixtureCrx } from './https-source.mjs'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(read: () => any, label: string) { for (let i = 0; i < 400; i++) { const value = await read(); if (value) return value; await pause(25) } throw Error('Actual extension update result missing: ' + label) }

/** Original Profile/CLI/GUI/native owners; confirmation input is an explicit private fixture. */
export async function onlineUpdate(ctx: any) {
  const { home, out, phase, base, profileId, retained, profiles, browsers, host, store, receipt, cli, token, source, setConsent } = ctx
  const online = process.env.EXTENSIONS_ONLINE_BASE!, original = 'extension-original-browser'
  let originalContents: any
  const state = (path: string): Promise<any> => new Promise((resolve, reject) => {
    get(online + path, response => { const chunks: Buffer[] = []; response.on('data', bytes => chunks.push(bytes)); response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())) } catch (error) { reject(error) } }); response.on('error', reject) }).on('error', reject)
  })
  const createPage = async (id: string, expectedVersion: string) => {
    await browsers.create(id, base, undefined, profileId); browsers.setBounds(id, { x: 0, y: 0, width: 660, height: 500 })
    const contents = browsers.nativeOwner(id).view.webContents
    const facts = await until(async () => { const value = await contents.executeJavaScript('({...document.documentElement.dataset})'); return value.extensionBackground ? value : null }, 'content/background version ' + expectedVersion)
    assert.equal(facts.extensionVersion, expectedVersion); assert.equal(facts.extensionBackground, expectedVersion)
    return { contents, facts }
  }
  const capture = async (name: string) => {
    await host.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await writeFile(join(out, name), (await host.webContents.capturePage()).toPNG())
  }
  const apply = (id: string, review: any, success = true) => cli(['apply', '--profile', id, '--expected-revision', review.expectedRevision, '--review', review.reviewId], success)
  const prepare = async (id: string, operation: string, extensionId?: string, success: boolean | 'observe' = true) => cli(['prepare', '--profile', id, '--expected-revision', token(id), '--operation-id', operation,
    ...(extensionId ? ['--recorded-source', '--extension', extensionId] : ['--update-manifest', online + '/signed.xml?private=original-source', '--addon-id', receipt.addonId])], success)
  if (phase === 'second') {
    assert.equal(profiles.sessions.observedSession(profileId), undefined)
    assert.equal(profiles.sessions.observedSession(retained.coldProfileId), undefined)
    const approvals = receipt.approvals.length
    const coldCheck = await cli(['check', '--profile', retained.coldProfileId, '--extension', retained.coldExtensionId])
    assert.equal(coldCheck.status, 'current'); assert.equal(coldCheck.currentVersion, '2.0.0')
    const pendingCheck = await cli(['check', '--profile', profileId, '--extension', retained.extensionId])
    assert.equal(pendingCheck.status, 'unknown'); assert.match(pendingCheck.reason, /remains unconfirmed/)
    const pending = await cli(['ls', '--profile', profileId, '--operation-id', retained.unknownReview.reviewId])
    assert.equal(pending.receipt, null); assert.equal(pending.pending[0].operationId, retained.unknownReview.reviewId)
    assert.equal((await apply(profileId, retained.unknownReview, false)).error.code, 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED')
    assert.equal(receipt.approvals.length, approvals)
    assert.equal(profiles.sessions.observedSession(profileId), undefined); assert.equal(profiles.sessions.observedSession(retained.coldProfileId), undefined)
    receipt.cases.push({ kind: 'second-process-exact-manifest-check-does-not-warm-cold-Profile-or-replay-original-unknown', coldCheck, pendingCheck, pending: pending.pending, originalProfileId: profileId, extensionId: retained.extensionId })
    const page = await createPage(original, '2.0.0'); originalContents = page.contents
    assert.equal(Number(page.facts.extensionCount), retained.storageCount + 1, 'The approved v2 content script reuses the original extension storage after restart')
    const list = await cli(['ls', '--profile', profileId, '--operation-id', retained.updateReviewId])
    assert.equal(list.extensions[0].id, retained.extensionId); assert.equal(list.extensions[0].nativeId, retained.nativeId); assert.equal(list.extensions[0].sha256, retained.sha256)
    assert.equal(list.extensions[0].version, '2.0.0'); assert.equal(list.extensions[0].application.state, 'loaded')
    assert.equal((await originalContents.session.cookies.get({ name: 'profile-signin' }))[0]?.value, 'private-cookie-preserved')
    assert.equal(await originalContents.executeJavaScript('localStorage.getItem("profile-note")'), 'original-note-kept')
    receipt.cases.push({ kind: 'second-process-approved-v2-functional-content-background-storage-and-original-identity', originalProfileId: profileId, extensionId: retained.extensionId, facts: page.facts })
    return
  }
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }), key = pair.publicKey.export({ type: 'spki', format: 'der' })
  receipt.addonId = extensionFixtureId(key)
  const publish = async (version: string, activePair = pair, manifestVersion = version) => {
    const publicKey = activePair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const zip = await readFile(await source(version, { zip: true, key: publicKey }))
    await writeFile(join(home, 'online/signed.crx'), signExtensionFixtureCrx(activePair, zip))
    await writeFile(join(home, 'online/signed.xml'), `<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="${receipt.addonId}"><updatecheck codebase="${online}/signed.crx" version="${manifestVersion}"/></app></gupdate>`)
  }
  await browsers.create(original, base, undefined, profileId); browsers.setBounds(original, { x: 0, y: 0, width: 660, height: 500 })
  originalContents = browsers.nativeOwner(original).view.webContents
  await until(() => originalContents.executeJavaScript('Boolean(document.querySelector("input"))'), 'original page')
  await originalContents.executeJavaScript('document.querySelector("input").value="original-unsent-form";localStorage.setItem("profile-note","original-note-kept");true')
  await originalContents.session.cookies.set({ url: base, name: 'profile-signin', value: 'private-cookie-preserved', expirationDate: Date.now() / 1000 + 3600 })
  await publish('1.0.0'); const initialReview = (await prepare(profileId, 'update-original-install')).review; await apply(profileId, initialReview)
  const extensionId = initialReview.extensionId
  await publish('2.0.0')
  await state('/hold-next-manifest')
  const checking = cli(['check', '--profile', profileId, '--extension', extensionId])
  try {
    await until(async () => (await state('/slow-state')).started, 'held exact manifest response')
    await profiles.updateProfile(profileId, { label: 'Original update environment' }, token(profileId))
    assert.equal((await state('/slow-state')).open, true, 'Profile edit completes while the actual update manifest response remains open')
  } finally { await state('/release-slow') }
  assert.equal((await checking).status, 'unknown')
  receipt.cases.push({ kind: 'manifest-check-does-not-lock-Profile-configuration-and-rechecks-original-revision' })
  const approvalCount = receipt.approvals.length
  const checked = await cli(['check', '--profile', profileId, '--extension', extensionId])
  assert.equal(checked.status, 'update-available', 'The original manifest check must report its newer version without applying it')
  assert.equal(checked.currentVersion, '1.0.0'); assert.equal(checked.candidateVersion, '2.0.0'); assert.equal(JSON.stringify(checked).includes('private=original-source'), false)
  assert.equal(profiles.sessions.nativeSession(profileId).extensions.getExtension(receipt.addonId)?.version, '1.0.0'); assert.equal(receipt.approvals.length, approvalCount)
  receipt.cases.push({ kind: 'actual-compiled-public-CLI-check-reports-v2-without-package-application', checked })
  browsers.setBounds(original, null)
  host.webContents.debugger.attach('1.3')
  const ready = (expression: string) => until(() => host.webContents.executeJavaScript(expression), expression)
  const button = (text: string) => `Array.from(document.querySelectorAll('button')).find(node=>node.textContent.trim()===${JSON.stringify(text)})`
  const click = async (expression: string) => {
    await ready(`(()=>{const node=${expression};return Boolean(node&&!node.disabled)})()`)
    const point = await host.webContents.executeJavaScript(`(()=>{const node=${expression};node.scrollIntoView({block:'center'});const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await host.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await host.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }
  await click('document.querySelector(".browser-profile-extensions__heading")')
  await click(`document.querySelector('[aria-label="Refresh extension load state"]')`); await ready(`!document.querySelector('[aria-label="Refresh extension load state"]').disabled`)
  await click(button('Check for updates')); await ready('Boolean(document.querySelector("[data-extension-update=update-available]"))')
  await capture('first-update-available.png')
  await click(button('Prepare update for review')); await ready('Boolean(document.querySelector(".browser-profile-extensions__review"))')
  const review = await host.webContents.executeJavaScript('document.querySelector(".browser-profile-extensions__review").textContent')
  assert.match(review, /v1\.0\.0 → v2\.0\.0/); assert.match(review, /API: tabs/)
  await capture('first-update-review.png')
  setConsent(false); await click(button('Review and update…')); await ready('document.querySelector(".browser-profile-extensions__notice")?.textContent.includes("Nothing changed")')
  assert.equal((await cli(['ls', '--profile', profileId])).extensions[0].version, '1.0.0')
  assert.equal(profiles.sessions.nativeSession(profileId).extensions.getExtension(receipt.addonId)?.version, '1.0.0')
  setConsent(true); await click(button('Review and update…'))
  const installed = await until(async () => { const list = await cli(['ls', '--profile', profileId]); return list.extensions.find((item: any) => item.id === extensionId && item.version === '2.0.0') }, 'trusted GUI update original identity')
  await ready('!document.querySelector(".browser-profile-extensions__review")'); await capture('first-update-installed.png'); host.webContents.debugger.detach()
  const v2 = await createPage('extension-updated-functional-page', '2.0.0'); browsers.setBounds('extension-updated-functional-page', null)
  assert.equal(await originalContents.executeJavaScript('document.querySelector("input").value'), 'original-unsent-form')
  receipt.cases.push({ kind: 'actual-production-GUI-added-permission-review-cancel-keeps-v1-and-explicit-update-runs-v2', extensionId, facts: v2.facts, nativeId: installed.nativeId })
  const actor = { kind: 'user', id: 'private-native-update-fixture', verified: true }
  const coldProfile = await profiles.createProfile('Cold update environment', 'create-cold-update-environment', actor)
  const coldReview = (await prepare(coldProfile.id, 'cold-update-install')).review; await apply(coldProfile.id, coldReview)
  await publish('3.0.0', generateKeyPairSync('rsa', { modulusLength: 2048 }))
  assert.equal((await prepare(profileId, 'wrong-update-key', extensionId, false)).ok, false)
  await publish('2.0.0', pair, '3.0.0')
  assert.equal((await prepare(profileId, 'wrong-update-version', extensionId, false)).ok, false)
  await writeFile(join(home, 'online/signed.xml'), 'not a standard manifest')
  assert.equal((await cli(['check', '--profile', profileId, '--extension', extensionId])).status, 'unknown')
  await publish('3.0.0'); const unknownReview = (await prepare(profileId, 'original-update-unknown', extensionId)).review
  const save = store.setExtensions.bind(store); let actualNativeAcknowledged = false
  store.setExtensions = async (...args: any[]) => { if (args[3].operationId === unknownReview.reviewId) { assert.equal(profiles.sessions.nativeSession(profileId).extensions.getExtension(receipt.addonId)?.version, '3.0.0'); actualNativeAcknowledged = true; throw Error('Private update metadata ACK refusal after actual native load') } return save(...args) }
  assert.equal((await apply(profileId, unknownReview, false)).error.code, 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED'); store.setExtensions = save
  assert.equal(actualNativeAcknowledged, true); assert.equal((await cli(['check', '--profile', profileId, '--extension', extensionId])).status, 'unknown')
  assert.equal((await cli(['ls', '--profile', profileId])).extensions[0].version, '2.0.0')
  receipt.cases.push({ kind: 'wrong-key-version-and-source-cannot-replace-v2-and-original-native-unknown-remains-inspectable', actualNativeAcknowledged, operationId: unknownReview.reviewId })
  await publish('2.0.0')
  await originalContents.session.cookies.flushStore(); originalContents.session.flushStorageData()
  const updateReviewId = receipt.approvals.find((item: any) => item.kind === 'update' && item.confirmed && item.review.version === '2.0.0').review.reviewId
  const retainedResult = { profileId, extensionId, nativeId: installed.nativeId, sha256: installed.sha256, storageCount: Number(v2.facts.extensionCount), updateReviewId, unknownReview, coldProfileId: coldProfile.id, coldExtensionId: coldReview.extensionId }
  await writeFile(join(home, 'retained.json'), JSON.stringify(retainedResult)); receipt.retained = retainedResult
}
