import type { SVGProps } from 'react'

/**
 * Every icon is drawn the same way: on a 20 px square, in 1.5 px lines with
 * round ends and corners, in the colour of the text around it. The CSS sets
 * the size (20 px in the dock, 16 px beside text).
 */
function Icon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      className={className ? `pe-icon ${className}` : 'pe-icon'}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    />
  )
}

export const SelectIcon = () => (
  <Icon>
    <path d="M5.5 3.5l9.5 6.2-4.3 1.1-2.4 4.7z" />
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
    <path d="M7 4.5L3.5 8 7 11.5" />
    <path d="M4 8h7.5a4.25 4.25 0 010 8.5H9" />
  </Icon>
)

export const RedoIcon = () => (
  <Icon>
    <path d="M13 4.5L16.5 8 13 11.5" />
    <path d="M16 8H8.5a4.25 4.25 0 000 8.5H11" />
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
    <path d="M10 2.75l6.5 3.6v7.3L10 17.25l-6.5-3.6v-7.3z" />
    <path d="M3.5 6.35L10 10l6.5-3.65M10 10v7.25" />
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
    <path d="M4 6h12M8 6V4h4v2M5.5 6l.75 10h7.5l.75-10" />
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

/** Points down while closed; the CSS turns it over when open (and not at all for reduced motion). */
export const ChevronIcon = ({ open }: { open: boolean }) => (
  <Icon className="pe-chevron" data-open={open || undefined}>
    <path d="M5 7.5l5 5 5-5" />
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
    <path d="M5 16.5V3.5h10v13M3 16.5h14" />
    <path d="M12.25 10.25v.5" />
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
    <circle cx="10" cy="10" r="2.25" />
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
    <path d="M3.5 6h7M15.5 6h1M3.5 14h1M8.5 14h8" />
    <circle cx="13" cy="6" r="2" />
    <circle cx="6.5" cy="14" r="2" />
  </Icon>
)

export const StreetIcon = () => (
  <Icon>
    <path d="M6 17L8 3M14 17L12 3" />
    <path d="M10 4.5v2M10 9v2M10 13.5v2" />
  </Icon>
)

export const OutlineIcon = () => (
  <Icon>
    <path d="M3.5 7.5L9 3.5l7.5 3v7l-6 3-7-2.5z" />
    <circle cx="3.5" cy="7.5" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="9" cy="3.5" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="16.5" cy="6.5" r="1.25" fill="currentColor" stroke="none" />
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
    <path d="M3 5.5l9-2.5 5 5-2 9-11-2z" strokeDasharray="2 2.25" />
    <circle cx="3" cy="5.5" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="12" cy="3" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="17" cy="8" r="1.25" fill="currentColor" stroke="none" />
  </Icon>
)

export const TerrainIcon = () => (
  <Icon>
    <path d="M2.5 15l4.5-6 3 3.5 3-5.5 4.5 8" />
    <path d="M2.5 17h15" />
  </Icon>
)

/** A turn to the left (anticlockwise), as seen from above. */
export const RotateLeftIcon = () => (
  <Icon>
    <path d="M4.5 10A5.5 5.5 0 1 0 10 4.5" />
    <path d="M12.25 2.25L10 4.5l2.25 2.25" />
  </Icon>
)

/** A turn to the right (clockwise), as seen from above. */
export const RotateRightIcon = () => (
  <Icon>
    <path d="M15.5 10A5.5 5.5 0 1 1 10 4.5" />
    <path d="M7.75 2.25L10 4.5l-2.25 2.25" />
  </Icon>
)

export const SearchIcon = () => (
  <Icon>
    <circle cx="8.75" cy="8.75" r="5.25" />
    <path d="M12.75 12.75L16.5 16.5" />
  </Icon>
)
