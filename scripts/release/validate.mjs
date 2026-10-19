// Minimal JSON-schema validator for the subset scan-results.schema.json uses: type (incl. arrays of types),
// const, enum, required, properties, additionalProperties:false, items, minItems, minimum, pattern,
// format date-time / uri. Zero dependencies on purpose (the whole site build is dependency-free).
export function validate(value, schema, path = '$', errors = []) {
  const err = (m) => errors.push(`${path}: ${m}`);
  if ('const' in schema && value !== schema.const) err(`must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) err(`must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
    const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!ok) { err(`expected ${types.join('|')}, got ${actual}`); return errors; }
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) err(`does not match ${schema.pattern}`);
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) err('is not an RFC 3339 date-time');
    if (schema.format === 'uri') { try { new URL(value); } catch { err('is not a URI'); } }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) err(`must be >= ${schema.minimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) err(`needs at least ${schema.minItems} items`);
    if (schema.items) value.forEach((v, i) => validate(v, schema.items, `${path}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const r of schema.required || []) if (!(r in value)) err(`missing required "${r}"`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && k in schema.properties) validate(v, schema.properties[k], `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) err(`unexpected property "${k}"`);
    }
  }
  return errors;
}
