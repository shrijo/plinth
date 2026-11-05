import { createId } from '../ids.ts'
import { cross, dist, dot, intersectLines, normalize, sub, type Vec2 } from '../math.ts'
import { DEFAULT_STREET, type Id, type Street, type StreetNode, type StreetProps } from '../model.ts'
import type { Tx } from '../tx.ts'
import { projectOnCurve, sampleCurve, splitCurve, type Curve } from '../geometry/curves.ts'

/**
 * The street network: streets between street points. Unlike walls, streets
 * join automatically wherever they meet: an end landing on a street splits
 * it, and crossing streets are split at the crossing and share a point.
 */

/** Street points closer than this (metres) are one point; ends this close to a street land on it. */
export const STREET_SNAP = 0.05
/** Streets shorter than this collapse into a point. */
const MIN_STREET_LENGTH = 0.5

export function curveOf(tx: Tx, street: Street): Curve {
  return { a: tx.requireStreetNode(street.a), b: tx.requireStreetNode(street.b), control: street.control }
}

/** The street point at `p`, created if there is none. */
export function streetNodeAt(tx: Tx, p: Vec2): StreetNode {
  let best: StreetNode | undefined
  let bestDistance = STREET_SNAP
  for (const node of tx.streetNodes()) {
    const d = dist(node, p)
    if (d < bestDistance) {
      best = node
      bestDistance = d
    }
  }
  return best ?? tx.putStreetNode({ id: createId(), x: p.x, y: p.y })
}

/**
 * Adds a street from p to q (curved through `control` if given). It joins
 * the network where it meets other streets, so it may end up as several
 * streets; their IDs are returned.
 */
export function insertStreet(
  tx: Tx,
  p: Vec2,
  q: Vec2,
  props: Partial<StreetProps> = {},
  control: Vec2 | null = null,
): Id[] {
  if (dist(p, q) < MIN_STREET_LENGTH) return []
  const a = streetNodeAt(tx, p)
  const b = streetNodeAt(tx, q)
  if (a.id === b.id) return []
  const street = tx.putStreet({ ...DEFAULT_STREET, ...props, id: createId(), a: a.id, b: b.id, control })
  return tidyStreets(tx, [street.id])
}

/** Splits a street at parameter t, at a new point or an existing one. */
export function splitStreet(tx: Tx, streetId: Id, t: number, existingNodeId?: Id): { nodeId: Id; second: Id } {
  const street = tx.requireStreet(streetId)
  const [first, second] = splitCurve(curveOf(tx, street), t)
  const node = existingNodeId ? tx.requireStreetNode(existingNodeId) : tx.putStreetNode({ id: createId(), ...first.b })
  tx.putStreet({ ...street, b: node.id, control: first.control, crosswalkB: false })
  const next = tx.putStreet({ ...street, id: createId(), a: node.id, control: second.control, crosswalkA: false })
  return { nodeId: node.id, second: next.id }
}

/** Moves every street from `removeId` onto `keepId` and deletes `removeId`. */
function mergeStreetNodes(tx: Tx, keepId: Id, removeId: Id): void {
  if (keepId === removeId) return
  for (const street of tx.streetsAtNode(removeId)) {
    const next = { ...street, a: street.a === removeId ? keepId : street.a, b: street.b === removeId ? keepId : street.b }
    if (next.a === next.b) tx.deleteStreet(street.id)
    else tx.putStreet(next)
  }
  tx.deleteStreetNode(removeId)
}

/**
 * Joins the network around the given streets: merges points that coincide,
 * splits streets where points land on them or where streets cross, removes
 * duplicates and collapses streets too short to keep. Returns the streets
 * the seeds became.
 */
