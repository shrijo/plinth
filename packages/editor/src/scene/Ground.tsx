import { sortedLevels, terrainOf } from '@plinth/core'
import { Grid } from '@react-three/drei'
import { useEffect } from 'react'
import { CanvasTexture, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace } from 'three'
import { useEditor, useSnapshot } from '../context.ts'
import { COLORS, PALETTES, type Palette } from './materials.ts'

/** The ground reaches this far out (metres) and fades into the haze. */
const GROUND_RADIUS = 9000
/** One tile of the ground texture covers this many metres. */
const TILE = 24

// Pushed back in depth, so floors, streets and anything else at ground level always draw over it.
const groundMaterial = new MeshStandardMaterial({
  roughness: 1,
  metalness: 0,
  polygonOffset: true,
  polygonOffsetFactor: 4,
  polygonOffsetUnits: 8,
})

/** A tile of grass: the ground colour with soft speckles, so large lawns don't look flat. */
function groundTexture(palette: Palette): CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const context = canvas.getContext('2d')!
  context.fillStyle = palette.ground
  context.fillRect(0, 0, size, size)
  if (palette.groundSpeckle !== palette.ground) {
    // A fixed pattern (no Math.random), so it's the same every time.
    let seed = 7
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
    context.fillStyle = palette.groundSpeckle
    for (let i = 0; i < 900; i++) {
      context.globalAlpha = 0.25 + random() * 0.45
      context.beginPath()
      context.arc(random() * size, random() * size, 1 + random() * 3.5, 0, Math.PI * 2)
      context.fill()
    }
  }
  const texture = new CanvasTexture(canvas)
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.repeat.set((GROUND_RADIUS * 2) / TILE, (GROUND_RADIUS * 2) / TILE)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 8
  return texture
}

/**
 * The ground: grass (or plain, in the clay style) out to the horizon. The
 * snap grid shows while drawing (inside a building, at its lowest level).
 */
export function Ground() {
  const snapshot = useSnapshot()
  const gridSize = useEditor((s) => s.snap.gridSize)
  const site = useEditor((s) => s.mode === 'site')
  const drawing = useEditor((s) => s.tool !== 'select')
  const buildingId = useEditor((s) => s.buildingId)
  const style = useEditor((s) => s.style)
  const palette = PALETTES[style]
  const ground = site ? 0 : (sortedLevels(snapshot, buildingId ?? undefined)[0]?.elevation ?? 0)
  // Below the terrain, where there is one, so it never covers it.
  const terrain = terrainOf(snapshot)
  const groundLevel = terrain ? Math.min(-0.06, terrain.low - (snapshot.meta.ground ?? 0) - 0.5) : -0.06

  useEffect(() => {
    const texture = groundTexture(palette)
    groundMaterial.map = texture
    groundMaterial.needsUpdate = true
    return () => texture.dispose()
  }, [palette])

  return (
    <>
      <mesh rotation-x={-Math.PI / 2} position-y={groundLevel} material={groundMaterial} receiveShadow raycast={() => null}>
        <circleGeometry args={[GROUND_RADIUS, 64]} />
      </mesh>
      {drawing && (
        <Grid
          // Just above the ground floor's slab, so the grid shows inside rooms too.
          position={[0, ground + 0.004, 0]}
          infiniteGrid
          cellSize={gridSize}
          cellThickness={0.5}
          cellColor={COLORS.gridCell}
          sectionSize={site ? 10 : gridSize < 1 ? 1 : gridSize * 4}
          sectionThickness={1}
          sectionColor={COLORS.gridSection}
          fadeDistance={site ? 400 : 90}
          fadeStrength={1.5}
        />
      )}
    </>
  )
}
