# Subagent conversation reading probe

Owning contracts: [behavior](../../../../../docs/design/behavior/conversation-mode.md#原生-subagent-回报的阅读) and [presentation](../../../../../docs/design/presentation/conversation-mode.md#subagent-回报的紧凑呈现).

The owning `vitest.subagent-empty-reading.config.mts` mounts the actual shared `ConversationView` and `ConversationMessage`: one inline disclosure with no parent avatar, left time and reading preview, complete selectable participant paths, independent Copy/Info, deferred resources, failed/unconfirmed contributions, retained nodes/selection and ordinary-message isolation. `AGENTMUX_EMPTY_REPORT_MUTATION` selects `empty-preview`, `hide-resource`, `remove-path-details` or `parent-avatar`; each transforms actual production source in the test loader and must fail a semantic assertion. Restored source must pass.

```sh
pnpm exec vitest run --config apps/desktop/test/vitest.subagent-empty-reading.config.mts
node apps/desktop/scripts/fixtures/conversation-collaboration/preview.mjs
```

The preview reads the task-local `provider/preview-page.json` produced by the real Core Provider/AgentMuxClient over a private native transcript. The fixture serves the actual shared conversation, Desktop avatar and CSS with controlled clipboard and draft IO. Adjacent process and reply-snapshot records exercise the existing observation components; a bounded resource fixture exercises the same resource reader. It does not replace an installed App or control a user Session/Run. Page data and receipts remain task-local; missing data is a failed precondition, never a fabricated passing screenshot.

Run the private Electron probe with the printed preview URL and an evidence directory:

```sh
env -u ELECTRON_RUN_AS_NODE apps/desktop/node_modules/.bin/electron apps/desktop/scripts/fixtures/conversation-collaboration/capture.cjs http://127.0.0.1:5173/ /absolute/evidence/directory
```

It captures 1000px and 332px, dark/light, folded/expanded and original details. It operates pointer and Enter on the actual disclosure, checks one-line geometry beside process/reply observations, left-time stability through Copy/Info, the static category glyph, selectable full paths, original copy, deferred reading, node/selection retention, append, repeat folding and draft retention. `capture.json` binds the owned source hashes and images, and records its private temporary profile for cleanup after process exit. Images require an independent Agent's actual visual review; passing capture assertions do not certify aesthetics or physical mobile behavior.
