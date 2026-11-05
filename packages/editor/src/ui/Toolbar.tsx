import type { ReactNode } from 'react'
import { redo, setTool, toggleSnapping, toggleView, undo } from '../actions.ts'
import { useEditor, useEditorContext, useHistory } from '../context.ts'
import type { Tool } from '../state.ts'
import {
  DoorIcon,
  MagnetIcon,
  OutlineIcon,
  ParcelIcon,
  TerrainIcon,
  PerspectiveIcon,
  RedoIcon,
  SelectIcon,
  StreetIcon,
  TopViewIcon,
  UndoIcon,
  WallIcon,
  WindowIcon,
} from './icons.tsx'

interface ToolEntry {
  tool: Tool
  label: string
  shortcut: string
  icon: ReactNode
}

const SITE_TOOLS: ToolEntry[] = [
  { tool: 'select', label: 'Select', shortcut: 'V', icon: <SelectIcon /> },
  { tool: 'street', label: 'Street', shortcut: 'L', icon: <StreetIcon /> },
  { tool: 'outline', label: 'Building', shortcut: 'B', icon: <OutlineIcon /> },
  { tool: 'parcel', label: 'Parcel', shortcut: 'P', icon: <ParcelIcon /> },
  { tool: 'terrain', label: 'Terrain', shortcut: 'G', icon: <TerrainIcon /> },
]

const BUILDING_TOOLS: ToolEntry[] = [
  { tool: 'select', label: 'Select', shortcut: 'V', icon: <SelectIcon /> },
  { tool: 'wall', label: 'Wall', shortcut: 'W', icon: <WallIcon /> },
  { tool: 'window', label: 'Window', shortcut: 'O', icon: <WindowIcon /> },
  { tool: 'door', label: 'Door', shortcut: 'D', icon: <DoorIcon /> },
]

export function Toolbar() {
  const ctx = useEditorContext()
  const tool = useEditor((s) => s.tool)
  const view = useEditor((s) => s.view)
  const snapping = useEditor((s) => s.snap.enabled)
  const site = useEditor((s) => s.mode === 'site')
  const { canUndo, canRedo } = useHistory()

  return (
    <div className="pe-toolbar" role="toolbar" aria-label="Tools">
      {(site ? SITE_TOOLS : BUILDING_TOOLS).map((t) => (
        <ToolButton
          key={t.tool}
          label={t.label}
          shortcut={t.shortcut}
          active={tool === t.tool}
          onClick={() => setTool(ctx, t.tool)}
        >
          {t.icon}
        </ToolButton>
      ))}
      <div className="pe-toolbar-divider" />
      <ToolButton label="Undo" shortcut="⌘Z" disabled={!canUndo} onClick={() => undo(ctx)}>
        <UndoIcon />
      </ToolButton>
      <ToolButton label="Redo" shortcut="⇧⌘Z" disabled={!canRedo} onClick={() => redo(ctx)}>
        <RedoIcon />
      </ToolButton>
      <div className="pe-toolbar-divider" />
      <ToolButton
        label={view === 'top' ? '3D view' : 'Top view'}
        short={view === 'top' ? '3D' : 'Top'}
        shortcut="T"
        onClick={() => toggleView(ctx)}
      >
        {view === 'top' ? <PerspectiveIcon /> : <TopViewIcon />}
      </ToolButton>
      <ToolButton
        label={snapping ? 'Snapping on' : 'Snapping off'}
        short="Snap"
        shortcut="S"
        on={snapping}
        onClick={() => toggleSnapping(ctx)}
      >
        <MagnetIcon />
      </ToolButton>
    </div>
  )
}

function ToolButton({
  label,
  short,
  shortcut,
  active = false,
  on,
  disabled = false,
  onClick,
  children,
}: {
  label: string
  /** Shown under the icon, if shorter than the label. */
  short?: string
  shortcut: string
  /** The tool in use. */
  active?: boolean
  /** For a switch: whether it's on. */
  on?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="pe-tool"
      data-active={active || undefined}
      data-on={on || undefined}
      aria-pressed={on ?? active}
      aria-label={label}
      title={`${label} (${shortcut})`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
      <span className="pe-tool-label">{short ?? label}</span>
    </button>
  )
}
