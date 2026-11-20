import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { BROWSER_PROFILE_FINGERPRINT_SURFACES, type BrowserProfileEnvironment } from '@agentmux/core/control'
import type { BrowserProfileManager } from '../../../src/main/browser-profile-manager.js'
import type { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { documentSample } from './fingerprint-samples.mjs'

const surfaces = [...BROWSER_PROFILE_FINGERPRINT_SURFACES]
const settings = (seed: number, enabled = surfaces): BrowserProfileEnvironment => ({ fingerprint: { seed, surfaces: enabled } })

export async function runProfileFingerprint(input: {
  home: string; phase: string; url: string; profiles: BrowserProfileManager; browsers: BrowserViewManager
  page(id: string): Promise<Electron.WebContents>; cli(args: string[]): Promise<unknown>
  report: Record<string, unknown>; stage(name: string): void
}) {
  const { home, phase, url, profiles, browsers, page, cli, report, stage } = input
  const id = profiles.defaultProfileId(), browserId = 'native-fingerprint-proof'
  const sample = async (browser = browserId) => (await page(browser)).executeJavaScript(documentSample)
  const initialScopes = async (browser = browserId) => {
    const contents = await page(browser)
    for (let attempt = 0; attempt < 200; attempt++) {
      const read = await contents.executeJavaScript('globalThis.firstFingerprint')
      if (read?.top && read.same && read.cross && read.worker) return read
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('The original first scripts did not report from the top, both frames, and the Worker.')
  }
  const apply = async (value: BrowserProfileEnvironment | null) => {
    const revision = profiles.listProfiles().find(profile => profile.id === id)!.revision
    await cli(['update', '--profile', id, '--expected-revision', revision, '--environment', JSON.stringify(value)])
    for (let attempt = 0; attempt < 200; attempt++) {
      const fact = profiles.environmentApplication(id)?.pages?.find(row => row.browserId === browserId)
      if (fact?.fields.fingerprint?.status === 'applied') {
        if (value?.fingerprint?.surfaces.length)
          assert.match(fact.fields.fingerprint.reason ?? '', /registered.+frame coverage.+workers/iu, 'Fingerprint application must report the original native scope')
        return
      }
      if (fact?.status === 'unknown') throw new Error(fact.fields.fingerprint?.reason ?? fact.reason)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('Original fingerprint application receipt was not observed.')
  }
  stage('opening exact Profile fingerprint Browser')
  await browsers.create(browserId, url, 'proof-workspace', id)
  if (phase === 'restart') {
    const saved = JSON.parse(await readFile(join(home, 'fingerprint-original.json'), 'utf8'))
    assert.equal(saved.profileId, id)
    assert.deepEqual(profiles.environmentSettings(id), settings(12648))
    assert.deepEqual(await sample(), saved.restarted, 'Same settings and persistent login reproduce on a new Electron process')
    assert.deepEqual(await initialScopes(), saved.prepared, 'The original persisted Profile reproduces all measured document scopes after restart')
    report.fingerprint = { restarted: true, originalBrowserId: browserId, profileId: id }
    return
  }
  const original = await page(browserId)
  const nativeScopes = await initialScopes()
  await original.executeJavaScript("document.cookie='qa_fingerprint=kept; Max-Age=3600; path=/'; document.querySelector('input').value='unsaved original'")
  const baseline = await sample()
  assert.ok(baseline.webgl, 'This native Electron fixture requires a live WebGL renderer')
  stage('observing first saved seed in original document')
  await apply(settings(12648))
  const first = await sample()
  assert.notEqual(first.canvas, baseline.canvas, 'Native canvas readback must change for selected Profile')
  for (const name of surfaces)
    assert.notDeepEqual(first[name], baseline[name], `Native ${name} observation must change for selected Profile`)
  assert.equal(await original.executeJavaScript('document.querySelector("input").value'), 'unsaved original')
  assert.deepEqual(await sample(), first)
  for (const enabled of surfaces) {
    await apply(settings(12648, [enabled]))
    const actual = await sample()
    for (const name of surfaces)
      assert.deepEqual(actual[name], name === enabled ? first[name] : baseline[name], `Only ${enabled} may affect ${name}`)
  }
  await apply(settings(92421))
  const second = await sample()
  for (const name of surfaces)
    assert.notDeepEqual(second[name], first[name], `Different seed must change the ${name} observation`)
  await apply(null)
  assert.deepEqual(await sample(), baseline, 'Cleared original page restores its original API observations and cookies')

  await apply(settings(12648))
  const newId = 'new-native-fingerprint-proof'
  await browsers.create(newId, url, 'proof-workspace', id)
  const restarted = await sample(newId)
  assert.deepEqual(restarted, first, 'Fresh documents use the saved seed in the exact Profile')
  const prepared = await initialScopes(newId)
  const scopedView = await page(newId)
  const targets = await scopedView.debugger.sendCommand('Target.getTargets')
  assert.ok(targets.targetInfos.some((target: { url: string; type: string }) =>
    target.type === 'iframe' && new URL(target.url).pathname === '/fingerprint-cross'), 'Proof requires an actual separate cross-site iframe target')
  const sameSiteFrame = Object.fromEntries(surfaces.map(surface => [surface,
    isDeepStrictEqual(prepared.same[surface], nativeScopes.same[surface]) ? 'native-value' :
      isDeepStrictEqual(prepared.same[surface], first[surface]) ? 'overridden' : 'different-observation'
  ]))
  for (const surface of surfaces) {
    assert.deepEqual(prepared.top[surface], first[surface], `The first top-document script saw configured ${surface}`)
    assert.deepEqual(prepared.cross[surface], nativeScopes.cross[surface], `The separate cross-site target retained native ${surface}`)
    assert.deepEqual(prepared.worker[surface], nativeScopes.worker[surface], `The Worker retained native ${surface} or its original availability`)
  }
  assert.ok(prepared.worker.canvas.length > 0, 'Worker fingerprint observation must include actual pixels')
  const created = await cli(['create','--operation-id','native-fingerprint-other','--label','Other native test Profile']) as { creation: { receipt: { createdId: string } | null } }
  const otherIdFromReceipt = created.creation.receipt?.createdId
  assert.ok(otherIdFromReceipt, 'The public Profile creation returned its newly committed identity')
  const otherId = 'unconfigured-native-fingerprint-proof'
  await browsers.create(otherId, url, 'proof-workspace', otherIdFromReceipt)
  const otherSample = await sample(otherId)
  assert.deepEqual(otherSample, { ...baseline, cookie: '' }, 'Other Profile retains its original APIs and separate cookies')
  const inspected = await cli(['inspect', '--profile', id]) as { profile: { environmentApplication?: ReturnType<BrowserProfileManager['environmentApplication']> } }
  const publicApplication = inspected.profile.environmentApplication?.pages?.find(item => item.browserId === newId)
  assert.match(publicApplication?.fields.fingerprint?.reason ?? '', /registered.+frame coverage.+workers/iu)
  await writeFile(join(home, 'fingerprint-original.json'), JSON.stringify({ profileId: id, restarted, prepared }))
  report.fingerprint = { inspected: surfaces, stableSeeds: [12648, 92421], originalBrowserId: browserId, otherId,
    firstInline: { top: surfaces, sameSiteFrame, separateSiteFrame: 'native-values',
      worker: { canvasAndFont: 'native-values', webgl: prepared.worker.webgl ? 'native-value' : 'unavailable',
        audio: prepared.worker.audio, clientRects: prepared.worker.clientRects } } }
}