export function tidyStreets(tx: Tx, seeds: Iterable<Id>): Id[] {
  const own = new Set(seeds)
  const queue = [...own]
  let guard = 0
  while (queue.length > 0) {
    if (++guard > 50_000) throw new Error('tidyStreets did not converge')
    const id = queue.pop()!
    const street = tx.street(id)
    if (!street) continue
    const a = tx.requireStreetNode(street.a)
    const b = tx.requireStreetNode(street.b)
    const samples = sampleCurve(curveOf(tx, street))

    if (dist(a, b) < MIN_STREET_LENGTH && !street.control) {
      mergeStreetNodes(tx, street.a, street.b)
      own.delete(id)
      queue.push(...tx.streetsAtNode(street.a).map((s) => s.id))
      continue
    }

    const duplicate = tx
      .streetsAtNode(street.a)
      .find((s) => s.id !== id && (s.a === street.b || s.b === street.b) && !s.control && !street.control)
    if (duplicate) {
      tx.deleteStreet(id)
      if (own.delete(id)) own.add(duplicate.id)
      continue
    }

    const nodes = tx.streetNodes()
    const coincident = [a, b]
      .map((end) => ({ end, other: nodes.find((n) => n.id !== end.id && dist(n, end) < STREET_SNAP) }))
      .find((m) => m.other)
    if (coincident?.other) {
      mergeStreetNodes(tx, coincident.other.id, coincident.end.id)
      queue.push(...tx.streetsAtNode(coincident.other.id).map((s) => s.id))
      continue
    }

    // A point lies on this street: split the street there.
    const length = sampleLength(samples)
    const onThis = nodes
      .filter((n) => n.id !== street.a && n.id !== street.b)
      .map((n) => ({ n, hit: projectOnCurve(samples, n) }))
      .find(({ hit }) => hit.distance < STREET_SNAP && hit.t * length > STREET_SNAP && (1 - hit.t) * length > STREET_SNAP)
    if (onThis) {
      const { second } = splitStreet(tx, id, onThis.hit.t, onThis.n.id)
      if (own.has(id)) own.add(second)
      queue.push(id, second)
      continue
    }

    let changed = false
    for (const other of tx.streets()) {
      if (other.id === id) continue
      const otherSamples = sampleCurve(curveOf(tx, other))
      // This street ends on the other: split the other there.
      const otherLength = sampleLength(otherSamples)
      const landing = [a, b]
        .filter((end) => end.id !== other.a && end.id !== other.b)
        .map((end) => ({ end, hit: projectOnCurve(otherSamples, end) }))
        .find(
          ({ hit }) =>
            hit.distance < STREET_SNAP && hit.t * otherLength > STREET_SNAP && (1 - hit.t) * otherLength > STREET_SNAP,
        )
      if (landing) {
        const { second } = splitStreet(tx, other.id, landing.hit.t, landing.end.id)
        if (own.has(other.id)) own.add(second)
        queue.push(id, other.id, second)
        changed = true
        break
      }
      const shares = other.a === street.a || other.a === street.b || other.b === street.a || other.b === street.b
      if (shares) continue
      const crossing = firstCrossing(samples, otherSamples)
      if (crossing) {
        const split = splitStreet(tx, id, crossing.t1)
        const otherSplit = splitStreet(tx, other.id, crossing.t2, split.nodeId)
        if (own.has(id)) own.add(split.second)
        if (own.has(other.id)) own.add(otherSplit.second)
        queue.push(id, split.second, other.id, otherSplit.second)
        changed = true
        break
      }
    }
    if (changed) continue
  }
  return [...own].filter((id) => tx.street(id))
}

function sampleLength(samples: readonly Vec2[]): number {
  let length = 0
  for (let i = 1; i < samples.length; i++) length += dist(samples[i - 1]!, samples[i]!)
  return length
}

/** Where two sampled curves first cross, strictly inside both, as parameters on each. */
function firstCrossing(p: readonly Vec2[], q: readonly Vec2[]): { t1: number; t2: number } | null {
  const n1 = p.length - 1
  const n2 = q.length - 1
  for (let i = 0; i < n1; i++) {
    for (let j = 0; j < n2; j++) {
      const a = p[i]!
      const b = p[i + 1]!
      const c = q[j]!
      const d = q[j + 1]!
      const hit = intersectLines(a, sub(b, a), c, sub(d, c))
      if (!hit || hit.t < 0 || hit.t > 1 || hit.u < 0 || hit.u > 1) continue
      const t1 = (i + hit.t) / n1
      const t2 = (j + hit.u) / n2
      const len1 = sampleLength(p)
      const len2 = sampleLength(q)
      if (t1 * len1 > STREET_SNAP && (1 - t1) * len1 > STREET_SNAP && t2 * len2 > STREET_SNAP && (1 - t2) * len2 > STREET_SNAP) {
        return { t1, t2 }
      }
    }
  }
  return null
}

