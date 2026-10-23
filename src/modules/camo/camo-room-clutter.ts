/**
 * The clumps of small objects that make every room a place to disguise yourself in: the same few kinds repeated, so a
 * body that becomes one of them blends with its neighbours. Used by every room recipe right before `finish`.
 */
import type { ClutterDef } from './camo-room-kit';

export const CLUTTER: Readonly<Record<string, { defs: readonly ClutterDef[]; clumps: number; seed: number }>> = {
  locker_room: {
    seed: 7101,
    clumps: 14,
    defs: [
      { type: 'water-crate', w: 0.7, d: 0.5, h: 0.5, material: 'metal' },
      { type: 'bin', w: 0.55, d: 0.55, h: 0.85, material: 'metal' },
      { type: 'stool', w: 0.42, d: 0.42, h: 0.46, material: 'wood' },
      { type: 'bag', w: 0.6, d: 0.35, h: 0.4, material: 'cloth' },
      { type: 'cone', w: 0.32, d: 0.32, h: 0.5, material: 'cloth' },
    ],
  },
  warehouse: {
    seed: 7102,
    clumps: 22,
    defs: [
      { type: 'crate', w: 0.65, d: 0.65, h: 0.6, material: 'wood', weight: 1.3 },
      { type: 'carton', w: 0.7, d: 0.7, h: 0.7, material: 'wood', weight: 1.3 },
      { type: 'barrel', w: 0.62, d: 0.62, h: 0.95, material: 'metal' },
      { type: 'drum', w: 0.6, d: 0.6, h: 0.9, material: 'metal' },
      { type: 'sack', w: 0.7, d: 0.55, h: 0.55, material: 'cloth' },
      { type: 'bucket', w: 0.42, d: 0.42, h: 0.42, material: 'metal', weight: 0.7 },
    ],
  },
  five_a_side: {
    seed: 7103,
    clumps: 16,
    defs: [
      { type: 'barrel', w: 0.62, d: 0.62, h: 0.95, material: 'metal' },
      { type: 'cone', w: 0.32, d: 0.32, h: 0.5, material: 'cloth', weight: 1.2 },
      { type: 'plastic-chair', w: 0.5, d: 0.5, h: 0.85, material: 'wood', weight: 1.2 },
      { type: 'crate', w: 0.65, d: 0.65, h: 0.6, material: 'wood' },
      { type: 'bucket', w: 0.42, d: 0.42, h: 0.42, material: 'metal', weight: 0.7 },
    ],
  },
  ahwa: {
    seed: 7104,
    clumps: 14,
    defs: [
      { type: 'wicker-chair', w: 0.5, d: 0.5, h: 0.9, material: 'wood', weight: 1.5 },
      { type: 'stool', w: 0.42, d: 0.42, h: 0.46, material: 'wood' },
      { type: 'plant', w: 0.6, d: 0.6, h: 1.1, material: 'cloth' },
      { type: 'marble-table', w: 0.8, d: 0.8, h: 0.75, material: 'tile', weight: 0.8 },
    ],
  },
  ramadan_alley: {
    seed: 7105,
    clumps: 10,
    defs: [
      { type: 'carton', w: 0.7, d: 0.7, h: 0.7, material: 'wood' },
      { type: 'crate', w: 0.65, d: 0.65, h: 0.6, material: 'wood' },
      { type: 'sack', w: 0.7, d: 0.55, h: 0.55, material: 'cloth' },
      { type: 'plastic-chair', w: 0.5, d: 0.5, h: 0.85, material: 'wood' },
      { type: 'bucket', w: 0.42, d: 0.42, h: 0.42, material: 'metal', weight: 0.7 },
    ],
  },
};
