# Connect / Restore session context

This scene reuses the existing private Electron presentation probe and renders the
production `SessionPane`, `SessionConnectingSurface`, `SessionRecap` and styles.
It supplies explicit private history pages through the existing API boundary; it
does not qualify live Provider lifecycle, installed binaries, or process recovery.
No user Session, Run, home directory or system clipboard is touched.

Owning contracts: [Connecting and recovery](../../../../../docs/design/behavior/session-recovery.md#connecting-与-terminal-恢复页的全页状态舞台)
and [presentation](../../../../../docs/design/presentation/session-recovery.md#启动与恢复的分量分开).

Capture normal Connect and Restore at wide/narrow/light sizes, a short Restore
Region, indexed history without byte metadata, unknown identity, failed and empty
history, a long recap, and expanded source details. The original Region header,
original restore actions, metadata and readable recap must remain reachable.
The source gate separately exercises actual Core JSONL and native indexed readers.

```sh
AGENTMUX_RECOVERY_CONTEXT=1 \
AGENTMUX_VERIFY_PRESENTATION_RECEIPT="$PWD/.tmp/session-recovery-context/presentation.json" \
node apps/desktop/scripts/fixtures/session-loading-recovery-quality/presentation.mjs
```

Capture is evidence only. An independent Agent must open every complete PNG,
review hierarchy, legibility, spacing, action access and source details, and bind
its decision to the exact receipt and source hashes. Preserve prior failed frames
and opinions when making corrections.