/** Deletes streets, removing points left without streets and healing straight joins. */
export function deleteStreets(tx: Tx, ids: Iterable<Id>): void {
  const touched = new Set<Id>()
  for (const id of ids) {
    const street = tx.street(id)
    if (!street) continue
    tx.deleteStreet(id)
    touched.add(street.a)
    touched.add(street.b)
  }
  for (const nodeId of touched) cleanupStreetNode(tx, nodeId)
}

/** Deletes street points together with their streets. */
export function deleteStreetNodes(tx: Tx, ids: Iterable<Id>): void {
  const list = [...ids]
  deleteStreets(
    tx,
    list.flatMap((id) => tx.streetsAtNode(id).map((s) => s.id)),
  )
  for (const id of list) if (tx.streetNode(id)) tx.deleteStreetNode(id)
}

const LAYOUT = [
  'lanes',
  'laneWidth',
  'bikeLeft',
  'bikeRight',
  'parkingLeft',
  'parkingRight',
  'sidewalkLeft',
  'sidewalkRight',
] as const

function cleanupStreetNode(tx: Tx, nodeId: Id): void {
  if (!tx.streetNode(nodeId)) return
  const streets = tx.streetsAtNode(nodeId)
  if (streets.length === 0) {
    tx.deleteStreetNode(nodeId)
    return
  }
  if (streets.length !== 2) return
  // Two straight streets with the same layout that continue each other, running
  // the same way (so left stays left), become one.
  const [s1, s2] = streets as [Street, Street]
  if (s1.control || s2.control) return
  const sameWay = (s1.b === nodeId && s2.a === nodeId) || (s1.a === nodeId && s2.b === nodeId)
  if (!sameWay || !LAYOUT.every((key) => s1[key] === s2[key])) return
  const node = tx.requireStreetNode(nodeId)
  const far1 = tx.requireStreetNode(s1.a === nodeId ? s1.b : s1.a)
  const far2 = tx.requireStreetNode(s2.a === nodeId ? s2.b : s2.a)
  const d1 = normalize(sub(far1, node))
  const d2 = normalize(sub(far2, node))
  if (Math.abs(cross(d1, d2)) > 1e-6 || dot(d1, d2) > 0) return
  tx.putStreet({ ...s1, a: s1.a === nodeId ? far2.id : s1.a, b: s1.b === nodeId ? far2.id : s1.b })
  tx.deleteStreet(s2.id)
  tx.deleteStreetNode(nodeId)
}

export function moveStreetNodes(tx: Tx, positions: ReadonlyMap<Id, Vec2>): void {
  for (const [id, p] of positions) {
    const node = tx.streetNode(id)
    if (node) tx.putStreetNode({ ...node, x: p.x, y: p.y })
  }
}

/** Joins moved street points to whatever they now meet. */
export function finishStreetMove(tx: Tx, nodeIds: Iterable<Id>): void {
  const streets = new Set<Id>()
  for (const id of nodeIds) for (const street of tx.streetsAtNode(id)) streets.add(street.id)
  tidyStreets(tx, streets)
}

export function setStreetProps(tx: Tx, ids: Iterable<Id>, props: Partial<StreetProps>): void {
  for (const id of ids) {
    const street = tx.street(id)
    if (street) tx.putStreet({ ...street, ...props })
  }
}

/** Bends a street through a control point, or straightens it (null). */
export function setStreetCurve(tx: Tx, id: Id, control: Vec2 | null): void {
  const street = tx.street(id)
  if (street) tx.putStreet({ ...street, control })
}
