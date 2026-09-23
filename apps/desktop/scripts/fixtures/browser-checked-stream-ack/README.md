# Checked-event save acknowledgement regressions

Source-only fixture for the real `BrowserOperationJournal` and `BrowserOperationFileStore`.
The wrapper holds only the optional store acknowledgement. It does not replace the Journal,
seed its document, start Electron, send Browser input, or build anything.

Run only this leaf:

```sh
pnpm exec vitest run --config apps/desktop/scripts/fixtures/browser-checked-stream-ack/vitest.owning.config.mts
```

Original `ec971cdf` Main source is **RED in all four behavior assertions** (reproduced from immutable original Journal bytes during T009 closeout):

- A subscriber opened during the acknowledgement wait sees `operation-checked` in backlog early.
- That subscriber receives sequence 5 again in live delivery after the failed save.
- Later sequence 6 reaches the same operation before sequence 5; another operation correctly remains immediate.
- Two concurrent checks deliver 6 before 5, and the failed first check carries the second evaluation without its notice.

The assertions describe the required result; they have not been weakened to accept these defects.
The first immutable run and final cleanup-aware run are retained in the independent review packet.
The leaf is deliberately named `source-proof.ts` and uses an exact owning config, so default test
discovery does not silently collect a private copied tree. `AGENTMUX_CHECKED_STREAM_FACTS` is an
optional owned JSON output path for recorded observations, not a product setting.

The repaired Journal owning suite now includes the original four assertions plus full pending
history/backlog exclusion, future live cursor, event/operation trimming, callback disposal and
resubscription, original reply snapshots, clone isolation, and related-consumer cost checks.
The unchanged prior 17 source mutants and observed e946 Native gate do not cover this ACK race.
Run the task-specific `verify-browser-checked-stream-ack-mutations.mjs` for private actual Journal
and public/Core source mutations with restored GREEN and pinned source identities. Public socket
and FileStore reconstruction remain separate gates. No GUI, Native or Task completion is claimed here.
