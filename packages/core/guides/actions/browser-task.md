# browser task

<!-- amux:content -->
Read and run saved Browser task versions

Read `browser task assets --browser <id>` to select an existing immutable version.
Use `browser task reliability --browser <id> --asset <id> --version <n>` to read
retained version/run/outcome evidence. A completed script is not proof of a successful
outcome, and zero samples have no pass rate.
Run with `browser task run --browser <id> --asset <id> --version <n>`, fresh JSON
object parameters on stdin (at most 64 KiB), and optional `--run <id>` to continue
the original ready cursor. Values never enter the saved asset or durable progress.
`--step` runs one eligible step. This path cannot approve a human checkpoint or
take Browser input back from the person. `browser task stop --browser <id> --run <id>`
stops the original run while preserving its cursor.
For a bounded batch, use `browser task batch --browser <id> --asset <id> --version <n>`,
fresh stdin JSON {parameters: {...}, items: [{id: "one", parameters: {...}}]} and optional
`--batch <id>` to continue the original eligible group. Each of 1–16 unique items uses
its own original task run. Values are transient; retained item results have run identities
and statuses. Group limits are 256 operations and 120 seconds of execution.
Unknown actions or human checkpoints stop continuation; no automatic approval or replay.
`browser task batch-stop --browser <id> --batch <id>` stops preparation and current
execution while preserving original progress. This does not reclaim human input.
