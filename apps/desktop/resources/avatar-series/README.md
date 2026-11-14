Built-in avatar series a person can choose for a Mote. Each directory is one series described by its `series.json`; choosing from a series never replaces a saved or default Mote avatar automatically.

- `geometry/`: the CC0 RobotExpressive model by Tomás Laulhé, adapted by Don McCurdy, taken from Three.js r180 (commit 0af9729d0c143a86a1d725d6e2c3ad83301f3f34). Its geometry, rig and morph targets are unchanged; the editor applies standard Three.js PBR and Toon materials. It is a material and expression study, not the final Mote brand character. Attribution is in [geometry/SOURCE.md](geometry/SOURCE.md).
- `lowpoly/`: original AgentMux low-poly PNG artwork from the reviewed Mote gallery, cropped through the existing immutable image owner.
- `mote-silhouettes/`: the "Mote art directions" series, twelve Mote silhouettes in different art directions, each shipped as a PNG with its SVG.

Main reads these files at runtime from the packaged resources, which is why they live here rather than with the brand sources in `packages/client-ui/brand`.

## Adding your own series

Your own series live on the Host in `~/.agentmux/avatars/<series>/` and appear next to these built-in ones. Declaration fields, method results and input limits are defined in the [avatar series contract](../../../../docs/specs/mote-avatar-series.md); exact flags come from `amux space mote avatar --help`.

1. Create the directory. `amux space mote avatar series create --series <id> --title "<title>"` creates it with `starter.png`, a `series.json` and an editing `README.md`, and refuses a directory that already exists. `amux space mote avatar series reveal --series <id>` asks the Host to open it in the file manager. You can also create the directory yourself.
2. Add artwork. Plain PNG and JPEG files appear as entries named after their file, with no declaration. Add a `series.json` to give entries titles, a 2D face or a GLB model. This is the bundled `geometry/` declaration; its indices exist in `RobotExpressive.glb` (materials 0–2, mesh 2 "Head" with morph targets 0–2, node 13 "Head"):

   ```json
   {
     "schema": "agentmux.avatar-series.v1",
     "title": "Geometry · 3D study",
     "entries": [
       {
         "id": "expressive",
         "title": "Expressive · CC0 study",
         "definition": {
           "kind": "glb",
           "file": "RobotExpressive.glb",
           "materials": [{ "index": 0, "role": "shell" }, { "index": 1, "role": "shell" }, { "index": 2, "role": "graphic" }],
           "morphs": [
             { "id": "a", "label": "Anger", "meshIndex": 2, "targetIndex": 0 },
             { "id": "b", "label": "Surprise", "meshIndex": 2, "targetIndex": 1 },
             { "id": "c", "label": "Thought", "meshIndex": 2, "targetIndex": 2 }
           ],
           "framing": { "nodeIndex": 13 }
         }
       },
       { "id": "owl", "title": "Owl · image", "definition": { "kind": "image", "file": "owl.png" } }
     ]
   }
   ```

   For your own model, replace every `index`, `meshIndex`, `targetIndex` and `nodeIndex` with values that exist in that model; names and labels are display text only. `list` does not open model files; an index the model does not have makes `preview` of that entry fail.
3. Check the series. `amux space mote avatar list` returns the roots, series and issues; a malformed entry never hides the other images. To check one entry, pass `{"source":{"origin":"user","seriesId":"<id>","entryId":"<entry>"}}` to `amux space mote avatar preview --input -`; the result carries the entry's content `revision`.
4. Choose the avatar for a Mote in the Mote's appearance editor in Desktop. Saving publishes the 256×256 PNG frame the editor renders; the series files themselves are not changed.
5. Check an uncertain save. Take the Mote's `workspaceId` and `topicId` from `amux app snapshot --include motes`, and use that entry's `spaceId` as `objectKey`. Pass `{"target":{"workspaceId":"…","topicId":"…","objectKey":"…"},"operationId":"<the save's UUID>"}` to `amux space mote avatar read --input -`. To retry, resend the identical save request with the same `operationId`; the same UUID with a different body is refused, and a save already published or recorded is not published again.
