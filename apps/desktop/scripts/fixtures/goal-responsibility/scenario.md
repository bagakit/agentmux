# Goal responsibility visual fixture

This bounded fixture uses the production `App`, platform adapter, Goal list/detail,
Mote work, Region marker, patrol controls and CSS. The input must come from the
original isolated Core/Demand/RPC/compiled CLI product journey; raw snapshots and
the exact production GUI patrol exchange are checked against its receipt. The
recorded transport never submits another PMO input.

Run the capture with an existing Electron binary and a source JSON path:

```sh
node apps/desktop/scripts/verify-goal-responsibility-journey.mjs --evidence OUTPUT_DIR --source SOURCE_JSON --electron EXISTING_ELECTRON
```

`--capture-only` performs the same strict source/CLI/candidate/build checks and
two hidden processes with at least 27 full frames, without waiting for Native,
workface or cost evidence. Its receipt remains `captureOnly:true` with recorded
transport scope; it cannot qualify the combined gate by itself.

To combine that original capture later, use `--capture-receipt CAPTURE_RECEIPT`
or set `AGENTMUX_GOAL_RESPONSIBILITY_CAPTURE_RECEIPT` for the default command.
This branch reads the original capture (or an exact path/SHA pointer), checks its
current candidate, source, original journey, CLI, compiled files, phases, hidden
window facts, PNG bytes and cleanup, then reads current Native/workface/cost
qualifications. It does not build, recapture or run Native. An independent output
directory receives a new `agentmux.goal-responsibility-visual-combined.v1` receipt
with `originalCapture:{path,sha256}` and `captureEvidence` naming the original
directory. Original source/phase/PNG/compiled files remain unchanged; frame names
remain relative to that original directory. Independent image review binds the
original capture receipt and its exact images. Changed evidence or candidates fail.

`--prepare-only` builds the actual Renderer and records its graph without starting
Electron. It is preparation, not a passing visual or lifecycle gate. The default
capture requires current source/CLI hashes to match the original journey receipt.
All output is placed in an explicit `--evidence DIR` (or the explicit
`AGENTMUX_GOAL_RESPONSIBILITY_EVIDENCE` value). Inputs have no implicit location:
provide `--source FILE` or an exact `--capture-receipt FILE`. The combined gate
also requires `--native-receipt FILE`, `--workface-receipt FILE` and
`--cost-receipt FILE`; their respective
`AGENTMUX_GOAL_RESPONSIBILITY_NATIVE_RECEIPT`,
`AGENTMUX_GOAL_RESPONSIBILITY_WORKFACE_RECEIPT` and
`AGENTMUX_GOAL_RESPONSIBILITY_COST_RECEIPT` values remain explicit alternatives.
A pointer contains only the original repository-relative or absolute `path`
and `sha256`; it does not summarize or replace evidence.

The other Goal verification runners likewise require `--evidence DIR`.
Responsibility mutations select `--slice responsibility|patrol|cost|delegation`;
the cost pointer is written inside that chosen output directory. Read-only
`--check-qualified POINTER` can derive its evidence scope from the explicit
pointer's directory. Native responsibility accepts an optional `--electron FILE`.
Plan discovery always runs the current committed product suite and current
routing/consumer mutations; it does not reuse an earlier checkout's history.

The source schema is `agentmux.goal-responsibility-visual-source.v1`:

- `source`: original `receiptPath`, exact `receiptSha256`, compiled `cliSha256`, and
  an explicit Native/IPC `boundary`.
- `config`: the recorded private client configuration projection.
- `snapshots`: nonempty cuts with `id`, original successful CLI `inspect` and
  `delegations` envelopes, and recorded client `sessions`. Optional `history`
  contains actual recorded native-history DTOs by Session ID. Missing transcript
  stays unavailable.
- `journey`: `initialSnapshotId`, `deliveredSnapshotId`, `reportedSnapshotId`, and
  the actual original GUI `patrol` `{method,params,response}`. Delivery cannot stand
  for inspection; the final cut needs an applied original report.

The private Mote and vertical split only provide a readable display location.
Source Goal associations and Session/Host/Run/cwd facts stay exact. A real pointer
click produces the same frozen original patrol request and receives its captured
reply. The publication of the separately recorded report is labelled as such.
Reload and a second real Electron process read the first saved private profile
using production layout projection/restoration. These prove the isolated Renderer
workface only; original Core/Native lifecycle has separate evidence.

Screenshots cover complete wide/narrow and light/dark surfaces. Nonempty image
checks do not judge their appearance. An independent reviewer must open the exact
frames and approve them against the [Goal presentation contract](../../../../../docs/design/presentation/goals.md#执行者责任告警与巡查反馈)
and [visual review rules](../../../../../docs/guides/agent-visual-e2e-review.md).
