// Tiny strict JSON validator for model output (no dependencies).
// Rejects unknown keys, wrong types, out-of-range strings and enums.

export class SchemaError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.code = 'schema_invalid';
  }
}

export function validate(schema, value, path = '$') {
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SchemaError(path, 'expected object');
      const props = schema.properties || {};
      for (const key of Object.keys(value)) {
        if (!(key in props)) throw new SchemaError(path, `unexpected key ${key}`);
      }
      for (const key of schema.required || []) {
        if (!(key in value)) throw new SchemaError(path, `missing ${key}`);
      }
      const out = {};
      for (const [k, sub] of Object.entries(props)) {
        if (k in value) out[k] = validate(sub, value[k], `${path}.${k}`);
      }
      return out;
    }
    case 'array': {
      if (!Array.isArray(value)) throw new SchemaError(path, 'expected array');
      if (schema.maxItems != null && value.length > schema.maxItems) throw new SchemaError(path, 'too many items');
      if (schema.minItems != null && value.length < schema.minItems) throw new SchemaError(path, 'too few items');
      return value.map((v, i) => validate(schema.items, v, `${path}[${i}]`));
    }
    case 'string': {
      if (typeof value !== 'string') throw new SchemaError(path, 'expected string');
      if (schema.enum && !schema.enum.includes(value)) throw new SchemaError(path, 'not an allowed value');
      if (schema.maxLength != null && value.length > schema.maxLength) throw new SchemaError(path, 'too long');
      if (schema.minLength != null && value.length < schema.minLength) throw new SchemaError(path, 'too short');
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new SchemaError(path, 'pattern mismatch');
      return value;
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw new SchemaError(path, 'expected boolean');
      return value;
    case 'integer':
      if (!Number.isInteger(value)) throw new SchemaError(path, 'expected integer');
      if (schema.minimum != null && value < schema.minimum) throw new SchemaError(path, 'too small');
      if (schema.maximum != null && value > schema.maximum) throw new SchemaError(path, 'too large');
      return value;
    default:
      throw new SchemaError(path, 'unsupported schema');
  }
}

// Converts our schema to the JSON Schema sent to the model API.
export function toJsonSchema(schema) {
  const { type } = schema;
  if (type === 'object') {
    return {
      type: 'object',
      additionalProperties: false,
      required: schema.required || [],
      properties: Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toJsonSchema(v)])),
    };
  }
  if (type === 'array') return { type: 'array', items: toJsonSchema(schema.items) };
  if (type === 'string') return schema.enum ? { type: 'string', enum: schema.enum } : { type: 'string' };
  return { type };
}
