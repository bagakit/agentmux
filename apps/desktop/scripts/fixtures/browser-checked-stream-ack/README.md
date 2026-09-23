# Checked-event save acknowledgement regressions

Source-only fixture for the real `BrowserOperationJournal` and `BrowserOperationFileStore`.
The wrapper holds only the optional store acknowledgement. It does not replace the Journal,
seed its document, start Electron, send Browser input, or build anything.

Run only this leaf:

```sh
pnpm exec vitest run --config apps/desktop/scripts/fixtures/browser-checked-stream-ack/vitest.owning.config.mts
```

Current `ec971cdf` Main candidate is **RED in all four behavior assertions**:

- A subscriber opened during the acknowledgement wait sees `operation-checked` in backlog early.
- That subscriber receives sequence 5 again in live delivery after the failed save.
- Later sequence 6 reaches the same operation before sequence 5; another operation correctly remains immediate.
- Two concurrent checks deliver 6 before 5, and the failed first check carries the second evaluation without its notice.

The assertions describe the required result; they have not been weakened to accept these defects.
The first immutable run and final cleanup-aware run are retained in the independent review packet.
The leaf is deliberately named `source-proof.ts` and uses an exact owning config, so default test
discovery does not silently collect a private copied tree. `AGENTMUX_CHECKED_STREAM_FACTS` is an
optional owned JSON output path for recorded observations, not a product setting.

The follow-up implementation still requires restored GREEN, actual-source mutants, existing
subscription/trim regressions, public socket coverage and related-consumer cost checks. The prior
17 source mutants and observed e946 Native gate do not cover this acknowledgement race. No GUI,
Native or Task completion is claimed here.
