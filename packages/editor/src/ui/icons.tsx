import type { SVGProps } from 'react'

function Icon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  )
}

export const SelectIcon = () => (
  <Icon>
    <path d="M5 3.5l10 6-4.4 1.2L8.4 15z" />
  </Icon>
)

export const WallIcon = () => (
  <Icon>
    <path d="M3 13.5l4-3h10l-4 3z" />
    <path d="M3 13.5v3h10v-3M13 16.5l4-3v-3" />
  </Icon>
)

export const UndoIcon = () => (
  <Icon>
    <path d="M7 5L3.5 8.5 7 12" />
    <path d="M4 8.5h7.5a4.5 4.5 0 010 9H9" />
  </Icon>
)

export const RedoIcon = () => (
  <Icon>
    <path d="M13 5l3.5 3.5L13 12" />
    <path d="M16 8.5H8.5a4.5 4.5 0 000 9H11" />
  </Icon>
)

export const TopViewIcon = () => (
  <Icon>
    <rect x="3.5" y="3.5" width="13" height="13" rx="1" />
    <path d="M7 7h6v6H7z" />
  </Icon>
)

export const PerspectiveIcon = () => (
  <Icon>
    <path d="M10 2.8l6.5 3.6v7.2L10 17.2l-6.5-3.6V6.4z" />
    <path d="M3.5 6.4L10 10l6.5-3.6M10 10v7.2" />
  </Icon>
)

export const MagnetIcon = () => (
  <Icon>
    <path d="M5 3.5v6a5 5 0 0010 0v-6" />
    <path d="M5 6.5h3M12 6.5h3M8 3.5v6a2 2 0 004 0v-6" />
  </Icon>
)

export const TrashIcon = () => (
  <Icon>
    <path d="M4 6h12M8 6V4h4v2M5.5 6l.8 10h7.4l.8-10" />
  </Icon>
)

export const CheckIcon = () => (
  <Icon>
    <path d="M4 10.5l4 4 8-9" />
  </Icon>
)

export const RulerIcon = () => (
  <Icon>
    <path d="M2.5 13.5l11-11 4 4-11 11z" />
    <path d="M6 10l1.5 1.5M8.5 7.5L10 9M11 5l1.5 1.5" />
  </Icon>
)

export const ChevronIcon = ({ open }: { open: boolean }) => (
  <Icon style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 150ms' }}>
    <path d="M5 8l5 5 5-5" />
  </Icon>
)

export const WindowIcon = () => (
  <Icon>
    <rect x="4" y="3.5" width="12" height="13" rx="0.5" />
    <path d="M10 3.5v13M4 10h12" />
  </Icon>
)

export const DoorIcon = () => (
  <Icon>
    <path d="M5 17V3.5h10V17M3 17h14" />
    <circle cx="12.5" cy="10.5" r="0.6" fill="currentColor" />
  </Icon>
)

export const PlusIcon = () => (
  <Icon>
    <path d="M10 4.5v11M4.5 10h11" />
  </Icon>
)

export const MinusIcon = () => (
  <Icon>
    <path d="M4.5 10h11" />
  </Icon>
)

export const EyeIcon = ({ off = false }: { off?: boolean }) => (
  <Icon>
    <path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z" />
    <circle cx="10" cy="10" r="2.2" />
    {off && <path d="M3.5 16.5l13-13" />}
  </Icon>
)

export const LinkIcon = () => (
  <Icon>
    <path d="M8.5 11.5l3-3M7 9l-1.8 1.8a2.5 2.5 0 003.5 3.5L10.5 12.5M13 11l1.8-1.8a2.5 2.5 0 00-3.5-3.5L9.5 7.5" />
  </Icon>
)

export const LevelsIcon = () => (
  <Icon>
    <path d="M10 3l7 3.5-7 3.5-7-3.5z" />
    <path d="M3 10l7 3.5 7-3.5M3 13.5L10 17l7-3.5" />
  </Icon>
)

export const UnlinkIcon = () => (
  <Icon>
    <path d="M7 9l-1.8 1.8a2.5 2.5 0 003.5 3.5L10.5 12.5M13 11l1.8-1.8a2.5 2.5 0 00-3.5-3.5L9.5 7.5" />
    <path d="M4 4l2 2M16 16l-2-2" />
  </Icon>
)

export const SlidersIcon = () => (
  <Icon>
    <path d="M4 6h7M15 6h1M4 14h1M9 14h7" />
    <circle cx="13" cy="6" r="1.8" />
    <circle cx="7" cy="14" r="1.8" />
  </Icon>
)


export const StreetIcon = () => (
  <Icon>
    <path d="M6 17.5L8 2.5M14 17.5L12 2.5" />
    <path d="M10 4v2.5M10 9v2.5M10 14v2.5" />
  </Icon>
)

export const OutlineIcon = () => (
  <Icon>
    <path d="M3.5 7.5L9 3.5l7.5 3v7l-6 3-7-2.5z" />
    <circle cx="3.5" cy="7.5" r="1" fill="currentColor" />
    <circle cx="9" cy="3.5" r="1" fill="currentColor" />
    <circle cx="16.5" cy="6.5" r="1" fill="currentColor" />
  </Icon>
)

export const BackIcon = () => (
  <Icon>
    <path d="M12 4.5L6.5 10l5.5 5.5" />
  </Icon>
)

export const EnterIcon = () => (
  <Icon>
    <path d="M8 4.5l5.5 5.5L8 15.5" />
  </Icon>
)

export const ParcelIcon = () => (
  <Icon>
    <path d="M3 5.5l9-2.5 5 5-2 9-11-2z" strokeDasharray="2.2 2" />
    <circle cx="3" cy="5.5" r="1" fill="currentColor" />
    <circle cx="12" cy="3" r="1" fill="currentColor" />
    <circle cx="17" cy="8" r="1" fill="currentColor" />
  </Icon>
)

export const TerrainIcon = () => (
  <Icon>
    <path d="M2.5 15.5l4.5-6 3 3.5 3-5.5 4.5 8" />
    <path d="M2.5 17.5h15" />
  </Icon>
)
