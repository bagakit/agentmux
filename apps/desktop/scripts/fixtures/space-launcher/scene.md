# Space Launcher

Owning presentation: [空工作面的默认呈现](../../../../../docs/design/presentation/spaces-and-layout.md#空工作面的默认呈现).

Run `node apps/desktop/scripts/capture-space-launcher.mjs` from the repository root. The isolated Electron loads the production Workbench, Launcher, rich inputs, Store, theme and imported CSS. Its receipt binds compiled consumers, imported styles and full screenshots to their source hashes.

Review the wide dark/light, narrow and short workfaces against the Settings reference. The environment, complete executor catalog, composer and Launch action should form a clear reading order; Mote and utility surfaces remain secondary. Short and narrow workfaces must keep every control reachable through the shared scroll owner.

The same production surface is captured with 16 declared Agents and a long selected Mote name, including the final visible catalog row. Geometry asserts a separate catalog/composer gap, no horizontal overflow and unchanged selected target and original warm Run. The shipped banner asset is consumed by the actual CSS in both themes. Trusted Tab keys then move from the selected Mote chooser to Resume and Launch. A controlled detection failure invokes the real Store owner and captures the nonblocking recovery service window with Launch still available.

For the initial-page affordances, inspect the complete `Discuss with [avatar] Mote` button on the left and grouped Resume/Launch on the right. Compare the catalog's `-start` and end frames: the next partially visible row, fine scrollbar and edge fade should suggest continuation without an extra text action row. Native Chromium wheel input reaches and selects the last Agent, then scrolls back; Tab reaches and fully reveals the final choice. The end boundary removes its fade, and fitting choices have no false continuation. Expanding the short Region keeps focus on the same choice; `catalog-expanded-keyboard-focus` records this state.

`LAUNCHER_AFFORDANCE_MUTATION=overflow|position` compiles an isolated counterexample that removes the continuation signal or restores the unwanted right-side Mote grouping. Each must fail the corresponding Renderer assertion; rerun without the variable for the accepted candidate. The receipt records the exact transformed module and hash; the shared source tree is never mutated.

Trusted Chromium operations edit the real prompt, open Options, reach its name inputs and dismiss without losing the draft. They also edit and reopen Browser/Note, collapse and expand the original Terminal, and open the Mote target chooser. The fixture checks original targets and retained Terminal identity through controlled preview API facts.

Independent subjective review is required; capture success does not approve aesthetics. The fixture uses an isolated profile and controlled external API seams. It does not operate the user's installed App, real Agent Sessions or native CLI, and does not prove durable Runtime recovery.
