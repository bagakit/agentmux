import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const slices = {
  "T-001": {
    "tests": [
      "apps/desktop/test/git-history-navigation.test.tsx"
    ],
    "mutations": [
      {
        "label": "hidden-review-does-not-read-history",
        "file": "apps/desktop/src/renderer/src/features/git/history/GitHistoryContext.tsx",
        "before": "const enabled = Boolean(workspace && currentReaders.some(([, reader]) => reader.kind === 'sidebar'))",
        "after": "const enabled = Boolean(workspace && currentReaders.length)"
      },
      {
        "label": "restore-original-range-before-reading",
        "file": "apps/desktop/src/renderer/src/features/git/history/useGitHistory.ts",
        "before": "    selectReference(value)\n  }, [key, selectReference])",
        "after": "    void value\n  }, [key, selectReference])"
      },
      {
        "label": "live-range-projects-to-retained-review",
        "file": "apps/desktop/src/renderer/src/features/git/GitWorkbenchPane.tsx",
        "before": "      selectReference(surface.regionId, history.reference)",
        "after": "      void history.reference"
      },
      {
        "label": "late-navigation-is-not-revealed",
        "file": "apps/desktop/src/renderer/src/store.ts",
        "before": "if (navigationChanged) throw Object.assign(new Error('Git was read,",
        "after": "if (false) throw Object.assign(new Error('Git was read,"
      },
      {
        "label": "ordinary-selection-does-not-locate",
        "file": "apps/desktop/src/renderer/src/components/WorkspaceGitTool.tsx",
        "before": "const opened = openHistory(workspace.id, snapshot, history.reference)",
        "after": "const opened = openHistory(workspace.id, snapshot, history.reference, snapshot)"
      },
      {
        "label": "observed-repository-retains-own-identity",
        "file": "apps/desktop/src/renderer/src/components/WorkspaceGitTool.tsx",
        "before": "const opened = openHistory(workspace.id, snapshot, history.reference)",
        "after": "const opened = openHistory(workspace.id, review?.scope ?? snapshot, history.reference)"
      }
    ]
  },
  "T-002": {
    "tests": [
      "apps/desktop/test/git-history-ref-picker.test.tsx"
    ],
    "mutations": [
      {
        "label": "all-reference-kinds-remain-selectable",
        "file": "apps/desktop/src/renderer/src/features/git/history/GitHistoryRefPicker.tsx",
        "before": "refs.filter(ref => ref.kind !== 'tag')",
        "after": "refs.filter(ref => ref.kind === 'local')"
      },
      {
        "label": "tags-do-not-become-history-roots",
        "file": "apps/desktop/src/renderer/src/features/git/history/GitHistoryRefPicker.tsx",
        "before": "refs.filter(ref => ref.kind !== 'tag')",
        "after": "refs"
      },
      {
        "label": "search-does-not-truncate-observation",
        "file": "apps/desktop/src/renderer/src/features/git/history/GitHistoryRefPicker.tsx",
        "before": "available.filter(ref =>",
        "after": "available.slice(0, 100).filter(ref =>"
      },
      {
        "label": "selection-keeps-complete-ref",
        "file": "apps/desktop/src/renderer/src/features/git/history/GitHistoryRefPicker.tsx",
        "before": "value: ref.name, label: refLabel(ref.name)",
        "after": "value: refLabel(ref.name), label: refLabel(ref.name)"
      },
      {
        "label": "reference-dom-is-windowed",
        "file": "apps/desktop/src/renderer/src/features/git/history/GitHistoryRefPicker.tsx",
        "before": "overscan: 4,",
        "after": "overscan: options.length,"
      },
      {
        "label": "ime-and-modifiers-do-not-submit",
        "file": "apps/desktop/src/renderer/src/features/git/history/GitHistoryRefPicker.tsx",
        "before": "if (composing.current || isImeOwnedKeyboardEvent(event) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return",
        "after": "if (false) return"
      },
      {
        "label": "hidden-reference-popup-closes",
        "file": "apps/desktop/src/renderer/src/features/git/history/GitHistoryRefPicker.tsx",
        "before": "useEffect(() => { dismiss() }, [enabled, scope, dismiss])",
        "after": "useEffect(() => {}, [enabled, scope, dismiss])"
      }
    ]
  },
  "T-003": {
    "tests": [
      "apps/desktop/test/git-commit-presentation.test.tsx"
    ],
    "mutations": [
      {
        "label": "unstructured-message-is-retained",
        "file": "apps/desktop/src/renderer/src/features/git/commit/commit-presentation.ts",
        "before": "heading: conventional?.[4] ?? firstLine",
        "after": "heading: conventional?.[4] ?? ''"
      },
      {
        "label": "complete-message-body-is-readable",
        "file": "apps/desktop/src/renderer/src/features/git/commit/commit-presentation.ts",
        "before": "\n    body,\n",
        "after": "\n    body: '',\n"
      },
      {
        "label": "original-message-is-not-parsed-away",
        "file": "apps/desktop/src/renderer/src/features/git/commit/GitCommitDetails.tsx",
        "before": "{result.commit.message || '(No commit message)'}</pre>",
        "after": "{message.heading || '(No commit message)'}</pre>"
      },
      {
        "label": "different-committer-remains-visible",
        "file": "apps/desktop/src/renderer/src/features/git/commit/GitCommitDetails.tsx",
        "before": "const differentCommitter = result && result.commit.author !== result.commit.committer",
        "after": "const differentCommitter = false"
      },
      {
        "label": "all-fixed-file-changes-are-counted",
        "file": "apps/desktop/src/renderer/src/features/git/commit/commit-presentation.ts",
        "before": "for (const entry of entries)",
        "after": "for (const entry of entries.slice(0, 1))"
      },
      {
        "label": "selected-parent-keeps-exact-target",
        "file": "apps/desktop/src/renderer/src/features/git/commit/GitCommitDetails.tsx",
        "before": "parentOid: event.currentTarget.value",
        "after": "parentOid: result.commit.parents[0]!"
      }
    ]
  }
}
assert.equal(process.argv.length, 4)
assert.equal(process.argv[2], '--slice')
const slice = process.argv[3]
assert.ok(Object.hasOwn(slices, slice), 'Select one reviewed Git reading slice')
await verifyRendererSourceMutations({
  name: 'git-history-navigation-' + slice.toLowerCase(),
  evidenceRoot: process.env.AGENTMUX_MUTATION_EVIDENCE_ROOT ? resolve(process.env.AGENTMUX_MUTATION_EVIDENCE_ROOT) : resolve('.bagakit/feature-tracker/git-history-navigation'),
  owningConfig: 'apps/desktop/test/git-workbench.config.mts',
  ...slices[slice],
  sources: [
  "apps/desktop/src/renderer/src/components/WorkspaceGitTool.tsx",
  "apps/desktop/src/renderer/src/features/git/GitWorkbenchPane.tsx",
  "apps/desktop/src/renderer/src/features/git/history/GitHistoryContext.tsx",
  "apps/desktop/src/renderer/src/features/git/history/useGitHistory.ts",
  "apps/desktop/src/renderer/src/features/git/history/GitHistoryRefPicker.tsx",
  "apps/desktop/src/renderer/src/store.ts",
  "apps/desktop/src/renderer/src/features/git/commit/GitCommitDetails.tsx",
  "apps/desktop/src/renderer/src/features/git/commit/commit-presentation.ts",
  "apps/desktop/src/renderer/src/features/git/history/GitHistoryPanel.tsx",
  "apps/desktop/src/renderer/src/styles/git-workbench.css",
  "apps/desktop/src/renderer/src/styles/git-history.css",
  "apps/desktop/src/renderer/src/styles/workspace-git.css",
  "apps/desktop/test/helpers/client-ui-render.tsx",
  "apps/desktop/test/helpers/git-history-reference.ts",
  "apps/desktop/test/helpers/git-history-viewport.ts",
  "apps/desktop/scripts/lib/fixture-values.mjs",
  "apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs",
  "apps/desktop/scripts/verify-git-navigation-mutations.mjs"
]
})

