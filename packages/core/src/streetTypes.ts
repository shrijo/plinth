import type { StreetKind, StreetProps } from './model.ts'

/**
 * The street types with their usual cross-sections, after OpenStreetMap's
 * highway types, with the defaults OSM data is read by when a tag is
 * missing: lane counts per the wiki's assumptions for Key:lanes (two-way
 * roads 2, one-way 1, motorways and the halves of divided trunk roads 2),
 * widths from osm2lanes' defaults (a driving lane 3 m, narrower only on
 * minor streets, wider on fast roads; sidewalks 1.5–2 m by place).
 * Picking a type gives a street its lanes, lane width and sidewalks in
 * one go (each can still be changed). Widths in metres.
 */
export const STREET_TYPES: Record<StreetKind, { name: string; props: Omit<StreetProps, 'crosswalkA' | 'crosswalkB'> }> = {
  motorway: { name: 'Motorway', props: section('motorway', 2, 3.5, 0, 0, 0) },
  trunk: { name: 'Trunk road', props: section('trunk', 2, 3.5, 0, 0, 0) },
  primary: { name: 'Primary road', props: section('primary', 2, 3.25, 3, 0, 0) },
  secondary: { name: 'Secondary road', props: section('secondary', 2, 3.25, 2.5, 0, 0) },
  tertiary: { name: 'Tertiary road', props: section('tertiary', 2, 3, 2, 0, 0) },
  unclassified: { name: 'Minor road', props: section('unclassified', 2, 3, 1.5, 0, 0) },
  residential: { name: 'Residential street', props: section('residential', 2, 3, 1.8, 0, 0) },
  living_street: { name: 'Living street', props: section('living_street', 1, 5, 0, 0, 0) },
  pedestrian: { name: 'Pedestrian zone', props: section('pedestrian', 1, 6, 0, 0, 0) },
  service: { name: 'Service road', props: section('service', 1, 3, 0, 0, 0) },
}

function section(kind: StreetKind, lanes: number, laneWidth: number, sidewalk: number, bike: number, parking: number) {
  return {
    kind,
    oneway: false,
    lanes,
    laneWidth,
    bikeLeft: bike,
    bikeRight: bike,
    parkingLeft: parking,
    parkingRight: parking,
    sidewalkLeft: sidewalk,
    sidewalkRight: sidewalk,
  }
}
