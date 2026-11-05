# Plinth

A 3D site and building editor for the browser, the desktop and phones. Cities live in a gallery; each opens in two editors:

- **Site editor** (where it starts): streets with lanes, sidewalks, bike lanes, parking and zebra crossings, straight or curved, joined where they meet; and buildings as shells (outer walls, floors and roof) that you draw, place and rotate; their shape is edited in the building editor. Far away, windows and doors drop out.
- **Building editor** (double-click a building): one building in detail. Draw walls directly in 3D; walls that cross or meet in a T stay separate until you join them with the button over the intersection. Enclosed spaces become rooms with live areas, floors stack into the building, and windows and doors cut into walls and open and close.

The concept doc lives at https://claude.ai/artifact/1Mvw2qn1LBB8vHTZZPhmj7.

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | The site model, stored in a Yjs document: buildings, levels, walls and openings, streets; rooms, areas and slabs derived from the walls; street surfaces and junctions; geometry, snapping, undo, file format, area report. Plain TypeScript, no React or three.js. |
| `packages/editor` | `<PlinthEditor document={doc} />`: the React Three Fiber view with the site and building editors, tools, toolbar, building and level lists, properties panel; `exportGLB(snapshot)` for glTF. Embeddable in other React apps. |
| `apps/web` | The web app: a gallery of cities kept in the browser (each saved as it changes, with a thumbnail), the editor, opening and saving `.plinth` files, exporting `.glb` models and `.csv` area tables. |
| `apps/desktop` | The Tauri v2 shell that wraps `apps/web` as a desktop app. |

## Scripts

```sh
pnpm install          # install dependencies
pnpm dev              # web app at http://localhost:5173
pnpm desktop:dev      # desktop app (needs Rust)
pnpm desktop:build    # desktop app bundle
pnpm build            # production web build
pnpm check            # type check, lint and test everything
```

To try the web app on a phone on the same network, run `pnpm --filter @plinth/web dev --host` and open the address it prints.

## The look

The world is drawn as a monochrome model in sunlight: off-white buildings with soft shadows that reach to the horizon, windows and doors in the walls' colour (they show by their depth and shadows, as on a white model; on the site, by the shadows of their surrounds up close), light grey streets with their lanes, sidewalks, markings and zebra crossings, a neutral ground and a pale sky that hazes towards the horizon. The interface floats over it: panels at the sides and the tools in a dock at the bottom. View at the top left (the sliders button in the building editor) sets the time of day (the sun moves along a real path for a mid-latitude summer day, 6:00 to 18:00, with softer, warmer light and longer shadows morning and evening), picks the lens, and turns soft shading and outlines on or off. These settings are remembered.

Two things make the light read as real:

- **Cascaded shadows.** The view is cut into bands by distance, each with a shadow map of its own (`scene/sun.ts`, three.js's CSM), so shadows are crisp up close and still cover a whole city in the distance, and they hold still while the view moves.
- **Soft shading** (ambient occlusion): the sky's light that corners, the foot of a wall, a courtyard or a street between towers don't get, worked out on the screen from the depth of the picture (N8AO, `scene/Effects.tsx`). Its reach follows the zoom. It costs the same however big the city is. It is on by default, except on phones and tablets.

This is not full global illumination (light bouncing from surface to surface), which a browser can't do live for a city; the soft shading gives most of its look for a white model. `patches/n8ao@2.0.1.patch` fixes N8AO's half-resolution mode for three.js 0.187.

## Roofs

A roof is a setting of its building and sits on its top floor's outline (`packages/core/src/geometry/roofs.ts`). Shed and gable roofs are planes over the outline; hip roofs come from the outline's straight skeleton (`skeleton.ts`): every edge moves inwards at the same speed, and the faces they sweep are the roof's slopes. It works for any outline, holes included, and checks its own result (each face on its edge's slope, the faces covering the outline exactly once), falling back to no roof rather than a wrong one. Roofs are drawn on the site and in the building editor, counted in a building's total height and exported with the model.

## Large cities

Plinth is built to show whole cities. The **Metropolis** example (Examples › Make a copy) is a stress test the size of Manhattan: about 44,000 buildings, 440,000 floors, 4,400 streets and 1.6 million windows and doors (in 280,000 records). Every building has a ground floor of shopfronts round its front door, a typical upper floor with rows of windows front and back (and on the avenue at a corner), and a run of copies of it to the top. What makes that work:

