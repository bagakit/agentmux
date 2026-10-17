# Browser use settings review

Owning contracts:

- [Settings behavior](../../../../../docs/design/behavior/settings-and-observation.md#browser-use-与-agent-操作呈现)
- [Settings presentation](../../../../../docs/design/presentation/settings-and-observation.md#browser-use-与实时模拟)

Run `node apps/desktop/scripts/capture-browser-use-settings.mjs` from the repository root. The command mounts the original SettingsPanel and module in a private Electron window. Its local config/API fixture never connects to a user Browser, Agent or Run. Actual saving and public CLI consumption are verified separately by `verify-browser-use-settings.mjs`.

Inspect each complete PNG listed by `capture.json`:

1. Wide saved appearance, then enable discussion and step the simulated click.
2. Light and dark application appearance, and a dark sample page.
3. Narrow window, then scroll to Width with the preview and current control visible together.
4. Short window with the original save bar reachable.
5. Reduced motion with readable static identity and page edges.

Judge hierarchy, readable labels, four inward edges, discussion avoidance and the ability to compare an adjustment while editing. The fixture also compares actual normal/screen pixels; this checks functional blending, not aesthetic quality.

`--effect-mutant` privately removes the original shared drawing function. The same pixel assertion must fail. No production file is edited. Captures and source hashes remain ignored local evidence; capture completion does not sign independent visual review or native Browser feedback.
