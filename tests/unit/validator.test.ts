import { describe, it, expect } from 'vitest';
import { validateTurtle, validateTurtleFile } from '../../src/lib/validator.js';

describe('validateTurtle', () => {
  it('returns valid result for correct Turtle', async () => {
    const turtle = `
      @prefix ex: <http://example.org/> .
      ex:Alice a ex:Person ;
              ex:name "Alice" .
    `;
    const result = await validateTurtle(turtle);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.tripleCount).toBe(2);
      expect(result.prefixes).toHaveProperty('ex');
    }
  });

  it('returns invalid result for malformed Turtle', async () => {
    const turtle = `This is not valid Turtle @@ syntax !!!`;
    const result = await validateTurtle(turtle);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBeTruthy();
    }
  });

  it('handles empty string (valid, zero triples)', async () => {
    const result = await validateTurtle('');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.tripleCount).toBe(0);
    }
  });
});

describe('validateTurtleFile', () => {
  it('returns error for non-existent file', async () => {
    const result = await validateTurtleFile('/tmp/nonexistent-file-abc123.ttl');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toMatch(/Could not read file/);
    }
  });
});
