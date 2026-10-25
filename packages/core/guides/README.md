# AgentMux system guides

These Markdown files are the source of the system instructions read by people and by
`amux`. They ship with Core and apply independently of any project's Agent instructions.

- [Start here](index.md): identity, progressive discovery and the module directory.
- [Agent Sessions](modules/agent.md), [A2A messages](modules/message.md),
  [spaces](modules/space.md), [Browser](modules/browser.md), [Goals](modules/goal.md),
  [Capsule pages](modules/capsule.md)
  and the other files in [modules/](modules/) are exposed by `amux MODULE --skill`.
- [actions/](actions/) contains longer instructions attached to the relevant help or manual,
  including [Browser programs](actions/browser-run.md), [Agent opening](actions/agent-open.md)
  and its [remote execution workflow](actions/remote-execution.md), and the [PMO manual](actions/mote-pmo.md).
- [shared/](shared/) holds text with more than one real consumer, including the
  [communication contract](shared/messaging/contract.md), short
  [entry](shared/messaging/entry.md) and [reminder](shared/messaging/reminder.md), and
  [Goal responsibilities](shared/goal/contract.md).

## Maintaining system guides

Edit the owning Markdown once. Keep product requirements in their owning design
document and executable facts in their original code registry. This directory explains
how to use those capabilities; it does not create commands, grant permissions or prove
that a model adopted an instruction. Choose the applicable change below, then use the
[validation table](#validation-and-delivery).

### Change existing text

1. Find the source in `index.md`, `modules/`, `actions/` or `shared/`. Edit that source,
   never the generated TypeScript or a second copy of its text in a consumer.
2. Identify affected readers before editing. Follow incoming `amux:include` links and
   named document imports; for shared instructions also inspect the launch, resume,
   Goal or other composition function that supplies them. Search for both the guide ID
   and its generated export, then follow the existing adapter to its callers.
3. Generate and check. Read the Markdown and generated diff together: a shared edit
   can change several documents. Headings or ordinary prose before the content marker
   change direct reading only; module frontmatter still feeds directory and module
   metadata. Review the affected instructions for preserved authority, recovery,
   unknown outcomes and recipient responsibilities, as applicable.
4. When changing emitted guidance, read the affected output through the corresponding
   built CLI or original runtime composition function. A navigation-only README edit
   needs source, link and semantic review, without rebuilding unchanged consumers.

`README.md` files are navigation and maintenance documentation, excluded from generated
guide bodies. Other `.md` files in this tree are discovered automatically. Use UTF-8
and LF newlines, exactly one content marker on its own line, and a nonempty body after
it. The title before the marker is for direct reading. Apart from explicit include and
generated-fact composition, the generator preserves body bytes, removing one final LF;
the CLI adds module metadata and discovery separately.

### Add a module

A module guide documents a real root in `AGENTMUX_CLI_COMMANDS`, not a new command
created by placing a file here. For an implemented root, add `modules/ROOT.md` with
exactly these three nonempty string metadata fields:

```markdown
---
summary: "What this module provides"
roles: "Who needs this guidance"
when: "When to load it"
---

# ROOT

<!-- amux:content -->
Explain the object, owner, useful journey, receipts and recovery boundaries.
Point to the actual command help for precise arguments.
```

Replace `ROOT` with the registered root. Generation includes its metadata in the
directory; `check:guides` requires the module set to match the executable registry.
Read both the base `--skill` directory and `ROOT --skill`. A new public capability
still needs its actual parser, service and consumer implementation; this template is
only its manual.

### Add an action or another consumer

An action guide has the same title and content marker, without module frontmatter.
Place it in `actions/` and regenerate. **Discovery does not wire an action to help.**
Import its named document and use `guideText` in the existing guide adapter or owning
consumer. For example, `actions/example.md` generates the following names; substitute
the real source and consumer rather than adding this placeholder:

```typescript
import { guideActionsExample } from './generated/agentmux-guides.js'
import { guideText } from './guide-text.js'

export const EXAMPLE_GUIDE = /* @__PURE__ */ guideText(guideActionsExample)
```

Keep a top-level, pure string composition marked pure so unrelated consumers can be
removed by bundlers. Facts, if required, come from the original owner as described
[below](#compose-shared-text-and-code-owned-facts).

For help, connect the adapter at the intended path in `agentMuxCommandHelp`; the path
may be a group or a leaf. Some manuals have another real owner, such as
`agentMuxPmoPlaybook`. Follow the existing consumer rather than forcing every action
into help or appending it to every child. Update the nearby navigation and prove that
the exact intended read returns the new guidance. `check:guides` can pass for an
unreferenced action file: add a focused assertion at the actual consumer so removing
the new connection makes verification fail.

### Compose shared text and code-owned facts

Extract `shared/` text only when more than one real consumer needs the same rule.
Include it with an ordinary relative Markdown link whose title is `amux:include`:

```markdown
[A2A communication contract](../shared/messaging/contract.md "amux:include")
```

The example is relative to a module. People follow the link; generation expands it.
Before renaming or deleting a guide, update incoming includes, named imports and
navigation. Before changing a shared rule, review every affected composition, including
short entry or reminder variants that may link to the full contract instead of including
it. Existing frozen inputs retain their original text; an edit only affects future
composition through the updated version.

Keep command availability, parameters, capability names and protocol catalogs in their
original registries. A link titled `amux:generated NAME` names a finite code-owned fact;
use an existing guide and its consumer as the example. A new named fact requires the
generator's explicit supported slot, the typed consumer supplying the value from its
original owner, and a real consumer check. `command:...` facts resolve through the
existing command registry adapter. Do not silence missing facts with casts, copied
catalogs, empty defaults or a second registry. There is no script evaluation or general
template language.

Code-owner links target `dist/`, the same versioned implementation shipped in the
package. Build Core before following them in a checkout; edit the corresponding
`src/` implementation. Keep packaged Markdown links within the shipped Core package;
repository-only contributor references may be written as code paths here.

### Preserve static consumer scope

`src/generated/agentmux-guides.ts` contains named documents and their required fact
types. `src/generated/agentmux-guides-index.ts` aggregates the directory for CLI and
Node readers. Both are generated data. A consumer imports only its named documents;
Browser readers must not import the aggregate index or retain unrelated guide bodies.
Runtime reading stays synchronous, offline and free of filesystem, project and network
lookups. Do not add a resource loader or another runtime authority for a text edit.

## Validation and delivery

Run commands from the repository root. Use the narrowest row covering the actual change;
implementation changes still follow the repository's normal contribution and testing
rules.

| Change | Required guide-specific verification |
| --- | --- |
| Navigation, titles before the marker, or maintenance instructions | Check affected sources, local links and anchors, and the final diff; confirm emitted bodies did not change. |
| Emitted text, metadata, includes or existing facts | Run `pnpm --filter @agentmux/core generate:guides` and `pnpm --filter @agentmux/core check:guides`; review affected rendered output and semantics. |
| A new or changed consumer, slot, generator or static import boundary | Run the preceding checks and focused consumer verification; `node packages/core/scripts/verify-system-guides.mjs --source-proof` exercises source consumers, negative controls and Browser isolation without requiring `dist` or a historical baseline. |
| Build or package delivery of the changed guidance | Build the current dependency closure with `pnpm --filter @agentmux/core... build`, then run `node packages/core/scripts/verify-system-guides.mjs --package-proof` for source/build/package agreement, installed CLI reads, offline behavior and Browser isolation. |

`check:guides` checks freshness, metadata, include resolution, required fact types and
the real module/help/PMO/runtime/Goal read-only consumers. Its source check privately
transpiles current code and removes its temporary output; it does not trust an old
`dist`. It rejects empty or unresolved output, but cannot judge prose, ensure every new
action is connected, or prove that an installed CLI or live Agent uses this source.

To inspect actual CLI output after a current build, use the built entry explicitly:

```sh
node packages/core/dist/agentmux.js --skill
node packages/core/dist/agentmux.js message --skill
node packages/core/dist/agentmux.js browser run --help
```

Choose the affected module, group, leaf or manual read; these are examples, not a demand
to read every guide. For injected text, inspect its original composition function as
well. A globally installed `amux` or `$AGENTMUX_CLI` can be another version; identify
that version separately when verifying an installation.

`verify-system-guides.mjs --parity` is for byte-preserving migration review against a
local pre-migration baseline. `--prepare` also compares that baseline when present;
running without a mode reuses a matching local receipt. These modes are not the normal
test for an intentional prose change. Use the source/package modes above; do not rewrite
or delete historical evidence to make changed wording pass an old equality check.

| Failure | Repair at the owner |
| --- | --- |
| Generated guides are stale | Edit Markdown, regenerate and inspect both generated files; never patch generated strings. |
| Invalid metadata, marker, include, or include cycle | Fix the source shape or actual link graph; one nonempty module body and exactly the declared fields are required. |
| Module set differs from executable registry | Reconcile the real registered root and its manual; do not register a dummy command to satisfy discovery. |
| Missing fact type/value or unknown command fact | Supply the original code-owned fact and update the real consumer check; do not use an empty fallback. |
| New manual does not appear at the intended read | Fix the consumer/help route and its focused assertion; file discovery alone is insufficient. |
| Browser retains unrelated guides or Node dependencies | Restore named static imports and inspect the real entry's bundle; do not import the CLI index. |

Commit the Markdown and both generated files together when their output changes, plus
the consumer and focused checks when wiring changes. Review the exact file list and
affected links; do not commit local proof receipts or process files. A source edit,
build, installed CLI and live model adoption are separate facts. Report only the
versions and consumption paths actually checked; updating a manual never rewrites
previously frozen inputs.
