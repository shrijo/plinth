# Plinth

A 3D site and building editor for the browser, the desktop and phones. Cities live in a gallery; each opens in two editors:

- **Site editor** (where it starts): streets with lanes, sidewalks, bike lanes, parking and zebra crossings, straight or curved, joined where they meet; and buildings as shells (outer walls, floors and roof) that you draw, place and rotate; their shape is edited in the building editor. Far away, windows and doors drop out.
- **Building editor** (double-click a building): one building in detail. Draw walls directly in 3D; walls that cross or meet in a T stay separate until you join them with the button over the intersection. Enclosed spaces become rooms with live areas, floors stack into the building, and windows and doors cut into walls and open and close.

And **the world** (Explore the world, in the gallery): the whole globe with real streets, buildings, water and hills, built as you look from open map data. Search for a place, fly there, and make a site from a square of it; the real city stays around the site.

The concept doc lives at https://claude.ai/artifact/1Mvw2qn1LBB8vHTZZPhmj7.

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | The site model, stored in a Yjs document: buildings, levels, walls and openings, roofs, streets, parcels, spot heights, room tags; rooms, areas and slabs derived from the walls; street surfaces and junctions; roofs (with a straight skeleton), terrain, area figures by SIA 416 and DIN 277; IFC and DXF writers, GeoJSON and XYZ readers; geometry, snapping, undo, file format. Plain TypeScript, no React or three.js. |
| `packages/editor` | `<PlinthEditor document={doc} />`: the React Three Fiber view with the site and building editors, tools, toolbar, level list, properties panel; `exportModel(snapshot, format)` for glTF, OBJ, STL and USDZ. Embeddable in other React apps. |
| `packages/world` | The real world from open data: geodesy (WGS 84, local frames), web map tiles, reading vector tiles (OpenMapTiles scheme) and terrain tiles (terrarium PNGs, read without a canvas), meshes for a tile's ground and buildings, painting the ground's picture, choosing tiles for a view, place search (Photon, Nominatim), OpenStreetMap through Overpass, and planning and building a site from a square of the world. No React or three.js. |
| `packages/sync` | Keeping a project's Yjs document in step with other copies: a change store and a live channel (interfaces), with memory versions for tests. |
| `apps/web` | The web app: a gallery of cities kept in the browser (each saved as it changes, with a thumbnail), the editor, opening and saving `.plinth` files, imports and exports, and the optional cloud (Supabase: accounts, sharing, live collaboration). |
| `supabase` | The database set-up for the cloud. |
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

## Exchange and areas

File › Export writes the whole site:

| Format | What's in it |
| --- | --- |
| glTF (.glb) | Every building (walls, windows and doors, slabs, roofs) and the streets, in the editor's colours. For game engines, 3D tools and the web. |
| OBJ, STL | The same shapes, without colours. STL with Z up, for 3D printing. |
| USDZ | The same, for AR on iPhone and iPad. |
| IFC 4 (.ifc) | For BIM software: a storey per floor; walls with openings filled by windows and doors; slabs; roofs; rooms as spaces with their names, uses and areas. Geometry is triangulated, so it matches the editor exactly; a run of identical floors shares its shapes. Checked with web-ifc. |
| DXF (.dxf) | Floor plans for CAD, AutoCAD R12, metres. Layers per floor (`F00` the ground floor): walls (outline and fill), openings with door swings, rooms with name and area; site layers for footprints, streets, parcels and contours. |
| CSV | Every room (name, use, category) with its areas and volume, totals per floor and building, and the area standard's figures. |

**Area figures** follow the project's standard, chosen in the site's panel: **SIA 416** (GF, KF, NGF, NF, HNF, NNF, VF, FF, GV) or **DIN 277** (BGF, KGF, NRF, NUF 1–7, TF, VF, BRI). A room's use decides its category; a room without one counts as main usable area and is shown as not set. The figures are in each building's panel, the site's (for large sites, on request) and the CSV.

## Parcels and terrain

