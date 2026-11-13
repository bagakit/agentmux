import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const file = 'apps/desktop/src/main/browser-view-manager.ts'
await verifyRendererSourceMutations({
  name: ("browser-structured-glue-mutations-" + (globalThis.crypto.randomUUID()) + ""),
  tests: ['apps/desktop/test/browser-run-script-wiring.test.ts'],
  sources: [file, 'packages/browser/src/browser-page-dispatch.ts',
    'packages/browser/src/browser-result-artifact.ts', 'packages/browser/src/model/browser-structured-output.ts'],
  mutations: [
    { label: 'main-observation-owner-disconnected', file,
      before: 'structuredOutput: {', after: 'structuredOutput: undefined && {' },
    { label: 'main-extraction-evidence-disconnected', file,
      before: "this.stepEvidence && name === 'extractStructured'", after: "this.stepEvidence && false && name === 'extractStructured'" },
    { label: 'recorded-source-join-removed', file,
      before: `if (artifactStatus !== 'available' || !artifact || source.operationId !== operationId ||
        source.browserId !== operation.browserId || source.workspaceId !== entry.workspaceId ||
        source.navigationId !== item.reference.navigationId || artifact.operationId !== source.operationId ||
        artifact.browserId !== source.browserId || artifact.workspaceId !== source.workspaceId ||
        artifact.navigationId !== source.navigationId) throw new Error('The result does not belong to this recorded extraction.')`,
      after: 'void artifactStatus' },
    { label: 'result-read-runs-another-program', file,
      before: 'const evidence = await this.getStepEvidence(operationId, sequence)',
      after: "await this.runScript(operation.browserId, 'return 42'); const evidence = await this.getStepEvidence(operationId, sequence)" },
    { label: 'warning-not-published-during-read', file,
      before: `warning: operation.warning })
        this.emit(entry)
      },
      recordTarget:`,
      after: `warning: operation.warning })
        void entry
      },
      recordTarget:` }
  ]
})
