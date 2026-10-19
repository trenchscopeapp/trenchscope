// Shared by hostile.test.ts (parallel) and serial/hostile-fuzz.test.ts (task-1424 serial lane): the names every
// plain object inherits, and the fuzz corpus built from them. Not a test file, so importing it runs no tests.

/** Names every plain object inherits; each one used to leak through `table[key]`. */
export const PROTO_NAMES = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__', '__lookupGetter__', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'];

export function hostileInputs(): string[] {
  const out: string[] = [];
  const tags = ['chain', 'launchpad', 'lp', 'flag', 'verified', 'sus', 'color', ...PROTO_NAMES];
  const vals = ['yes', 'no', 'pump', 'mint', 'clean', 'solana', '', ' ', ...PROTO_NAMES];
  for (const t of tags) for (const v of vals.slice(0, 8)) { out.push(`${t}:${v}`); out.push(`!${t}:${v}`); }
  for (const t of PROTO_NAMES) for (const v of PROTO_NAMES) out.push(`${t}:${v}`);
  const fields = ['vol24', 'liq', 'age', 'top10', 'price', 'holders', ...PROTO_NAMES];
  const nums = ['1', '-1', '0', '1e308', '1e309', '9'.repeat(400), '0.' + '0'.repeat(300) + '1', '1constructor', '1__proto__', '5toString', '1k', '1mo', 'NaN', 'Infinity', '-Infinity', '0x10', '1_000', '١٢٣', '１２３', '1,,,2', '$$$1', '%%', '1%%'];
  for (const f of fields) for (const n of nums) out.push(`${f} > ${n}`);
  for (const op of ['>', '>=', '<', '<=', '=', '==', '!=', '=>', '=<', '<>', '!', ':', '!!', '::', '!:', ':!']) out.push(`liq ${op} 1`, `${op}`, `${op}${op}${op}`);
  // unicode, bidi, zero-width, control, emoji, fullwidth, combining
  out.push('‮__proto__:yes', '​__proto__​:yes', 'vol24 > 1M', '﻿liq > 1', 'ＶＯＬ２４ ＞ １Ｍ', 'é́́́:yes', '🐱🐱🐱', '🐱 > 1', 'liq > 🐱', '\x00\x01\x02', '\x1b[2J\x1b[H', '\r\n\t', 'liq\n>\n1', 'ñandú', 'ß > 1', 'İ:yes', 'ǅ > 1', '\ud800', '\udfff', 'a\ud800b', '𝕍𝕆𝕃 > 1', '\u0000__proto__:yes');
  // huge and repeated
  out.push('x'.repeat(10_000), 'liq > 1 '.repeat(1_300), '__proto__:yes '.repeat(700), '!'.repeat(10_000), ':'.repeat(10_000), '>'.repeat(10_000), ' '.repeat(10_000), 'liq>'.repeat(2_500), ('9'.repeat(50) + ' ').repeat(200), '🐱'.repeat(5_000), 'vol24 > 1M liq > 50K age < 30d launchpad:pump !flag:mint cat '.repeat(160));
  // injection-shaped
  out.push('{"__proto__":{"x":1}}', "'; DROP TABLE rows; --", '${process.exit(1)}', '`id`', '$(id)', '%s%s%s%n', 'constructor.prototype.polluted', '__proto__.polluted', 'constructor:prototype', '__proto__[polluted]:yes', 'toString:valueOf', 'liq > 1 __proto__:yes constructor:true', 'launchpad:__proto__ flag:constructor');
  return [...new Set(out)];
}
