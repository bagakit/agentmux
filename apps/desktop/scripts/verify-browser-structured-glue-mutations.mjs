import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const file = 'apps/desktop/src/main/browser-view-manager.ts'
await verifyRendererSourceMutations({
  name: `browser-structured-glue-mutations-${Date.now()}`,
  tests: ['apps/desktop/test/browser-run-script-wiring.test.ts'],
  sources: [file, 'apps/desktop/src/main/browser-page-dispatch.ts',
    'apps/desktop/src/main/browser-result-artifact.ts', 'apps/desktop/src/shared/browser-structured-output.ts'],
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
      recordTarget:` },
    { label: 'human-takeover-blocks-read-only-extraction', file,
      before: 'takeover.at !== null && BROWSER_ACTION_PAGE_CALLS.has(name)',
      after: "takeover.at !== null && (BROWSER_ACTION_PAGE_CALLS.has(name) || name === 'extractStructured')" }
  ]
})
