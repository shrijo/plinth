import { useFrame } from '@react-three/fiber'
import { EffectComposer, N8AO, ToneMapping } from '@react-three/postprocessing'
import { ToneMappingMode, type EffectComposer as EffectComposerImpl } from 'postprocessing'
import { useEffect, useRef } from 'react'
import { PerspectiveCamera, Vector3 } from 'three'
import { useEditor, useEditorContext } from '../context.ts'

/**
 * Ambient occlusion: the light from the sky that corners, the foot of a
 * wall, a courtyard or a street between tall buildings don't get, worked
 * out on the screen from the depth of what's drawn (N8AO). It's what makes
 * a white model read as solid; its cost depends on the screen, not on how
 * big the city is. Its reach follows how much is in view: a metre or two
 * round a window up close, the depth of a street canyon from above the city.
 */

/** Reach of the occlusion as a share of the height of the view at what the camera looks at... */
const RADIUS_SHARE = 0.03
/** ...less in the top view, which reads as a plan: just the foot of each wall. */
const TOP_RADIUS_SHARE = 0.008
/** ...within these limits (metres). */
const MIN_RADIUS = 0.8
const MAX_RADIUS = 40

const target = new Vector3()

/** The parts of N8AO's pass used here (the package has no types of its own). */
interface OcclusionPass {
  configuration: { aoRadius: number; transparencyAware: boolean }
}

export function Effects() {
  const on = useEditor((s) => s.ambientOcclusion)
  return on ? <Occlusion /> : null
}

function Occlusion() {
  const { controlsRef, renderRef } = useEditorContext()
  const top = useEditor((s) => s.view === 'top')
  const ao = useRef<OcclusionPass | null>(null)
  const composer = useRef<EffectComposerImpl | null>(null)

  useEffect(() => {
    // Faded buildings are see-through and write no depth: let them be, rather than drawing them twice.
    if (ao.current) ao.current.configuration.transparencyAware = false
    renderRef.current = () => composer.current?.render()
    return () => {
      renderRef.current = null
    }
  }, [renderRef])

  useFrame(({ camera }) => {
    const pass = ao.current
    if (!pass) return
    controlsRef.current?.getTarget(target)
    const distance = camera.position.distanceTo(target)
    // How much is in view there, so a long lens (the top view) gets the reach its picture needs.
    const fov = camera instanceof PerspectiveCamera ? camera.fov : 36
    const viewHeight = 2 * distance * Math.tan((fov * Math.PI) / 360)
    const radius = Math.min(Math.max(viewHeight * (top ? TOP_RADIUS_SHARE : RADIUS_SHARE), MIN_RADIUS), MAX_RADIUS)
    const current = pass.configuration.aoRadius
    // Eased a little every frame: a step change repaints the whole shading at once and reads as a flicker.
    if (Math.abs(radius - current) > current * 0.002) pass.configuration.aoRadius = current + (radius - current) * 0.15
  })

  return (
    <EffectComposer ref={composer} multisampling={4} renderPriority={1}>
      <N8AO
        ref={ao}
        halfRes
        aoSamples={16}
        denoiseSamples={8}
        denoiseRadius={12}
        aoRadius={4}
        distanceFalloff={1}
        intensity={3}
        color="black"
      />
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
    </EffectComposer>
  )
}
