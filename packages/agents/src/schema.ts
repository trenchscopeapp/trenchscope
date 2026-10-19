// @dexterm/agents — a small, total JSON-schema checker for tool arguments (task-1345).
//
// Covers the subset the trenchscope tool table uses: object/string/integer/number/boolean, enum, minimum,
// maximum, maxLength, required, additionalProperties:false, nested objects. Anything the schema does
// not mention is an error (schemas are closed: `additionalProperties` defaults to false for agent
// calls even when a schema omits it). Pure and never throws.

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  enum?: readonly unknown[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  items?: JsonSchema;
  maxItems?: number;
  description?: string;
}

const MAX_STRING = 2000;
const MAX_DEPTH = 6;
const MAX_KEYS = 32;

export function validateArgs(schema: JsonSchema | undefined, value: unknown, path = 'args', depth = 0): string | null {
  if (depth > MAX_DEPTH) return `${path}: too deeply nested`;
  if (!schema) return value === undefined || (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0) ? null : `${path}: this tool takes no arguments`;
  const t = schema.type ?? (schema.properties ? 'object' : undefined);
  if (schema.enum && !schema.enum.includes(value)) return `${path}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`;
  switch (t) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path}: must be an object`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.length > MAX_KEYS) return `${path}: too many fields`;
      const props = schema.properties ?? {};
      for (const k of keys) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') return `${path}.${k}: not allowed`;
        if (!Object.hasOwn(props, k)) return `${path}.${k}: unknown field`;
      }
      for (const r of schema.required ?? []) if (!Object.hasOwn(obj, r) || obj[r] === undefined) return `${path}.${r}: required`;
      for (const k of keys) { const err = validateArgs(props[k], obj[k], `${path}.${k}`, depth + 1); if (err) return err; }
      return null;
    }
    case 'string': {
      if (typeof value !== 'string') return `${path}: must be a string`;
      const max = Math.min(schema.maxLength ?? MAX_STRING, MAX_STRING);
      if (value.length > max) return `${path}: longer than ${max} characters`;
      if (schema.minLength !== undefined && value.length < schema.minLength) return `${path}: shorter than ${schema.minLength} characters`;
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path}: does not match the expected format`;
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) return `${path}: control characters are not allowed`;
      return null;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${path}: must be a finite number`;
      if (t === 'integer' && !Number.isInteger(value)) return `${path}: must be an integer`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${path}: below ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${path}: above ${schema.maximum}`;
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path}: must be true or false`;
    case 'array': {
      if (!Array.isArray(value)) return `${path}: must be an array`;
      if (value.length > (schema.maxItems ?? 64)) return `${path}: too many items`;
      for (let i = 0; i < value.length; i++) { const err = validateArgs(schema.items ?? {}, value[i], `${path}[${i}]`, depth + 1); if (err) return err; }
      return null;
    }
    default:
      return value === undefined ? null : `${path}: unexpected value`;
  }
}
