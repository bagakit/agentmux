# Terminal @path closure evidence

Feature `f-24d8fcuhy`, task `T-001`. The reviewed requirement is to treat a leading `@` as reference syntax while preserving `@` inside a path, line/column suffixes, and the existing workspace boundary. Authority: `docs/reviews/bookmark-files-and-conversation-images-2026-09-15.md`; interaction SSOT, “Message Tools 的事实来源与快捷语法”.

## Existing delivery

The code was already delivered in `a5b8bc1ca678667917084e524b1f6cbd9bd5fb5c` (`fix(desktop): 起头的 @ 是记号不是路径字符，从路径链接里剥掉`). This follow-up verifies that delivery rather than introducing a second implementation or changing its scope.

`detectTerminalPathLinks` strips only the leading sigil before resolution and advances the clickable span past it. An absolute reference consequently enters the existing workspace-root check. `node_modules/@types/node/index.d.ts` retains its inner `@`. The suffix continues to be parsed from the original matched core, preserving line and column.

Production callers outside the defining file:

- `TerminalView.tsx`: its registered xterm link provider reads the real buffer line, calls `detectTerminalPathLinks`, derives the link range/location, and passes `match.path` and location to `openFile` after the existing click/drag guard.
- `markdown-file-reference.ts`: both prose splitting and Markdown href classification consume the same matcher.

Caller check: `rg -n 'detectTerminalPathLinks' apps/desktop/src --glob '!terminal-path-link.ts'`.

## Verification

Command, run on restored production code:

```sh
pnpm --config.verify-deps-before-run=false exec vitest run apps/desktop/test/terminal-path-link.test.ts apps/desktop/test/tilde-path-link.test.ts --maxWorkers=1
```

Result: **2 suites, 44 tests passed**. Existing behavior tests cover leading relative and absolute references, outside-workspace rejection, inner scoped-package `@`, link span, and `:line:column` suffixes. Existing tilde, timestamp and deliberate-rejection coverage also passed.

Two isolated production mutations were applied and then restored:

| Mutation | Observed failure |
| --- | --- |
| Set `atPrefixLength` to zero | 3 tests failed: relative path, absolute boundary, and suffix path retain the incorrect leading `@`. |
| Remove every remaining `@` from the core | Scoped-package test failed: `node_modules/types/node/index.d.ts` is not `node_modules/@types/node/index.d.ts`. |

The restored implementation again passed all 44 tests. Logs: `/tmp/path-prefix-baseline.log`, `/tmp/path-prefix-mutant-keep-leading-prefix.log`, `/tmp/path-prefix-mutant-erase-middle-at.log`, `/tmp/path-prefix-restored.log`; mutation summary `/tmp/path-prefix-mutants.json`.

No product code or test changed in this follow-up. This closes only T-001; it does not claim completion of the feature's other image-related tasks. Browser behavior was not re-tested here because no UI or implementation changed; the production caller was inspected directly and the requested detector regression/variation checks executed.