- **Runs of floors.** A run of identical floors is one level record with a count, not a record per floor, so a tower's 60 typical floors cost as little as one.
- **Rows of windows.** A row of identical windows or doors along a wall is one record with a count and a spacing (In a row, in the window's panel), so a facade's worth costs as little as one window. A row moves as one; splitting its wall splits it.
- **Incremental analysis.** Each level's analysis is reused while its walls and points are unchanged, and each building's while its levels are; a floor that is one closed loop of walls is analysed directly, without polygon operations, and its rooms are worked out only when the building is opened. Editing one building re-analyses that building.
- **Streets in pieces.** Each street and each junction is built on its own, edge to edge with its neighbours, with no network-wide polygon operations.
- **Tiles.** Buildings and streets are merged into one mesh per tile of the ground, so the city is a few hundred draw calls; a change rebuilds one tile. A simple building is its outline extruded, one block per run of floors. Windows are flat panes made only for the tiles near the camera, when it comes near, and street markings drop out with distance.
- **Spatial indexes** for picking streets, snapping and finding nearby points, so nothing scans the whole city on a mouse move. Lists show a few hundred items and filter for the rest.

`BENCH=1 npx vitest run src/examples/metropolis.test.ts --silent=false` in `packages/core` times it (about 2.5 s to build, 2 s to analyse, 0.2 s to re-analyse after an edit; the document takes about 600 MB of memory). In the browser it opens in about 10 s on a desktop.

## The gallery

The app opens on the gallery: every city you have, newest first, with a picture and its numbers. New city starts an empty one; Open file… brings in a `.plinth` file as a new city. Each card's menu renames, duplicates, saves to a file or deletes it. "Cities" at the top left of the editor goes back.

The first time the gallery opens it adds **Harbour City**, an example of about 160 buildings (a street grid with a boulevard, a curved harbour drive and a diagonal park road, and a town hall and library with their rooms drawn). Examples › Make a copy builds a fresh one, or **Metropolis**, the large stress test (see below). Both are generated in `packages/core/src/examples`.

## Using the site editor

| Action | Mouse and keyboard | Touch |
| --- | --- | --- |
| Draw streets (L) | Click points, or type a length; Enter or double-click to finish. Streets join where they end on or cross another | Drag to aim, lift to place; Done |
| Street settings | Select a street: lanes, lane width, sidewalk / bike lane / parking per side, zebra crossings at each end, "Use for new streets". With the Street tool and nothing selected, the panel sets the defaults | Same |
| Bend a street | With the Street tool, drag the handle in its middle; Straighten in the panel | Same |
| Move street points | With the Street tool, drag a point, or the handle in the middle of the street under the pointer to bend it; deleting a point between two streets joins them | Same |
| Building (B) | Click the corners; click the first corner again or press Enter to close | Aim and lift; Close |
| Select a building (V) | Click it. Position, rotation, floors, floor height and name in the panel. Dragging moves the view, never the building | Tap |
| Roof | Select a building: Flat (with a parapet and overhang if wanted), Shed, Gable or Hip, with pitch, overhang and thickness; "Turn the ridge" turns it a quarter, and it follows the longest side until turned. A gable carries its end walls up to the roof; a hip roof slopes on every side of any outline (an L gets a valley, a courtyard block a ring of slopes). Also in the building editor's whole-building panel | Same |
| Reshape a building | In the building editor (double-click it) | Same |
| Building name | Hover a building: its name shows at the bottom of the view (the selected one's when nothing is hovered) | Tap it |
| Go inside | Double-click the building, Enter, or "Edit building" | Double-tap, or the panel |
| Focus on a building | Select it (or several), then H or "Hide other buildings" in the panel: only those are drawn, on the site and in the building editor. H or "Show all buildings" brings the rest back | The panel |

## Using the building editor

| Action | Mouse and keyboard | Touch |
| --- | --- | --- |
| Back to the site | Esc (after it has ended drawing, cleared the selection and shown the whole building), or "Site" in the breadcrumb | Breadcrumb |
| Draw walls (W) | Click points; click the start to close, or Enter / double-click to finish | Drag to aim, lift to place; Done to finish |
| Exact length | Type a number while drawing (`3.5`, `350cm`), then Enter | Length button |
| Window (O) / Door (D) | Click a wall; pick the type in the panel | Drag along a wall, lift to place |
| Move / resize an opening | Select it, drag it along the wall (windows also up and down), or drag its corner and edge handles | Same |
| Row of windows or doors | Select one; In a row sets how many, Centre to centre how far apart. Selecting any of them selects the row; it moves as one and is sized in the panel | Same |
| Floors | Level list: click to switch, + to add; Page Up / Page Down | Level list |
| Whole building | Esc (after it has ended drawing and cleared the selection), click the active floor again, "Whole building" in the list, or B. Walls and points that line up across floors are selected, moved and edited together | Level list |
| Repeat a floor | Copies above (in the level's panel); a copy can be detached | Same |
| Select (V) | Click walls, points, windows, doors or rooms; Shift-click to add; drag to move | Tap; drag |
| Join / separate walls | In Select, click the button over a crossing or T | Tap the button |
| Open / close | Double-click a door or window in any tool, or use the panel (also flip hinge and side) | Panel |
| View options | View (on the site) or the sliders button in the level list: time of day, lens (24, 28, 35 or 50 mm; 35 mm by default), floors above, fade other floors, hide other buildings (H), outlines | Same |
| Delete | Delete / Backspace. Deleting a point joins the two walls on either side of it | Delete in the panel |
| Move / orbit / zoom | Left-drag on empty space (also middle-drag or a two-finger trackpad drag) moves over the ground / right-drag orbits / wheel or pinch moves the camera towards or away from whatever is under the pointer, which stays under the pointer; it slows as it nears it and stops short, never flying into a building (the lens stays as set). Near the ground the view levels out, so zooming towards a street ends up standing in it | Two fingers / three fingers / pinch |
| Top view | T | Toolbar |
| Snapping | S toggles; hold Alt to suspend | Toolbar |
| Undo / redo | ⌘Z / ⇧⌘Z | Toolbar |
| Export | File › Export 3D model (.glb, every building and the streets) or areas (.csv, per building and in total) | Same |

Moving, orbiting and zooming the view, the lens and the time of day, the top view (T), hiding other buildings (H), snapping (S), undo and redo work the same in both editors. In drawing tools a click places a point and a drag moves the view. Files from before the site editor (version 2 and older) can no longer be opened.
