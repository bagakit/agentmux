# Launcher Mote preference scene

Owning behavior: [Initial Launcher](../../../../../docs/design/behavior/workface-launcher.md#launcher-工作起点), including the most recent explicit Mote choice and the retained archived target. Presentation: [Launcher density](../../../../../docs/design/presentation/spaces-and-layout.md#初始-launcher-的现代工作台密度), including the shared avatar and bounded archive feedback.

```sh
node apps/desktop/scripts/verify-launcher-launchpad.mjs --scenes=mote-preference --output=.tmp/launcher-mote-preference/visual
```

The scene compiles the production Workbench, Launcher, avatar owner and styles, then uses native pointer and keyboard events in an isolated Electron profile. It captures wide and narrow dark/light views, long archived default/selected names, zero active choices, directory read failure, a confirmed missing target, archive unknown, restore failure/success and short windows. It creates one request with the archived original default, chooses image and authored-face Motes through the actual menu, opens a second Launcher and uses another Electron process to re-read the saved target and avatar preferences. Creation remains available; the selected identity, original draft and neighboring preview shell are retained.

Only external directory/archive/image facts are controlled by the fixture. The second process reads the same private Renderer storage before scene setup; it receives the first process's exact external preview facts so its read is independent of re-seeding selection. This is not an installed application, vendor CLI, user Run or native Runtime restart proof. The capture command records exact source, compiled and PNG identities and does not perform aesthetic review; an independent reviewer must inspect every complete PNG.