- **Parcels** (Parcel tool, P): draw an outline like a building's; drag its corners with the tool; click inside one to select it. The panel gives its area, the buildings on it, site coverage (ÜZ with SIA, GRZ with DIN) and floor area ratio (GFZ). File › Import parcels reads GeoJSON (cadastral or OpenStreetMap exports), in longitude and latitude or projected metres such as Swiss LV95.
- **Terrain** (Terrain tool, G): spot heights, clicked onto the ground (each starts at the ground's height there) and dragged, or imported from XYZ or CSV files (x, y, height per line). A surface is drawn through them with contour lines; parcels follow it. A building's panel offers **Set on the terrain**, which puts its ground floor at the lowest ground under it. Streets follow the terrain.
- Imports remember the real-world point at the site's zero, so parcels and terrain imported later line up. The first terrain import sets which height the site's zero stands for (its lowest ground); it can be changed in the Terrain tool's panel.

## The world

**Explore the world** in the gallery opens the globe. Everything on it is made while you look, from open data:

- **Map data**: OpenStreetMap, as vector tiles from [OpenFreeMap](https://openfreemap.org) (OpenMapTiles scheme, zoom 0 to 14). The ground's picture (land, water, parks and woods, roads, railways and building outlines) is painted per tile, and buildings are extruded from their footprints to their heights.
- **Ground heights**: terrarium tiles from the open terrain tiles on AWS (SRTM and other public sources, zoom 0 to 15). The ground is a grid draped over them, following the Earth's curve. Close up the heights are smoothed first (grids made once per square, so asking the ground's height is one look-up): lightly for the land, widely for what street beds and buildings follow. Near anything built the land takes that wider trend, since in town the elevation data's bumps are mostly the buildings and trees themselves. Water lies level, at the low ground round it (the data is flat on water and rises at its banks; smoothing the land itself would tilt a river up towards a high quay), and the ground's points along a shore are kept just under it.
- **Buildings stand on level pads.** The ground under each building, and a couple of metres round it, is one height (the land's trend along its outline, and no lower than a street that reaches it), blending back into the land over a few metres, as a plot is levelled for a house. In town the blocks' surface is cut round every footprint, so it meets each wall exactly at its base. No building is swallowed by a hillside, and neighbours on a slope stand in step with it rather than with the data's noise.
- **Buildings** rise from their footprints to their mapped heights, and a building whose shape says a house (small, compact, low) gets a pitched roof — gabled when its outline is simple, hipped otherwise (the straight skeleton takes any shape) — rising to the mapped height; where no height is mapped at all, the guessed walls stay whole and the roof stands on them. Terraces of many doors, halls, towers and anything cut by a tile's edge stay flat. The roofscape takes a quiet shade of its own. Flat roofs carry what flat roofs have: a parapet round the edge (0.8 m, 1.1 m on towers, with its coping), and on big ones a stair and lift housing and a few ventilation units, aligned with the building and placed the same way every time.
- **Streets** close by are real 3D streets (tidied first, see [Streets](#streets)), built the way the editor builds a site's (core's street geometry: carriageway, bike and parking lanes, raised sidewalks with curbs in town, lane markings, junctions with rounded kerbs) from each tile's map data, cut to the tile so neighbours meet. Everything at road level is then laid as **one surface**: the pieces merged, the slivers map data leaves between ways mapped side by side closed, its inward corners rounded to a kerb's radius and islands too small to stand on taken away (polygon offsetting with Clipper), so a crossing of a dozen ways is one clean piece of road however it was mapped. A road's height comes from the street network itself, level from kerb to kerb however wide it was built, and never under the land. Surfaces are triangulated with a constrained Delaunay triangulation and split only where the ground curves. In town the world draws no sidewalk strips of their own: the blocks between the streets are the pavement, raised to kerb height as one plane that runs from the kerb to the buildings, wrapping the kerbs' rounded arcs at the junctions (the fill is the road plan's complement), warm against the asphalt and a quiet green where the map has parks and greenery; the roads lie sunken between its curb faces. Along open country within town (a big park, the lakefront) the streets keep their pavement strips, raised the same. Under it all the ground doesn't draw itself: each street tile hands the ground a picture of what it covers, and the ground leaves those parts out (the strip along every edge stays, hidden beneath the surfaces, so nothing can show through at the seams). A street crossing water that isn't a bridge rides a causeway just above the surface, on an embankment; shores keep a bank rather than a long smooth ramp. They lie on a level street bed shaped into the ground (smoothed elevation data, flat across each street and curving gently along it like a real road's vertical alignment; where streets meet, their beds blend, so junctions have no step), the land dips a little under them so it never shows through, and every surface reaches four metres down into the ground as a solid, so nothing floats and no gap shows where the land drops away. Further out the streets are painted into the ground's picture; under the 3D streets the picture keeps only a narrow strip of asphalt (their narrowest road), so none shows past their kerbs.
- **Bridges** are streets on a level of their own (OpenStreetMap's `layer`): the same cross-section, lanes and markings as the street that runs onto them, and no junction where they pass over another street. A bridge's deck runs level between its landings unless something under it needs more room: it clears water, the streets and railways it crosses (headroom and the deck's own depth) and lower bridges, and what it needs is passed back along the network at a road's gradient, so the streets leading up to it rise on ramps, as a real approach does. A deck has depth, an edge beam, parapets (not across its mouths) and piers where it stands high (not in a road passing under); where it's low over the ground it's a solid abutment. Footways mapped as bridges of their own beside a street's bridge become its walkways; railway bridges and footbridges get plain decks at heights worked out the same way. Bridges cast shadows and show in the water. Far off, where streets aren't built in 3D, a bridge is a plain deck.
- Tiles load finer as you come closer (a quadtree, split while a texel would cover more than about a pixel), are built in web workers and kept in a cache. The ground never jumps as tiles come and go: each tile knows where its points would lie on its parent's surface (its parent's own heights, at the points they share and along its parent's triangles between), and slides from that shape and that picture into its own by how near each point is, the way terrain engines geomorph their levels of detail. From zoom 12 up the ground is shaped the same way at every level — street beds and fine elevation — so neighbouring levels describe the same surface and the slide moves nothing that shows; the ground never swells over the streets and buildings standing on it. So a tile takes over looking exactly as its parent did and gives way the same, and a split tile merges back only once it's clearly too fine (hysteresis), so the ground doesn't flicker between levels as the view moves. 3D streets, once built, stay a level further out, so they don't blink in and out at the edge of where they're wanted. A square's ground is made once per worker and shared by every tile, building and street on it. Its streets are worked out with the roads of the eight squares round it (a few hundred metres past its edges, and their bridges whole), so a junction at an edge is whole and a bridge crossing one has the same height from both sides; a building across an edge takes its pad's height where it crosses, the same from both sides too. Its streets are planned once and then laid **a quarter at a time**, each quarter by whichever worker is free and the one nearest the camera first, each dissolving in on its own (the ground under it is left out only once it has). What the workers build of streets and buildings is **kept on the device** (IndexedDB, by the map data's date and a build version, the least recently used going past 400 MB), so a place seen before comes back in the time it takes to read it.
- **Grass** on the green spaces, close to the camera (the approach of [grass-shader-glsl](https://github.com/Nitash-Biswas/grass-shader-glsl), as games grow it): instanced blades in square patches round the camera, each a tapering strip turned to face the camera, bent in the vertex shader by a lean of its own, a sway and gusts drifting downwind as a noise field (the weather's wind), and shaded from a dark root to a pale tip. Blades grow where the worker's grass mask says (lawns, sports fields, cemeteries, and the raised green block fills; never on a street, paving or under a roof), and each root is set on whatever surface is really there, read off a height map of the ground round the camera rendered from above every few metres. They thin out with distance and shrink away at the edge of the range, so patches come and go unseen.
- **Streaming**, the way open-world games and Cesium load a world: what's in view comes first, its middle before its edges (foveated). In the slots left over, the world loads ahead: where the camera is heading (its motion carried on a second or so), a view wider than the screen (so a pan or a turn finds tiles ready), the buildings and streets round the spot below, and, during a flight, the destination as it will be seen there. Moving fast, the finest tiles wait, since they'd be stale on arrival. Tiles let go of keep their data in memory (off the GPU, a few hundred MB), so turning back shows them at once with no download or rebuild. New buildings and streets dissolve in over a third of a second (an ordered dither, so they stay opaque), and that first unseen frame uploads them to the GPU. Ground pictures go up as they arrive. React Three Fiber's performance signal (`regress()` while the view moves) steers how much of each frame goes to integrating arrivals: little while moving, more once still. Everything is drawn in a local frame round a point near the view (re-anchored as you move), so even street level on the far side of the globe is precise.

Moving: drag and the ground stays under the pointer (from space, the globe turns), and a quick drag carries on a little when let go. The wheel glides closer to what's under the pointer, which stays put, even in a tilted view; a pinch (or a trackpad pinch) follows the fingers, and a double-click zooms in there (Shift: out). Right-drag (or Ctrl, Shift or Cmd and drag; on touch, two fingers twisting, or sliding up and down together) turns and tilts about the middle of the view. Arrows move, Shift and arrows turn and tilt, + and - zoom. Tilting opens up as you come down, and near hills the camera is lifted over them rather than having its tilt taken away. Search takes place names, addresses or coordinates (`47.37, 8.54`) and flies there. The address keeps the view (`#/world/<lat>,<lon>,<distance>`).

**Make a site here** marks out a square (100 to 1000 m) at the middle of the view. **Make site** turns it into a new city in the gallery:

- **Buildings** from OpenStreetMap through Overpass, one by one, with their floors (`building:levels`, or from `height`), roof shapes (gabled, hipped, skillion and the like, with their pitch), names or addresses. Buildings round a courtyard are cut into wings (Plinth's outlines are solid). Each gets a ground floor and a run of copies above it, and stands on the terrain under it.
- **Streets** with lanes, sidewalks, bike lanes and parking from their tags; footpaths, tunnels and parking aisles are left out. Ways that share a point are joined.
- **Terrain**: spot heights on a grid over the square (8 to 25 m apart). The site's zero is the ground at its middle, and its streets follow the terrain.
- The public Overpass servers are often busy. They are asked one after the other, a few seconds apart; if none answers in 18 s the site is made from the map tiles instead (buildings with their heights, flat roofs; streets by class).

A site made from the world keeps where it is (longitude and latitude, its ground height and its square), and the editor draws **the real world around it** (View › Real world around): the ground, water and buildings for 20 km, with the world's buildings and ground inside the square left out, as the site's own model stands there. The square's water and green are laid over the site's terrain. Any site with a longitude and latitude (from a GeoJSON import, say) gets the world around it too.

**Clouds** (View › Clouds): volumetric clouds over the whole globe, marched through per pixel at half the screen's resolution (Schneider's "Nubis" approach from Horizon Zero Dawn): a shell of low cumulus (from about 1.1 km), a middle layer (3.4 to 5.8 km) and thin high cloud (about 8 km), shaped by tiling 3D Perlin-Worley noise made at start in a worker, lit by the sun through the cloud (darker bases, a silver lining against the light, light bounced inside), hidden behind hills and buildings by the scene's depth, drifting with the wind and fading into the haze. Zooming in from space flies down through them. *Live weather* takes each layer's cover and the wind from [Open-Meteo](https://open-meteo.com) (current conditions from the national weather services' models, on a 20° grid for the world and a 1° grid round the view, kept for 15 minutes; the free service allows 600 points a minute); the noise's own spread is measured so 68% cover leaves 32% of the sky clear. Or pick a sky: fair, changeable or overcast. *Amount* scales whichever it is (3% by default: a few scattered clouds where the weather has an overcast sky). Far off the noise gives way to the cover's average (as mipmaps do), so the globe from space shows the real weather systems without flicker.

Credits: © OpenStreetMap contributors (ODbL), OpenFreeMap, OpenMapTiles, terrain from Mapzen and AWS open data, weather from Open-Meteo (CC BY 4.0); shown in the corner of the world.

## Cloud

Optional: without it, cities stay on the device as before. With it, people sign in (by a link sent by email), share cities and work on them together: every change is kept in the database and passed on live to whoever has the city open, and edits made offline go up when the connection is back. To set it up:

1. Create a project at [supabase.com](https://supabase.com).
2. Run `supabase/migrations/20261105000000_plinth_cloud.sql` on it (SQL editor, or `supabase db push`).
3. In Authentication, keep email sign-in on and add the app's address (`http://localhost:5173` for development) to the redirect URLs.
4. Copy `apps/web/.env.example` to `apps/web/.env.local` and fill in the project's URL and anon key; restart `pnpm dev`.

Then: **Sign in** in the gallery; a city's menu has **Share in the cloud**, then **Invite people…** (by the address they signed in with, as editor or viewer). Shared cities show up for them under **Shared with you**. The editor's header shows whether it's synced and who else is there. Access is checked by the database (row level security) and the live channels are private to the city's members.

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

## Streets

Streets work the way OpenStreetMap describes them, read by OpenStreetMap's own rules — the same stages the reference tools ([osm2streets](https://github.com/a-b-street/osm2streets), [osm2lanes](https://github.com/a-b-street/osm2streets/tree/main/osm2lanes)) use: tags to a cross-section of lanes, lines to a tidy network, then the geometry. A street drawn through several points is one street: where two streets meet end to end at a gentle bend (under 55°), lanes, markings and sidewalks run on through without a break, and where its cross-section changes along the way (more lanes, a sidewalk starting, another type) it tapers from one to the other over a few metres instead of stopping at a junction. Junctions (with kerbs rounded like real ones — the radius follows the narrowest road that meets there — while the back of each sidewalk takes the square corner a real pavement has, so crossings read crisp) are only where three or more streets meet, at a sharp corner, or where a paved living street or pedestrian zone meets a street with kerbs. Each street has a **type** after OpenStreetMap's highway types (motorway, trunk, primary, secondary, tertiary, minor road, residential, living street, pedestrian zone, service road), which sets its usual cross-section in one go, and can be **one way** (no line down the middle). Living streets and pedestrian zones are one paved surface, wall to wall, without curbs or lane lines. In a site on a slope, streets are laid exactly on the terrain (cut along its triangles), so the ground never pokes through them.

Where streets crowd together (map data runs them close, or many meet at once), their surfaces are **layered** the way road tools in games lay theirs: the carriageway wins wherever it is, then bike lanes, parking, paved zones, and sidewalks last, keeping what's left of their strips. So a sidewalk never lies on a road, and the sidewalks of streets running close together meet as one paved island or median. Crumbs are cleaned up: a scrap of sidewalk stranded in a junction becomes road, a scrap of road stranded in paving becomes paving.

Map data is tidied into a network the way a person would draw it, both for the world and for sites made from it:

- **Lanes and widths as OSM defines them.** `lanes`, or `lanes:forward` + `lanes:backward` + `lanes:both_ways`; untagged, [the wiki's assumed values](https://wiki.openstreetmap.org/wiki/Key:lanes#Assumptions) (two-way roads 2, one-way streets 1, motorways and the carriageways of divided trunk roads 2). Widths from `width`/`est_width` shared over the lanes, `sidewalk:*:width` and `cycleway:*:width` where tagged; otherwise osm2lanes' defaults (a driving lane 3 m, narrower on minor streets, 3.5 m on fast roads; sidewalks 1.5–2 m).
- **Surveyed surfaces win.** Where a city maps its street areas ([`area:highway`](https://wiki.openstreetmap.org/wiki/Key:area:highway)), the street is fitted between the measured kerbs: the carriageway outline sets the kerbs, a sidewalk outline (`area:highway=footway`) sets the sidewalk's width. Guesses and footway fitting only fill in where nothing is surveyed.
- **Roundabouts.** A ring tagged `junction=roundabout` runs one way with a single lane; the map tiles drop that tag, so a small, round, closed ring counts as one too. A ring too small to draw as a circle (under about 50 m round) becomes a single junction, as osm2streets does.
- **Marked crossings become zebras.** A `highway=crossing` node tagged zebra, marked or with signals puts a crossing on the street end it sits at (sites made from OpenStreetMap).
- **Crossings and T-junctions.** Streets that cross on the level meet at a junction, and a street ending on another joins it, even where the map leaves out the shared point (map tiles drop it when they simplify a straight line). A dead end heading straight for a street joins it from across its width (map data often stops a street at the kerb).
- **One junction per crossing.** Junction points a few metres apart become one, and so does a small triangle of streets (turning lanes mapped as streets of their own); stray stubs go.
- **Drawn once.** A street mapped twice, or a lane of it mapped as a street of its own, lying on top of another, is drawn once (the greater of the two).
- **Sidewalks where they belong.** The two one-way halves of a divided road (same type, running opposite ways) lose the sidewalks between them where the median is wider than the two sidewalks would be (it's planted, or carries the tram); a narrower median is paved. This is judged for a whole street between junctions, so a sidewalk doesn't come and go along it. A sidewalk tagged `separate` (mapped as a footway of its own) is still drawn with the street, since footways aren't.
- **Sidewalks where they're mapped.** Many cities (Zurich among them) map their sidewalks as footways of their own, each down the middle of the real sidewalk. Where one runs along most of a street (on one side, nearer than any other street), the street's sidewalk is centred on it and its road reaches out to meet it: lanes a little wider or narrower, the rest as a strip at road level. So streets get their real widths instead of a guess from their type. Sites made from OpenStreetMap use `footway=sidewalk` ways for this; the world uses the map tiles' footways.
- **Bridges and tunnels.** A bridge is part of the network on a level of its own (see [The world](#the-world)): it passes over the streets it crosses and lands where it ends. Streets end flat where a tunnel carries them on, each on its own.
- **Squares.** In the world, squares, pedestrian areas and platforms are paved level with the blocks' walking plane (the land dips under them as under streets), layered with the streets: roads cut through them.

Sites made from OpenStreetMap read the type, lanes (a one-way street has half a two-way one's by default), width, oneway, sidewalk, cycleway and parking tags.

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
| Room name and use | Select a room: Name and Use (living, office, storage, corridor, plant room…); the use decides its area category | Same |
| Export | File › Export: 3D model (.glb, .obj), for 3D printing (.stl), for AR (.usdz), BIM model (.ifc), floor plans (.dxf), areas (.csv) | Same |

Moving, orbiting and zooming the view, the lens and the time of day, the top view (T), hiding other buildings (H), snapping (S), undo and redo work the same in both editors. In drawing tools a click places a point and a drag moves the view. Files from before the site editor (version 2 and older) can no longer be opened.
