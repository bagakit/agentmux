import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const file = 'apps/desktop/scripts/verify-browser-recovery-restart.mjs'
await verifyRendererSourceMutations({
  name: `browser-canonical-recovery-boundaries-${Date.now()}`,
  tests: ['apps/desktop/test/browser-canonical-recovery-boundaries.test.ts'],
  sources: [file],
  mutations: [
    { label: 'duplicate-regions-accept-one-native-owner', file,
      before: 'if(new Set(found.map(page=>page.webContentsId)).size!==stages.length)return null;return found',
      after: 'return found' },
    { label: 'one-owned-pid-error-skips-other-owned-pids', file,
      before: 'for(const pid of await listProbeProcesses(0,temporaryRoot)){try{await signalOwnedProbeProcess(pid,temporaryRoot,name)}catch(error){errors.push(error.message)}}',
      after: 'for(const pid of await listProbeProcesses(0,temporaryRoot))await signalOwnedProbeProcess(pid,temporaryRoot,name)' },
    { label: 'actual-capture-accepts-first-duplicate-native-owner', file,
      before: "if(views.length!==1)throw new Error('Native capture requires one current visible owner');const view=views[0];",
      after: "const view=views[0];" },
    { label: 'original-native-geometry-ignored', file,
      before: "['x','y','width','height'].every(key=>Math.abs(r[key]-expected[key])<=2)", after: 'true' },
    { label: 'hidden-original-native-owner-accepted', file,
      before: '||!view.getVisible())return false;', after: ')return false;' },
    { label: 'private-process-ownership-consumer-removed', file,
      before: 'await signalOwnedProbeProcess(pid,temporaryRoot,name)',
      after: 'void pid' },
    { label: 'private-process-identity-failure-hidden', file,
      before: 'for(const pid of await listProbeProcesses(0,temporaryRoot)){try{await signalOwnedProbeProcess(pid,temporaryRoot,name)}catch(error){errors.push(error.message)}}',
      after: 'for(const pid of await listProbeProcesses(0,temporaryRoot)){try{await signalOwnedProbeProcess(pid,temporaryRoot,name)}catch(error){}}' }
  ]
})
