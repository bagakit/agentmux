import assert from 'node:assert/strict'
import { get } from 'node:https'
import { signExtensionFixtureCrx, extensionFixtureId } from './https-source.mjs'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(read: () => any, label: string) { for (let i = 0; i < 400; i++) { const value = await read(); if (value) return value; await pause(25) } throw Error('Actual online extension result missing: ' + label) }
const keypair = () => generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicKey = (pair: ReturnType<typeof keypair>) => pair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer
const nativeId = extensionFixtureId
/** This case uses the original Manager/Store/WCV, public CLI/server, renderer/preload/IPC and component. */
export async function onlineInstall(ctx: any) {
  const { home, out, phase, base, profileId, retained, profiles, browsers, host, receipt, cli, token, contents: visibleContents, source, setConsent } = ctx
  const uiOnly = process.env.EXTENSIONS_CASE === "online-ui"
  const online = process.env.EXTENSIONS_ONLINE_BASE!, original = 'extension-original-browser'
  let retainedContents: any
  const contents = () => retainedContents ?? visibleContents()
  const capture = async (name: string) => {
    await host.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await writeFile(join(out, name), (await host.webContents.capturePage()).toPNG())
  }
  const sourceState = (path: string): Promise<any> => new Promise((resolve, reject) => {
    get(online + path, response => { const chunks: Buffer[] = []; response.on('data', bytes => chunks.push(bytes)); response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())) } catch (error) { reject(error) } }); response.on('error', reject) }).on('error', reject)
  })
  const prepare = async (id: string, args: string[], operation: string, success: boolean | 'observe' = true) => cli(['prepare', '--profile', id, '--expected-revision', token(id), '--operation-id', operation, ...args], success)
  const apply = (id: string, review: any, success = true) => cli(['apply', '--profile', id, '--expected-revision', review.expectedRevision, '--review', review.reviewId], success)
  const fresh = async (id: string, name: string) => {
    await browsers.create(name, base, undefined, id); browsers.setBounds(name, { x: 0, y: 0, width: 660, height: 500 })
    const page = browsers.nativeOwner(name).view.webContents
    const facts = await until(async () => { const value = await page.executeJavaScript('({...document.documentElement.dataset})'); return value.extensionBackground ? value : null }, 'actual content script and background reply')
    assert.equal(facts.extensionVersion, '1.0.0'); assert.equal(facts.extensionBackground, '1.0.0'); return facts
  }
  if (phase === 'second') {
    const cold = await cli(['ls', '--profile', profileId]); assert.equal(cold.extensions[0].application.state, 'unknown'); assert.equal(profiles.sessions.observedSession(profileId), undefined)
    await browsers.create(original, base, undefined, profileId); browsers.setBounds(original, { x: 0, y: 0, width: 660, height: 500 }); retainedContents = visibleContents()
    const facts = await until(async () => { const value = await contents().executeJavaScript('({...document.documentElement.dataset})'); return value.extensionBackground ? value : null }, 'same original approved package after restart')
    const listed = await cli(['ls', '--profile', profileId, '--operation-id', retained.reviewId])
    assert.equal(listed.extensions[0].id, retained.extensionId); assert.equal(listed.extensions[0].nativeId, retained.nativeId); assert.equal(listed.extensions[0].sha256, retained.sha256); assert.equal(facts.extensionVersion, '1.0.0')
    assert.equal((await contents().session.cookies.get({ name: 'profile-signin' }))[0]?.value, 'private-cookie-preserved')
    assert.equal(await contents().executeJavaScript('localStorage.getItem("profile-note")'), 'original-note-kept')
    receipt.cases.push({ kind: 'second-process-approved-online-original-package-and-profile', originalProfileId: profileId, extensionId: retained.extensionId, sameBrowserId: original, facts, receipt: listed.receipt })
    const approvals = receipt.approvals.length, pending = await cli(['ls', '--profile', retained.unknownProfile, '--operation-id', retained.unknownReview.reviewId])
    assert.equal(pending.receipt, null); assert.equal(pending.pending[0].operationId, retained.unknownReview.reviewId)
    const refused = await apply(retained.unknownProfile, retained.unknownReview, false)
    assert.equal(refused.error.code, 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED'); assert.equal(receipt.approvals.length, approvals); assert.equal(profiles.sessions.observedSession(retained.unknownProfile), undefined)
    receipt.cases.push({ kind: 'second-process-original-online-unknown-not-dispatched-or-confirmed', originalProfileId: retained.unknownProfile, operationId: retained.unknownReview.reviewId, nativeNotAcquired: true })
    browsers.setBounds(original, null); await capture('second-online-installed.png')
    return
  }
  await mkdir(join(home, 'online'), { recursive: true })
  await browsers.create(original, base, undefined, profileId); browsers.setBounds(original, { x: 0, y: 0, width: 660, height: 500 }); retainedContents = visibleContents()
  await until(() => contents().executeJavaScript('Boolean(document.querySelector("input"))'), 'original page')
  await contents().executeJavaScript('document.querySelector("input").value="original-unsent-form";localStorage.setItem("profile-note","original-note-kept");true')
  await contents().session.cookies.set({ url: base, name: 'profile-signin', value: 'private-cookie-preserved', expirationDate: Date.now() / 1000 + 3600 })
  // A real cookie is available to this website Session at the HTTPS acquisition host; Node must not inherit it.
  await contents().session.cookies.set({ url: online, name: 'download-sentinel', value: 'site-cookie-must-not-travel', secure: true, expirationDate: Date.now() / 1000 + 3600 })
  const pair = keypair(), key = publicKey(pair), zipPath = await source('1.0.0', { zip: true, key: key.toString('base64') })
  await copyFile(zipPath, join(home, 'online/package.zip'))
  if (!uiOnly) {
  // Hold a real HTTPS response body open while the original Manager performs a metadata edit.
  const slow = prepare(profileId, ['--package-url', online + '/slow.zip'], 'online-held-source', false); void slow.catch(() => {})
  try {
    await until(async () => (await sourceState('/slow-state')).started, 'the actual held HTTPS request')
    const changed = await profiles.updateProfile(profileId, { label: 'Private online environment' }, token(profileId))
    assert.equal(changed.label, 'Private online environment')
    assert.equal((await sourceState('/slow-state')).open, true, 'Profile metadata must complete while the real acquisition response is still open')
  } finally { await sourceState('/release-slow') }
  const stale = await slow; assert.equal(stale.error.code, 'BROWSER_PROFILE_CONFIGURATION_CONFLICT')
  receipt.cases.push({ kind: 'actual-held-HTTPS-source-does-not-occupy-Profile-configuration-and-publish-rechecks-revision', metadataCompletedBeforeResponseRelease: true, stalePreparationCode: stale.error.code })
  const input = ['--package-url', online + '/package.zip'], first = (await prepare(profileId, input, 'online-original-review')).review
  assert.equal(first.source.retrieval.origin, online); assert.equal(profiles.sessions.nativeSession(profileId).extensions.getAllExtensions().length, 0)
  assert.equal((await prepare(profileId, input, 'online-original-review')).review.sha256, first.sha256)
  setConsent(false); assert.equal((await apply(profileId, first)).outcome, 'cancelled'); assert.equal(profiles.sessions.nativeSession(profileId).extensions.getAllExtensions().length, 0)
  }
  setConsent(true); browsers.setBounds(original, null)
  const ready = (expression: string) => until(() => host.webContents.executeJavaScript(expression), expression)
  await ready('Boolean(document.querySelector(".browser-profile-extensions__heading"))')
  host.webContents.debugger.attach('1.3')
  const click = async (expression: string) => {
    await ready(`(()=>{const node=${expression};return Boolean(node&&!node.disabled)})()`)
    const point = await host.webContents.executeJavaScript(`(()=>{const node=${expression};if(!node)throw Error('Missing actual GUI control');node.scrollIntoView({block:'center'});const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await host.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await host.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }
  const button = (text: string) => `Array.from(document.querySelectorAll('button')).find(node=>node.textContent.trim()===${JSON.stringify(text)})`
  await click('document.querySelector(".browser-profile-extensions__heading")')
  // The standalone fixture keeps a fixed Profile prop; explicitly consume the original metadata refresh action after its concurrent edit.
  await click(`document.querySelector('[aria-label="Refresh extension load state"]')`)
  await ready(`!document.querySelector('[aria-label="Refresh extension load state"]').disabled`)
  await click(button('From URL…'))
  await host.webContents.executeJavaScript('document.querySelector(".browser-profile-extensions__online input[type=url]").focus()')
  await host.webContents.debugger.sendCommand('Input.insertText', { text: online + '/package.zip' })
  await capture('first-online-source.png')
  await click(button('Prepare for review'))
  await ready('Boolean(document.querySelector(".browser-profile-extensions__review"))')
  await capture('first-online-review.png')
  await click(button('Review and install…'))
  const installed = await until(async () => { const result = await cli(['ls', '--profile', profileId]); return result.extensions.length ? result.extensions[0] : null }, 'GUI original native install')
  assert.equal(installed.nativeId, nativeId(key)); assert.equal(installed.application.state, 'loaded')
  const active = await fresh(profileId, 'online-functional-page')
  assert.equal(await contents().executeJavaScript('document.querySelector("input").value'), 'original-unsent-form')
  receipt.cases.push({ kind: 'actual-https-public-cli-and-pointer-production-GUI-install-with-functional-content-background', originalProfileId: profileId, extensionId: installed.id, nativeId: installed.nativeId, facts: active, source: installed.source, originalInputKept: true })
  browsers.setBounds('online-functional-page', null)
  await capture('first-online-installed.png'); host.webContents.debugger.detach()
  if (uiOnly) {
    const nativeMask = await host.webContents.executeJavaScript('({mask:getComputedStyle(document.documentElement).getPropertyValue("--native-disclosure-mask"),sprite:Boolean(document.querySelector("[data-semantic-icon-sprite]"))})')
    assert.match(nativeMask.mask, /data:image\/svg/); assert.equal(nativeMask.sprite, true)
    receipt.cases.push({kind: 'current-production-GUI-presentation-and-original-Theme-runtime', nativeMask})
    return
  }
  const actor = { kind: 'user', id: 'private-native-fixture', verified: true }
  const signedProfile = await profiles.createProfile('Private signed XML', 'create-online-xml-profile', actor), signedPair = keypair(), signedKey = publicKey(signedPair)
  const signedZip = await readFile(await source('1.0.0', { zip: true, key: signedKey.toString('base64') }))
  await writeFile(join(home, 'online/signed.crx'), signExtensionFixtureCrx(signedPair, signedZip))
  await writeFile(join(home, 'online/signed.xml'), `<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="${nativeId(signedKey)}"><updatecheck codebase="${online}/signed.crx" version="1.0.0"/></app></gupdate>`)
  const signedReview = (await prepare(signedProfile.id, ['--update-manifest', online + '/signed.xml', '--addon-id', nativeId(signedKey)], 'online-signed-review')).review
  assert.equal(signedReview.source.signature, 'package-verified'); await apply(signedProfile.id, signedReview)
  receipt.cases.push({ kind: 'actual-standard-XML-signed-CRX3-to-native-function', originalProfileId: signedProfile.id, extensionId: signedReview.extensionId, facts: await fresh(signedProfile.id, 'online-signed-functional') })
  const jsonProfile = await profiles.createProfile('Private WebExtensions JSON', 'create-online-json-profile', actor), jsonPair = keypair(), jsonKey = publicKey(jsonPair)
  const files = { 'manifest.json': JSON.stringify({ manifest_version: 3, name: 'WebExtensions protocol fixture', version: '1.0.0', key: jsonKey.toString('base64'), browser_specific_settings: { gecko: { id: 'private-fixture@example.invalid' } }, permissions: ['storage'] }) }
  const jsonZip = Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)]))))
  await writeFile(join(home, 'online/webextension.xpi'), jsonZip)
  const feed = (hash: string) => JSON.stringify({ addons: { 'private-fixture@example.invalid': { updates: [{ version: '1.0.0', update_link: online + '/webextension.xpi', update_hash: 'sha256:' + hash }] } } })
  await writeFile(join(home, 'online/webextensions.json'), feed('0'.repeat(64)))
  const badHash = await prepare(jsonProfile.id, ['--update-manifest', online + '/webextensions.json', '--addon-id', 'private-fixture@example.invalid'], 'online-bad-manifest-hash', 'observe')
  assert.equal(badHash.ok, false, 'A standard manifest digest mismatch must not become an installable review'); assert.match(badHash.error.message, /manifest hash/)
  await writeFile(join(home, 'online/webextensions.json'), feed(createHash('sha256').update(jsonZip).digest('hex')))
  const jsonReview = (await prepare(jsonProfile.id, ['--update-manifest', online + '/webextensions.json', '--addon-id', 'private-fixture@example.invalid'], 'online-json-review')).review
  assert.equal(jsonReview.source.signature, 'not-verified'); await apply(jsonProfile.id, jsonReview)
  assert.equal(profiles.sessions.nativeSession(jsonProfile.id).extensions.getExtension(nativeId(jsonKey))?.version, '1.0.0')
  receipt.cases.push({ kind: 'actual-standard-WebExtensions-JSON-hash-check-and-original-native-package-load', originalProfileId: jsonProfile.id, extensionId: jsonReview.extensionId, signature: 'not-verified', compatibility: 'Host-loadable ZIP subset; no Firefox API or Mozilla signing claim' })
  const failed = await prepare(profileId, ['--package-url', online + '/failure'], 'online-http-failure', false); assert.equal(failed.ok, false)
  const unknownProfile = await profiles.createProfile('Private unknown install', 'create-online-unknown-profile', actor), unknownPair = keypair()
  await copyFile(await source('1.0.0', { zip: true, key: publicKey(unknownPair).toString('base64') }), join(home, 'online/unknown.zip'))
  const unknownReview = (await prepare(unknownProfile.id, ['--package-url', online + '/unknown.zip'], 'online-unknown-install')).review
  const save = ctx.store.setExtensions.bind(ctx.store)
  let actualNativeAcknowledged = false
  ctx.store.setExtensions = async (...args: any[]) => { if (args[3].operationId === unknownReview.reviewId) { assert.equal(profiles.sessions.nativeSession(unknownProfile.id).extensions.getAllExtensions().length, 1); actualNativeAcknowledged = true; throw Error('Private metadata ACK failure after actual native install') } return save(...args) }
  assert.equal((await apply(unknownProfile.id, unknownReview, false)).error.code, 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED'); assert.equal(actualNativeAcknowledged, true); ctx.store.setExtensions = save
  const pending = await cli(['ls', '--profile', unknownProfile.id, '--operation-id', unknownReview.reviewId]); assert.equal(pending.receipt, null); assert.equal(pending.pending[0].operationId, unknownReview.reviewId)
  assert.equal(await contents().executeJavaScript('document.querySelector("input").value'), 'original-unsent-form'); assert.equal(await contents().executeJavaScript('localStorage.getItem("profile-note")'), 'original-note-kept')
  receipt.cases.push({ kind: 'actual-online-HTTP-failure-and-after-native-unknown-retain-original-page-and-operation', actualNativeAcknowledged, pending: pending.pending, originalInputKept: true })
  await contents().session.cookies.flushStore(); contents().session.flushStorageData()
  const retainedResult = { profileId, extensionId: installed.id, nativeId: installed.nativeId, sha256: installed.sha256, profileCount: profiles.listProfiles().length, reviewId: receipt.approvals.find((item: any) => item.confirmed && item.kind === 'install').review.reviewId, unknownProfile: unknownProfile.id, unknownReview }
  await writeFile(join(home, 'retained.json'), JSON.stringify(retainedResult)); receipt.retained = retainedResult
}
