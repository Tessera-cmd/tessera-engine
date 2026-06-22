// src/data/rules.test.js
// Golden tests for the detachment merge resolvers. detachmentsByIds / detachmentForSelection merge N
// detachments into ONE detachment-shaped view the effects layer consumes unchanged — so an army can
// field more than one detachment and every rule-set applies. A single id is byte-identical.

import { describe, it, expect } from 'vitest';
import {
  DETACHMENTS_BY_ID,
  detachmentById,
  detachmentsByIds,
  detachmentForSelection,
} from './rules.js';

const A = 'ex-strikeforce'; // rule (Lethal Hits) + 2 stratagems + 1 enhancement
const B = 'ex-warhorde'; // rule (Sustained Hits) + 1 stratagem

describe('detachmentById', () => {
  it('resolves a known id and null for an unknown one', () => {
    expect(detachmentById(A)).toBe(DETACHMENTS_BY_ID[A]);
    expect(detachmentById('nope')).toBeNull();
  });
});

describe('detachmentsByIds', () => {
  it('returns null for nothing', () => {
    expect(detachmentsByIds([])).toBeNull();
    expect(detachmentsByIds(['nope'])).toBeNull();
    expect(detachmentsByIds(undefined)).toBeNull();
  });

  it('returns the SAME object unchanged for a single id (single-detachment is byte-identical)', () => {
    expect(detachmentsByIds([A])).toBe(DETACHMENTS_BY_ID[A]);
    expect(detachmentsByIds(A)).toBe(DETACHMENTS_BY_ID[A]); // also accepts a bare string
  });

  it('MERGES two detachments: union of rule effects, stratagems and enhancements', () => {
    const a = DETACHMENTS_BY_ID[A];
    const b = DETACHMENTS_BY_ID[B];
    const m = detachmentsByIds([A, B]);
    expect(m.name).toBe(`${a.name} + ${b.name}`);
    expect(m.rule.effects).toHaveLength((a.rule.effects?.length || 0) + (b.rule.effects?.length || 0));
    expect(m.stratagems).toHaveLength((a.stratagems?.length || 0) + (b.stratagems?.length || 0));
    expect(m.enhancements).toHaveLength((a.enhancements?.length || 0) + (b.enhancements?.length || 0));
  });

  it('skips an unknown id when merging', () => {
    const m = detachmentsByIds([A, 'gone', B]);
    expect(m.stratagems.map((s) => s.id)).toEqual([
      ...(DETACHMENTS_BY_ID[A].stratagems || []).map((s) => s.id),
      ...(DETACHMENTS_BY_ID[B].stratagems || []).map((s) => s.id),
    ]);
  });
});

describe('detachmentForSelection', () => {
  it('prefers detachmentIds (array) when present', () => {
    const m = detachmentForSelection({ detachmentIds: [A, B], detachmentId: A });
    expect(m.stratagems.length).toBe(
      (DETACHMENTS_BY_ID[A].stratagems?.length || 0) + (DETACHMENTS_BY_ID[B].stratagems?.length || 0),
    );
  });
  it('falls back to the single detachmentId (manual pickers)', () => {
    expect(detachmentForSelection({ detachmentId: B })).toBe(DETACHMENTS_BY_ID[B]);
  });
  it('returns null when neither is set', () => {
    expect(detachmentForSelection({})).toBeNull();
    expect(detachmentForSelection({ detachmentIds: [] })).toBeNull();
  });
});
