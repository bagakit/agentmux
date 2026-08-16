# Composer paste selection

Status: approved. Authority: user requested the paste overwrite fix and delegated this bounded work to a subagent.

Scope: plain-text paste, screenshot paste/capture and file-reference insertion in Agent and Launcher composers. Only the true selection may be replaced; pending async attachment work must preserve intervening edits. Use the existing maintained editor transaction and selection mapping. No Mailbox, Avatar or primary-button changes.

One vertical task owns the shared editor insertion, real consumers, behavior/mutation tests and browser paste proof.

## Findings and delivery

Plain-text handlePaste called onValueChange(text), replacing the complete controlled draft. Image save, screen capture and file-picker handlers separately appended references to the draft tail, bypassing the editor selection.

The shared insertion owner now uses ProseMirror document slices and selection bookmarks. Text uses the current selection; async tools capture the selection before reading/saving/picking and map it through subsequent editor transactions. The pending listener is removed in finally on success, cancellation or failure. Completing an attachment keeps a newer caret elsewhere in the document and avoids stealing focus from another control. References retain appropriate separators. Editor initialization restores a draft without adding that restoration to undo history.

Agent and Launcher consume the same insertion API. The existing local feedback owner still controls errors and retries; a retry begins a new insertion at the user's then-current selection. AgentComposer only passes the insertion ref and revised image callback type through to InlineComposer; primary controls were untouched.

## Verification

- 121 tests pass across nine Composer and scan-guard files, including nine new behavior cases. Production desktop typecheck passes. The broad existing test-typecheck still reports unrelated fixture diagnostics (including pre-existing unknown-boundary assertions); no new paste-test or insertion-source diagnostic.
- Nine mutants are killed: overwrite full draft; ignore range; omit bookmark mapping; use the later caret instead of original mapped anchor; insert closed block paragraphs; put restored draft in undo; discard additional files; delete selected text on empty clipboard; omit reference separator.
- Native clipboard paste in Ego Browser over the real InlineComposer source produced `alpha new omega` at a middle caret and `alpha ONE\nTWOomega` replacing only the selected word. During an unresolved attachment, native keyboard input added `new `; completing the picker produced `new alpha @a.ts @b.ts omega`. Screenshot inspected. The temporary preview page/server and TaskSpace were removed/closed.
- Real Agent/Launcher DOM tests exercise native paste events, image byte persistence, selected capture, multi-file picker completion, intervening edits, caret preservation, cancellation, failures/retry, and undo.
- Zero-caller check: InlineComposer imports and calls both insertion functions; AgentComposer forwards insertionRef; AgentSessionComposer and NewTabSurface invoke the ref for attachments and capture. The shared helper has actual product consumers outside its defining file.

Learning: controlled draft replacement is a synchronization operation, not a paste operation. Selection and async position mapping belong to the maintained editor; host tools should supply their result, not reconstruct the entire draft.

## Integrated Composer regression follow-up

The user's request to review and fix this whole area also covers tests left behind by the rich-input migration. On the unmodified da29f060 baseline, the same ten pending-keyboard/IME/export/focus checks fail and all 317 test-tree diagnostics match bb48dcc6 after normalizing line numbers and worktree paths. This is not a paste regression, but leaving the checks unusable hides future regressions.

Acceptance: visible Launchers acquire the real rich editor focus and hidden Launchers do not steal it; marked IME Enter never sends or queues while ordinary Enter still does; the discovered handler guard checks the actual event argument and reachable control flow for both React and native events; pending Run messages remain clearly distinct from unavailable Run messages through the real Outbox. Fixtures must satisfy current production types without casts that hide mismatches. Existing behavioral and structural guards remain active.

Verification: composer input ownership DOM tests plus existing pending interaction, IME, effect reachability, workspace registry, provider ingress, image preview, local feedback and continuous progress suites; deliberate focus/IME/queue-copy mutations must fail.

Follow-up result: 13 related suites pass (122 tests), including the real Agent and Launcher editor DOM paths, pending keyboard, Outbox delivery, attachment feedback, continuous progress and nonempty-scan guards. Test-tree diagnostics fall from 317 to 308, with no added diagnostics after normalizing locations. The six related fixture files now type-check; unrelated existing errors remain. No production behavior was changed just to satisfy an obsolete assertion.

Six production mutations are killed by the revised coverage: delete focus; focus a hidden Launcher; stop reacting to visibility; give the IME predicate the wrong event; promise delivery for an unavailable Run; return before the focus call. Caller inspection confirms AgentComposer and NewTabSurface mount InlineComposer, AgentComposer invokes the native IME SSOT, and SessionMailbox mounts ComposerOutbox.

The IME source-discovery suite now recognizes both the React wrapper and its native SSOT predicate while preserving argument identity, reachable control flow, nonempty discovery and actual import checks. It passes 27/28 checks in isolation; its remaining failure correctly identifies WorkspaceTopicsPanel's separate unguarded Enter handler, delegated to the Topic owner. No exemption was added to conceal that finding. Baseline and current evidence: `/tmp/composer-integration-baseline-tests.log`, `/tmp/composer-integration-baseline-types.log`, `/tmp/composer-integration-final-tests.log`, `/tmp/composer-integration-fixed-types.log`, `/tmp/composer-integration-ime-final.log`, `/tmp/composer-integration-mutations.json`.
