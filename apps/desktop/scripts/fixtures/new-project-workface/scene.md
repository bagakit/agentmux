# New project workface

Run `node apps/desktop/scripts/verify-new-project-workface.mjs`. The command preserves a local evidence directory and prints its `receipt.json` location. This is a source-based private Electron proof, with a private profile, real ConfigOwner registration and real Core spatial filesystem owner.

The scene consumes the existing contracts for [entity and display bindings](../../../../../docs/design/behavior/spaces-and-layout.md#zonetabsregions-的实体与展示绑定), [initial Launcher](../../../../../docs/design/behavior/workface-launcher.md#launcher-工作起点) and [recovery service windows](../../../../../docs/design/presentation/session-recovery.md#session-恢复服务窗与单目标-attach). It does not define new behavior.

1. Initialize the actual App and invoke production `openProjectFolder`. Record the selected Workspace's empty Group and its existing virtual Launcher and Composer before any durable Tab is created.
2. Invoke production `openLauncher` separately, retain its exact Tab/Group/Region and enter a nonempty original draft. Apply an explicit old `spaceId:null/zoneId:null` selection after normal project discovery supplies the Zone. Capture normal and narrow workfaces.
3. Exit the process and start a new ordinary Electron process with the same private profile and spatial document. Compare the complete original topology, exact selection and draft before capture.
4. Apply an explicit original-descriptor observation gap and two legitimate Space relationships. Hold only the private spatial ACK while capturing unknown membership with the same editable input and original content. Release the ACK before saving; the Core origin is preserved throughout.
5. Exit again and verify a third ordinary process restores the same durable workface, selection and draft. A confirmed original Core source may resolve the earlier unknown membership; the receipt reports that result honestly.

Captures wait for natural finite entrance animations and fonts, then record Agent/Composer/footer opacity, animation states, contenteditable, readOnly, disabled, ariaBusy and ancestor inert/opacity facts. They do not disable, finish or replace the production animation. Open every full PNG for independent visual review under [the existing review workflow](../../../../../docs/guides/agent-visual-e2e-review.md); `passed:true` alone does not approve aesthetics.

Runtime operations and warm Terminal are isolated leaves; the probe admits no Agent lifecycle or send call. Existing preview detection supplies the executor catalog. Missing unrelated file-resource and conversation-history source modules are explicit guards that throw if invoked. The actual Launcher, shared Composer, Workbench, Store, App, structural catalog and persistence writers consume current source, with hashes in the receipt. This proof does not qualify a real Agent/Run, restart the user's App, inspect the user's state, prove the installed package cause or represent a complete production build.
