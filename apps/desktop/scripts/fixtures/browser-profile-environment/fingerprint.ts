import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BROWSER_PROFILE_FINGERPRINT_SURFACES, type BrowserProfileEnvironment } from '@agentmux/core/control'
import type { BrowserProfileManager } from '../../../src/main/browser-profile-manager.js'
import type { BrowserViewManager } from '../../../src/main/browser-view-manager.js'

const surfaces = [...BROWSER_PROFILE_FINGERPRINT_SURFACES]
const settings = (seed: number): BrowserProfileEnvironment => ({ fingerprint: { seed, surfaces } })
const sampleSource = `(async()=>{
  const canvas = document.createElement('canvas'); canvas.width=64; canvas.height=16;
  const ctx=canvas.getContext('2d'); ctx.font='14px monospace';
  ctx.fillStyle='#465078';ctx.fillRect(0,0,64,16);
  const font=ctx.measureText('Proof native metrics').width;
  const pixel=canvas.toDataURL();
  const box=document.createElement('div');box.style.cssText='position:fixed;left:23px;top:36px;width:40px;height:50px';
  document.body.append(box);const coord=box.getBoundingClientRect().x;box.remove();
  const gl=document.createElement('canvas').getContext('webgl');
  const debug=gl?.getExtension('WEBGL_debug_renderer_info');
  const gpu=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null;
  const audio=new OfflineAudioContext(1,1024,44100);const oscillator=audio.createOscillator();
  oscillator.connect(audio.destination);oscillator.start();
  const signal=(await audio.startRendering()).getChannelData(0);
  return {font,pixel,coord,gpu,audio:[signal[0],signal[113],signal[226]],cookie:document.cookie};
})()`

export async function runProfileFingerprint(input: {
  home: string; phase: string; url: string; profiles: BrowserProfileManager; browsers: BrowserViewManager
  page(id: string): Promise<Electron.WebContents>; cli(args: string[]): Promise<unknown>
  report: Record<string, unknown>; stage(name: string): void
}) {
  const { home, phase, url, profiles, browsers, page, cli, report, stage } = input
  const id = profiles.defaultProfileId(), browserId = 'native-fingerprint-proof'
  const sample = async (browser = browserId) => (await page(browser)).executeJavaScript(sampleSource)
  const apply = async (value: BrowserProfileEnvironment | null) => {
    const revision = profiles.listProfiles().find(profile => profile.id === id)!.revision
    await cli(['update', '--profile', id, '--expected-revision', revision, '--environment', JSON.stringify(value)])
    for (let attempt = 0; attempt < 200; attempt++) {
      const fact = profiles.environmentApplication(id)?.pages?.find(row => row.browserId === browserId)
      if (fact?.fields.fingerprint?.status === 'applied') return
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
    report.fingerprint = { restarted: true, originalBrowserId: browserId, profileId: id }
    return
  }
  const original = await page(browserId)
  await original.executeJavaScript("document.cookie='qa_fingerprint=kept; Max-Age=3600; path=/'; document.querySelector('input').value='unsaved original'")
  const baseline = await sample()
  assert.ok(baseline.gpu, 'This native Electron fixture requires a live WebGL renderer')
  stage('observing first saved seed in original document')
  await apply(settings(12648))
  const first = await sample()
  assert.notEqual(first.pixel, baseline.pixel, 'Native canvas readback must change for selected Profile')
  for (const name of ['font', 'coord', 'gpu', 'audio'] as const)
    assert.notDeepEqual(first[name], baseline[name], `Native ${name} observation must change for selected Profile`)
  assert.equal(await original.executeJavaScript('document.querySelector("input").value'), 'unsaved original')
  assert.deepEqual(await sample(), first)
  await apply(settings(92421))
  const second = await sample()
  for (const name of ['pixel', 'font', 'coord', 'gpu', 'audio'] as const)
    assert.notDeepEqual(second[name], first[name], `Different seed must change the ${name} observation`)
  await apply(null)
  assert.deepEqual(await sample(), baseline, 'Cleared original page restores its original API observations and cookies')

  await apply(settings(12648))
  const newId = 'new-native-fingerprint-proof'
  await browsers.create(newId, url, 'proof-workspace', id)
  const restarted = await sample(newId)
  assert.deepEqual(restarted, first, 'Fresh documents use the saved seed in the exact Profile')
  const created = await cli(['create','--operation-id','native-fingerprint-other','--label','Other native test Profile']) as { creation: { receipt: { createdId: string } | null } }
  const otherIdFromReceipt = created.creation.receipt?.createdId
  assert.ok(otherIdFromReceipt, 'The public Profile creation returned its newly committed identity')
  const otherId = 'unconfigured-native-fingerprint-proof'
  await browsers.create(otherId, url, 'proof-workspace', otherIdFromReceipt)
  const otherSample = await sample(otherId)
  assert.deepEqual(otherSample, { ...baseline, cookie: '' }, 'Other Profile retains its original APIs and separate cookies')
  await writeFile(join(home, 'fingerprint-original.json'), JSON.stringify({ profileId: id, restarted }))
  report.fingerprint = { inspected: surfaces, stableSeeds: [12648, 92421], originalBrowserId: browserId, otherId }
}
