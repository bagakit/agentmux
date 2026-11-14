import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The original harness owns all App launches and cleanup; setup never approves.
export async function prepareDailyExtensionFixture({ repositoryRoot, privateHome, evidenceDirectory, pageUrl }) {
  const helper = join(repositoryRoot, 'apps/desktop/scripts/fixtures/browser-profile-extensions/https-source.mjs')
  const { extensionFixtureId, signExtensionFixtureCrx, startExtensionHttpsFixture } = await import(pathToFileURL(helper))
  const require = createRequire(join(repositoryRoot, 'apps/desktop/package.json'))
  const { zipSync, strToU8 } = require('fflate')
  const page = new URL(pageUrl), hostPattern = page.protocol + '//' + page.hostname + '/*'
  assert.ok(['http:', 'https:'].includes(page.protocol) && ['127.0.0.1', 'localhost'].includes(page.hostname), 'Use only this original private loopback fixture')
  const helperSha256 = createHash('sha256').update(await readFile(helper)).digest('hex')
  const fixture = await startExtensionHttpsFixture(privateHome, evidenceDirectory)
  const artifacts = []
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }), key = pair.publicKey.export({ type: 'spki', format: 'der' })
  const addonId = extensionFixtureId(key), manifestUrl = fixture.origin + '/signed.xml'
  const publishVersion = async version => {
    assert.ok(version === '1.0.0' || version === '2.0.0')
    const manifest = { manifest_version: 3, name: 'Private daily Profile helper', version, key: key.toString('base64'),
      permissions: version === '2.0.0' ? ['storage', 'tabs'] : ['storage'], host_permissions: [hostPattern],
      content_scripts: [{ matches: [hostPattern], js: ['content.js'] }], background: { service_worker: 'background.js' }, update_url: manifestUrl }
    const files = { 'manifest.json': JSON.stringify(manifest),
      'content.js': `chrome.storage.local.get({count:0},state=>chrome.storage.local.set({count:state.count+1},()=>{document.documentElement.dataset.extensionVersion=${JSON.stringify(version)};document.documentElement.dataset.extensionCount=String(state.count+1);chrome.runtime.sendMessage({ping:true},reply=>document.documentElement.dataset.extensionBackground=reply?.version??'missing')}))`,
      'background.js': `chrome.runtime.onMessage.addListener((message,sender,reply)=>reply({version:${JSON.stringify(version)}}))` }
    const zip = Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, strToU8(bytes)]))))
    const packageBytes = signExtensionFixtureCrx(pair, zip)
    const manifestBytes = Buffer.from(`<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="${addonId}"><updatecheck codebase="${fixture.origin}/signed.crx" version="${version}"/></app></gupdate>`)
    for (const [kind, bytes] of [['crx', packageBytes], ['xml', manifestBytes]]) {
      const file = join(evidenceDirectory, 'signed-' + version + '.' + kind)
      await writeFile(file, bytes, { flag: 'wx' })
      artifacts.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, kind: 'extension-source-' + kind })
    }
    await fixture.publish('/signed.crx', packageBytes)
    await fixture.publish('/signed.xml', manifestBytes)
  }
  try { await publishVersion('1.0.0') }
  catch (error) { await fixture.close(); throw error }
  return { manifestUrl, addonId, publishVersion,
    // The caller must pass this to the original private Main AND CLI children before launch.
    environment: { NODE_EXTRA_CA_CERTS: fixture.caPath },
    sourceIdentity: { helper, sha256: helperSha256, certificateSha256: fixture.certificateSha256 },
    requests: fixture.requests, artifacts,
    close: () => fixture.close() }
}

