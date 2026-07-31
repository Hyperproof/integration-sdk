import { safeMetric } from './safeMetric';

describe('safeMetric', () => {
  it('returns the result of a synchronous function', () => {
    expect(safeMetric(() => 42)).toBe(42);
  });

  it('returns undefined when a synchronous function throws', () => {
    expect(
      safeMetric(() => {
        throw new Error('boom');
      })
    ).toBeUndefined();
  });
});
