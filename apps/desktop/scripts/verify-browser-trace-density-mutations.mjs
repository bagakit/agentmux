import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs';
await verifyRendererSourceMutations({ name: 'browser-trace-density-mutations-'+Date.now(), tests: [
  "apps/desktop/test/browser-demonstration-surface.test.tsx",
  "apps/desktop/test/browser-task-assets.test.tsx",
  "apps/desktop/test/browser-operation-surface.test.tsx",
  "apps/desktop/test/browser-step-evidence.test.tsx"
], sources: [
  "apps/desktop/src/renderer/src/components/BrowserDemonstrationSurface.tsx",
  "apps/desktop/src/renderer/src/components/BrowserTaskAssetEditor.tsx",
  "apps/desktop/src/renderer/src/components/BrowserOperationSurface.tsx",
  "apps/desktop/src/renderer/src/components/BrowserStepEvidence.tsx",
  "apps/desktop/src/renderer/src/styles/browser-operation-surface.css"
], mutations: [
  {
    "label": "unused-demonstration-restores-empty-panel",
    "file": "apps/desktop/src/renderer/src/components/BrowserDemonstrationSurface.tsx",
    "before": "if (!draft) return <section",
    "after": "if (false && !draft) return <section"
  },
  {
    "label": "unused-demonstration-ignores-busy",
    "file": "apps/desktop/src/renderer/src/components/BrowserDemonstrationSurface.tsx",
    "before": "className=\"browser-rsi-button browser-rsi-button--quiet\" disabled={busy}\n      aria-label=\"Start recording demonstration\"",
    "after": "className=\"browser-rsi-button browser-rsi-button--quiet\" disabled={false}\n      aria-label=\"Start recording demonstration\""
  },
  {
    "label": "unused-demonstration-silences-warning",
    "file": "apps/desktop/src/renderer/src/components/BrowserDemonstrationSurface.tsx",
    "before": "{warning ? <p",
    "after": "{false && warning ? <p"
  },
  {
    "label": "unused-asset-mounts-empty-panel",
    "file": "apps/desktop/src/renderer/src/components/BrowserTaskAssetEditor.tsx",
    "before": "if (!asset) return recording || warning || error ?",
    "after": "if (!asset) return true ?"
  },
  {
    "label": "recording-asset-enables-premature-import",
    "file": "apps/desktop/src/renderer/src/components/BrowserTaskAssetEditor.tsx",
    "before": "disabled={busy || recording.status === 'recording'}",
    "after": "disabled={busy}"
  },
  {
    "label": "unused-asset-silences-warning",
    "file": "apps/desktop/src/renderer/src/components/BrowserTaskAssetEditor.tsx",
    "before": "{[warning, error].filter(Boolean).map((message, index) => <p key={index} className=\"browser-rsi-timeline__warning\" role=\"status\"><CircleAlert size={12} aria-hidden=\"true\" />{message}</p>)}\n  </section> : null",
    "after": "{[error].filter(Boolean).map((message, index) => <p key={index} className=\"browser-rsi-timeline__warning\" role=\"status\"><CircleAlert size={12} aria-hidden=\"true\" />{message}</p>)}\n  </section> : null"
  },
  {
    "label": "inspection-repeats-method-heading",
    "file": "apps/desktop/src/renderer/src/components/BrowserOperationSurface.tsx",
    "before": "step.label !== step.method ? <code>{step.method}</code> : null",
    "after": "<code>{step.method}</code>"
  },
  {
    "label": "structured-evidence-repeats-heading",
    "file": "apps/desktop/src/renderer/src/components/BrowserStepEvidence.tsx",
    "before": "item?.content.kind !== 'structured-output' ? <strong>{step.label}</strong> : null",
    "after": "<strong>{step.label}</strong>"
  },
  {
    "label": "failed-evidence-loses-step-identity",
    "file": "apps/desktop/src/renderer/src/components/BrowserStepEvidence.tsx",
    "before": "item?.content.kind !== 'structured-output' ? <strong>{step.label}</strong> : null",
    "after": "null"
  },
  {
    "label": "structured-evidence-repeats-fields-caption",
    "file": "apps/desktop/src/renderer/src/components/BrowserStepEvidence.tsx",
    "before": "item.content.kind !== 'structured-output' ? ` · ${label(item.content.kind)}` : null",
    "after": "` · ${label(item.content.kind)}`"
  },
  {
    "label": "compact-evidence-loses-action-source",
    "file": "apps/desktop/src/renderer/src/components/BrowserStepEvidence.tsx",
    "before": "<dt>Action</dt><dd>{step.method}</dd>",
    "after": ""
  }
] });
