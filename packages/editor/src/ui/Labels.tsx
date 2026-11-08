import {
  add,
  angleOf,
  dist,
  formatAngle,
  formatArea,
  formatLength,
  midpoint,
  normalize,
  rowCount,
  placeOpening,
  resolveWall,
  roomTagsOf,
  roomTitle,
  scale,
  sub,
  toWorld,
  type Vec2,
} from '@plinth/core'
import type { ReactNode } from 'react'
import { toggleIntersection } from '../actions.ts'
import { useAnalysis, useEditor, useEditorContext, useSnapshot } from '../context.ts'
import type { OpeningHandle } from '../interaction.ts'
import { LinkIcon, UnlinkIcon } from './icons.tsx'
import { isOutlineTool } from '../state.ts'

interface Label {
  key: string
  at: [number, number, number]
  className: string
  content: ReactNode
  /** Hidden when the camera is further away than this, in metres. */
  maxDistance?: number
}


/**
 * Text that belongs to points in the 3D view: room names and areas, and the
 * dimensions of what is being drawn. Plain DOM over the canvas; the
 * LabelProjector inside the canvas moves each label to its point every frame.
 */
export function Labels() {
  const ctx = useEditorContext()
  const snapshot = useSnapshot()
  const analysis = useAnalysis()
  const levelId = useEditor((s) => s.activeLevelId)
  const tool = useEditor((s) => s.tool)
  const anchor = useEditor((s) => s.anchor)
  const cursor = useEditor((s) => s.cursor)
  const dragging = useEditor((s) => s.dragging)
  const whole = useEditor((s) => s.wholeBuilding)
  const selection = useEditor((s) => s.selection)
  // Labels sit over everything, so only show room labels when they can't float over walls.
  const roomLabels = useEditor((s) => s.view === 'top' || !s.showLevelsAbove)
  const site = useEditor((s) => s.mode === 'site')
  const draft = useEditor((s) => s.draft)
  const defaults = useEditor((s) => s.siteDefaults)
  const level = snapshot.levels[levelId]
  const levelAnalysis = analysis.byLevel.get(levelId)

  if (site) {
    const labels: Label[] = []
    const height = defaults.floors * defaults.floorHeight + 0.4
    const dimension = (key: string, at: Vec2, text: string, z: number) =>
      labels.push({ key, at: toWorld(at, z), className: 'pe-dimension', content: text })
    if (anchor && cursor) {
      const to = cursor.point
      if ((tool === 'street' || isOutlineTool(tool)) && dist(anchor, to) > 0.05) {
        dimension(
          'length',
          midpoint(anchor, to),
          `${formatLength(dist(anchor, to))} · ${formatAngle(angleOf(sub(to, anchor)))}`,
          tool === 'street' ? 0.6 : height,
        )
      }
    }
    if (isOutlineTool(tool) && draft.length >= 3 && cursor && draft[0] && dist(cursor.point, draft[0]) < 1e-6) {
      dimension('close', draft[0], 'Close outline', height + 0.6)
    }
    return <LabelLayer labels={labels} />
  }

  if (!level) return null
  const labels: Label[] = []
  if (roomLabels && !whole && levelAnalysis) {
    const tags = roomTagsOf(snapshot, levelAnalysis)
    levelAnalysis.rooms.forEach((room, i) => {
      if (!room.labelPoint) return
      labels.push({
        key: `room:${room.id}`,
        at: toWorld(room.labelPoint, level.elevation + 0.05),
        className: 'pe-room-label',
        content: (
          <>
            <span>{roomTitle(i, tags[i])}</span>
            {formatArea(room.area)}
          </>
        ),
      })
    })
  }

  // Buttons over each place where walls meet, to join or separate them.
  if (tool === 'select' && !dragging && !whole && !level.masterId && levelAnalysis) {
    for (const intersection of levelAnalysis.intersections) {
      const tallest = Math.max(
        ...intersection.wallIds.map((id) => {
          const wall = snapshot.walls[id]
          if (!wall) return 0
          const { heightStart, heightEnd } = resolveWall(wall, level, snapshot.meta)
          return Math.max(heightStart, heightEnd)
        }),
      )
      const joined = intersection.kind === 'junction'
      labels.push({
        key: `x:${intersection.id}`,
        // On top of the walls where they meet.
        at: toWorld(intersection.point, level.elevation + tallest + 0.02),
        className: 'pe-junction',
        content: (
          <button
            type="button"
            data-joined={joined || undefined}
            title={joined ? 'Separate these walls' : 'Connect these walls'}
            aria-label={joined ? 'Separate these walls' : 'Connect these walls'}
            onClick={() => toggleIntersection(ctx, intersection)}
          >
            {joined ? <UnlinkIcon /> : <LinkIcon />}
          </button>
        ),
      })
    }
  }

  // Resize handles and a size readout on the one selected window or door.
  const onlyOpening =
    selection.openings.length === 1 && selection.walls.length + selection.nodes.length + selection.rooms.length === 0
      ? snapshot.openings[selection.openings[0]!]
      : undefined
  if (tool === 'select' && !whole && onlyOpening) {
    const wall = snapshot.walls[onlyOpening.wallId]
    const wallLevel = wall && snapshot.levels[wall.levelId]
    const wallAnalysis = wall && analysis.byLevel.get(wall.levelId)
    const footprint = wall && wallAnalysis?.footprints.get(wall.id)
    if (wall && wallLevel && wallAnalysis && footprint) {
      const lift = wallAnalysis.topOffsets.get(wall.id) ?? 0
      const { heightStart, heightEnd } = resolveWall(wall, wallLevel, snapshot.meta)
      const cut = placeOpening(footprint, onlyOpening, heightStart + lift, heightEnd + lift)
      if (cut) {
        const dir = normalize(sub(footprint.b, footprint.a))
        const at = (s: number, z: number) => toWorld(add(footprint.a, scale(dir, s)), wallLevel.elevation + z)
        const sMid = (cut.start + cut.end) / 2
        const zMid = (cut.sill + cut.head) / 2
        const handles: [OpeningHandle, number, number][] = [
          ['tl', cut.start, cut.head],
          ['t', sMid, cut.head],
          ['tr', cut.end, cut.head],
          ['r', cut.end, zMid],
          ['br', cut.end, cut.sill],
          ['b', sMid, cut.sill],
          ['bl', cut.start, cut.sill],
          ['l', cut.start, zMid],
        ]
        const isDoor = onlyOpening.kind === 'door'
        // A row is resized in the properties; its handles would only say which of its windows.
        const row = rowCount(onlyOpening)
        for (const [handle, s, z] of row > 1 ? [] : handles) {
          // A door stands on the floor, so its bottom edge can't be dragged.
          if (isDoor && handle.includes('b')) continue
          labels.push({
            key: `handle:${handle}`,
            at: at(s, z),
            className: 'pe-handle-wrap',
            content: (
              <span
                className="pe-handle"
                data-opening-handle=""
                data-opening-id={onlyOpening.id}
                data-handle={handle}
                data-corner={handle.length === 2 || undefined}
                title="Drag to resize"
              />
            ),
          })
        }
        const size =
          (row > 1 ? `${row} ${isDoor ? 'doors' : 'windows'}, ` : '') +
          `${formatLength(cut.end - cut.start)} × ${formatLength(cut.head - cut.sill)}`
        labels.push({
          key: 'opening-size',
          at: at(sMid, cut.head + 0.3),
          className: 'pe-dimension',
          content: isDoor ? size : `${size} · sill ${formatLength(cut.sill)}`,
        })
      }
    }
  }

  const top = level.elevation + level.height + 0.4
  const dimension = (key: string, at: Vec2, text: string) =>
    labels.push({ key, at: toWorld(at, top), className: 'pe-dimension', content: text })
  if (anchor && cursor) {
    const to = cursor.point
    if (tool === 'wall' && dist(anchor, to) > 0.005) {
      dimension('length', midpoint(anchor, to), `${formatLength(dist(anchor, to))} · ${formatAngle(angleOf(sub(to, anchor)))}`)
    }
  }

  return <LabelLayer labels={labels} />
}

function LabelLayer({ labels }: { labels: Label[] }) {
  return (
    <div className="pe-labels">
      {labels.map((label) => (
        <div
          key={label.key}
          className={`pe-label ${label.className}`}
          data-x={label.at[0]}
          data-y={label.at[1]}
          data-z={label.at[2]}
          data-max={label.maxDistance}
        >
          {label.content}
        </div>
      ))}
    </div>
  )
}