/** Only the unchanged Main NSAlert supplies permission; optional UI audit never substitutes it. */
export function createDailyExtensionHooks({ fixture, confirmNativeReview }) {
  assert.equal(typeof confirmNativeReview, 'function', 'Wire optional observation of this exact private App; Main remains the approver')
  return {
    async prepareAndUpdate(stage) {
      const actor = stage.actors.b, profileId = stage.profile.id
      const record = stage.receipt.daily.extensionOperations = { operations: [], confirmations: [], sourceIdentity: fixture.sourceIdentity }
      const list = () => stage.cli(actor, ['browser', 'profile', 'extension', 'ls', '--profile', profileId])
      const prepare = async (kind, extensionId) => {
        const current = await list(), operationId = randomUUID()
        record.operations.push({ kind, profileId, ...(extensionId ? { extensionId } : {}), operationId, expectedRevision: current.profileRevision, phase: 'prepare-requested' })
        const result = await stage.cli(actor, ['browser', 'profile', 'extension', 'prepare', '--profile', profileId, '--expected-revision', current.profileRevision, '--operation-id', operationId,
          ...(extensionId ? ['--recorded-source', '--extension', extensionId] : ['--update-manifest', fixture.manifestUrl, '--addon-id', fixture.addonId])])
        assert.equal(result.review.reviewId, operationId); assert.equal(result.review.profileId, profileId)
        record.operations.at(-1).review = result.review
        return result.review
      }
      const apply = async (kind, review) => {
        const pid = stage.probe.child.pid
        assert.ok(Number.isSafeInteger(pid) && pid > 1)
        let observe
        try { observe = await confirmNativeReview({ probe: stage.probe, pid, kind, profileId, review }) }
        catch (error) {
          const issue = { name: error.name, code: error.code ?? null, message: error.message }
          record.observerPreparationIssue = issue
          process.stdout.write(JSON.stringify({ nativeReviewObservationUnavailable: true, pid, reviewId: review.reviewId, issue }) + '\n')
          observe = async () => ({ state: 'unconfirmed', actor: 'unknown', pid, profileId, reviewId: review.reviewId, issue })
        }
        const originalApply = { kind, profileId, extensionId: review.extensionId, operationId: review.reviewId, phase: 'apply-requested' }
        record.operations.push(originalApply)
        // Exactly one original apply. An uncertain CLI result is inspected by its
        // original operation, never replayed. The original Main remains the approver.
        const owner = (async () => {
          let reply, error
          try { reply = await stage.cli(actor, ['browser', 'profile', 'extension', 'apply', '--profile', profileId, '--expected-revision', review.expectedRevision, '--review', review.reviewId]) }
          catch (cause) { error = { name: cause.name, code: cause.code ?? null, message: cause.message } }
          const inspection = await stage.cli(actor, ['browser', 'profile', 'extension', 'ls', '--profile', profileId, '--operation-id', review.reviewId])
          originalApply.ownerResult = { reply, error, inspection }
          if (reply) assert.equal(reply.outcome, 'applied')
          const receipt = inspection.receipt, native = inspection.extensions.find(item => item.id === review.extensionId)
          assert.equal(inspection.profileId, profileId); assert.equal(receipt?.operationId, review.reviewId)
          assert.equal(receipt.profileId, profileId); assert.equal(receipt.extensionId, review.extensionId)
          assert.equal(receipt.kind, kind); assert.equal(receipt.sha256, review.sha256)
          assert.equal(native?.nativeId, fixture.addonId); assert.equal(native.version, review.version)
          assert.equal(native.sha256, review.sha256); assert.equal(native.application.state, 'loaded')
          const confirmed = { state: 'applied', source: reply ? 'original-apply-and-operation-inspection' : 'original-operation-inspection',
            receipt, native, reply, error }
          originalApply.ownerResult = confirmed
          return confirmed
        })()
        void owner.catch(() => {})
        const uiAudit = await observe(owner), ownerResult = await owner
        record.confirmations.push({ operationId: review.reviewId, pid, ownerResult, uiAudit })
        return ownerResult
      }
      const initial = await prepare('install')
      assert.equal(initial.version, '1.0.0'); assert.equal(initial.source.signature, 'package-verified')
      await apply('install', initial)
      await fixture.publishVersion('2.0.0')
      const check = await stage.cli(actor, ['browser', 'profile', 'extension', 'check', '--profile', profileId, '--extension', initial.extensionId])
      assert.equal(check.status, 'update-available'); assert.equal(check.currentVersion, '1.0.0'); assert.equal(check.candidateVersion, '2.0.0')
      const update = await prepare('update', initial.extensionId)
      assert.equal(update.version, '2.0.0'); assert.equal(update.previousVersion, '1.0.0'); assert.ok(update.permissions.api.includes('tabs'))
      const applied = await apply('update', update), configured = applied.native
      assert.equal(configured?.nativeId, fixture.addonId); assert.equal(configured.version, '2.0.0'); assert.equal(configured.sha256, update.sha256)
      return { extensionId: initial.extensionId, nativeId: configured.nativeId, version: configured.version, sha256: configured.sha256,
        check, installReviewId: initial.reviewId, updateReviewId: update.reviewId, updateReceipt: applied.receipt }
    },
    async recover(stage) {
      // Reading configuration neither reopens a Browser nor re-acquires or applies a package.
      const current = await stage.cli(stage.actor, ['browser', 'profile', 'extension', 'ls', '--profile', stage.profile.id, '--operation-id', stage.original.updateReviewId])
      const original = current.extensions.find(item => item.id === stage.original.extensionId)
      assert.equal(original?.nativeId, stage.original.nativeId); assert.equal(original.version, '2.0.0'); assert.equal(original.sha256, stage.original.sha256)
      assert.equal(current.receipt?.operationId, stage.original.updateReviewId)
      return { extensionId: original.id, nativeId: original.nativeId, version: original.version, application: original.application, receipt: current.receipt }
    }
  }
}
