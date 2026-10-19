// Tier 1 (task-1345): the closed JSON-schema argument checker. Anything a schema does not mention is
// an error; prototype-pollution keys, unknown fields, over-long strings and over-deep nesting are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs, type JsonSchema } from '../src/schema.ts';

const objSchema: JsonSchema = {
  type: 'object',
  properties: {
    mint: { type: 'string', maxLength: 44 },
    top: { type: 'integer', minimum: 1, maximum: 50 },
    window: { type: 'string', enum: ['m5', 'h1'] },
  },
  required: ['mint'],
  additionalProperties: false,
};

test('accepts a valid object', () => {
  assert.equal(validateArgs(objSchema, { mint: 'So11111111111111111111111111111111111111112', top: 20, window: 'h1' }), null);
});

test('rejects unknown fields', () => {
  const err = validateArgs(objSchema, { mint: 'abc', evil: 1 });
  assert.match(err ?? '', /unknown field/);
});

test('rejects a missing required field', () => {
  assert.match(validateArgs(objSchema, { top: 3 }) ?? '', /required/);
});

test('rejects prototype-pollution keys', () => {
  for (const k of ['__proto__', 'constructor', 'prototype']) {
    const err = validateArgs(objSchema, JSON.parse(`{"mint":"a","${k}":{}}`));
    assert.match(err ?? '', /not allowed|unknown field/);
  }
});

test('enforces enum, integer, minimum, maximum', () => {
  assert.match(validateArgs(objSchema, { mint: 'a', window: 'h2' }) ?? '', /one of/);
  assert.match(validateArgs(objSchema, { mint: 'a', top: 0 }) ?? '', /below 1/);
  assert.match(validateArgs(objSchema, { mint: 'a', top: 51 }) ?? '', /above 50/);
  assert.match(validateArgs(objSchema, { mint: 'a', top: 3.5 }) ?? '', /integer/);
});

test('string maxLength and control chars', () => {
  assert.match(validateArgs({ type: 'string', maxLength: 4 }, 'toolong') ?? '', /longer than/);
  assert.match(validateArgs({ type: 'string' }, 'ab\u0007cd') ?? '', /control characters/);
});

test('string pattern', () => {
  const s: JsonSchema = { type: 'string', pattern: '^[a-z]+$' };
  assert.equal(validateArgs(s, 'abc'), null);
  assert.match(validateArgs(s, 'ABC') ?? '', /expected format/);
});

test('arrays with item schema and a cap', () => {
  const s: JsonSchema = { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: 3 };
  assert.equal(validateArgs(s, [1, 2, 3]), null);
  assert.match(validateArgs(s, [1, 2, 3, 4]) ?? '', /too many items/);
  assert.match(validateArgs(s, [1, -1]) ?? '', /below 0/);
});

test('undefined schema means "no arguments"', () => {
  assert.equal(validateArgs(undefined, {}), null);
  assert.equal(validateArgs(undefined, undefined), null);
  assert.match(validateArgs(undefined, { a: 1 }) ?? '', /takes no arguments/);
});

test('refuses excessive nesting depth', () => {
  let node: JsonSchema = { type: 'string' };
  let val: unknown = 'x';
  for (let i = 0; i < 8; i++) { node = { type: 'object', properties: { a: node }, additionalProperties: false }; val = { a: val }; }
  assert.match(validateArgs(node, val) ?? '', /too deeply nested/);
});

test('a type mismatch is caught, never thrown', () => {
  assert.match(validateArgs({ type: 'object', properties: {} }, 'nope') ?? '', /must be an object/);
  assert.match(validateArgs({ type: 'number' }, 'x') ?? '', /finite number/);
  assert.match(validateArgs({ type: 'number' }, Infinity) ?? '', /finite number/);
  assert.match(validateArgs({ type: 'boolean' }, 'x') ?? '', /true or false/);
});
