import { describe, it, expect } from 'vitest';
import { assertTripleLimit, MAX_TRIPLES_PER_PUSH } from '../../src/lib/persist.js';

describe('assertTripleLimit', () => {
  it('allows triples within the limit', () => {
    expect(() => assertTripleLimit(1)).not.toThrow();
    expect(() => assertTripleLimit(50)).not.toThrow();
    expect(() => assertTripleLimit(MAX_TRIPLES_PER_PUSH)).not.toThrow();
  });

  it('rejects triples exceeding the limit', () => {
    expect(() => assertTripleLimit(MAX_TRIPLES_PER_PUSH + 1)).toThrow(
      /Too many triples/
    );
    expect(() => assertTripleLimit(500)).toThrow(
      /Split your data into smaller batches/
    );
  });

  it('includes the count in the error message', () => {
    expect(() => assertTripleLimit(150)).toThrow('Too many triples (150)');
  });

  it('MAX_TRIPLES_PER_PUSH is 100', () => {
    expect(MAX_TRIPLES_PER_PUSH).toBe(100);
  });
});
