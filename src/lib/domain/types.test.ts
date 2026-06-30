import { describe, expect, it } from 'vitest';
import { compareRouteShortName } from './types';

describe('compareRouteShortName', () => {
  it('orders pure-numeric names numerically (regression for 14 < 7 sort bug)', () => {
    const list = ['14', '24B', '1', '7', '25', '6', '9'];
    const sorted = [...list].sort(compareRouteShortName);
    expect(sorted).toEqual(['1', '6', '7', '9', '14', '24B', '25']);
  });

  it("groups numeric prefixes together: 24B before 25; 25N right after 25", () => {
    // Transit-natural ordering: a suffixed name slots in next to its
    // numeric sibling, not at the end of the alpha pile.
    const sorted = ['52L', '52', '52B', '25N', '25', '24B'].sort(compareRouteShortName);
    expect(sorted).toEqual(['24B', '25', '25N', '52', '52B', '52L']);
  });

  it('sorts a realistic Cluj catalog (mirrors the StationCard badge row)', () => {
    const list = [
      '1', '7', '9', '14', '19', '24B', '25', '25N', '29', '29S', '42',
      '52', '52B', '52L', '6', 'TE1', 'TE2', 'TE6', 'TE7',
    ];
    const sorted = [...list].sort(compareRouteShortName);
    expect(sorted).toEqual([
      '1', '6', '7', '9', '14', '19', '24B', '25', '25N', '29', '29S', '42',
      '52', '52B', '52L', 'TE1', 'TE2', 'TE6', 'TE7',
    ]);
  });

  it('handles purely-alpha names (TE1, TE7) by trailing number', () => {
    const sorted = ['TE7', 'TE1', 'TE2', 'TE6'].sort(compareRouteShortName);
    expect(sorted).toEqual(['TE1', 'TE2', 'TE6', 'TE7']);
  });
});
