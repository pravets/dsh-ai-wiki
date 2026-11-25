// Tool parameters are declared below as a flat per-property map: { name: { type, ... } }.
// DSH passes a tool's `parameters` to the provider verbatim, so the map must become a
// real JSON Schema before registration. A flat map puts a property named `type` at the
// root of the schema, where it collides with the `type` keyword; a service that
// validates the request body against the schema rejects the whole request.
//
// The rules below mirror @deepseek-ai/dsh-tools `parameterSchemaSpecToJsonSchema`, so
// the emitted schema is the same one `defineTool` would have produced.

const ANNOTATIONS = ['description', 'title', 'default', 'examples'];
const SCALARS = ['string', 'number', 'integer', 'boolean', 'null'];
const TYPES = new Set([...SCALARS, 'array', 'object', 'json']);
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function invalid(path, message) {
  return new TypeError(path + ': ' + message);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function assertKeys(declaration, path, allowed) {
  for (const key of Object.keys(declaration)) {
    if (!allowed.includes(key) && !ANNOTATIONS.includes(key)) {
      throw invalid(path + '.' + key, 'is not a supported keyword');
    }
  }
}

function copyAnnotations(source, target) {
  for (const key of ANNOTATIONS) {
    if (Object.hasOwn(source, key)) target[key] = source[key];
  }
}

// One value schema from one author declaration. `allowRequired` marks a node that is a
// map entry, where `required: true` is an author-only shortcut lifted into the parent.
function valueSchema(declaration, path, allowRequired, seen) {
  if (!isRecord(declaration)) throw invalid(path, 'must be a value schema object');
  if (seen.has(declaration)) throw invalid(path, 'is circular');
  seen.add(declaration);
  try {
    if (Object.hasOwn(declaration, 'required')) {
      if (!allowRequired) throw invalid(path + '.required', 'is only allowed on a property declaration');
      if (declaration.required !== true) throw invalid(path + '.required', 'must be true when present');
    }
    const node = {};
    if (Object.hasOwn(declaration, 'oneOf')) {
      assertKeys(declaration, path, allowRequired ? ['type', 'oneOf', 'required'] : ['type', 'oneOf']);
      if (Object.hasOwn(declaration, 'type')) throw invalid(path, 'cannot declare both type and oneOf');
      if (!Array.isArray(declaration.oneOf) || declaration.oneOf.length < 2) {
        throw invalid(path + '.oneOf', 'must be an array of at least two value schemas');
      }
      node.oneOf = declaration.oneOf.map((branch, index) => valueSchema(branch, path + '.oneOf[' + index + ']', false, seen));
      copyAnnotations(declaration, node);
      return node;
    }
    const type = Object.hasOwn(declaration, 'type') ? declaration.type : undefined;
    if (typeof type !== 'string' || !TYPES.has(type)) {
      throw invalid(path + '.type', 'must be string/number/integer/boolean/null/array/object/json, or use oneOf');
    }
    if (type === 'json') {
      // Author-only marker: the model may send any JSON value, so no constraint is sent.
      copyAnnotations(declaration, node);
      return node;
    }
    const allowed = SCALARS.includes(type) ? ['type', 'enum', 'const']
      : type === 'array' ? ['type', 'items']
        : ['type', 'properties', 'additionalProperties'];
    assertKeys(declaration, path, allowRequired ? [...allowed, 'required'] : allowed);
    node.type = type;
    copyAnnotations(declaration, node);
    if (SCALARS.includes(type)) {
      if (Object.hasOwn(declaration, 'enum')) {
        if (!Array.isArray(declaration.enum) || declaration.enum.length === 0) {
          throw invalid(path + '.enum', 'must be a non-empty array of scalar values');
        }
        for (const entry of declaration.enum) {
          if (!isScalar(entry)) throw invalid(path + '.enum', 'must contain only scalar values');
        }
        node.enum = [...declaration.enum];
      }
      if (Object.hasOwn(declaration, 'const')) {
        if (!isScalar(declaration.const)) throw invalid(path + '.const', 'must be a scalar value');
        node.const = declaration.const;
      }
      return node;
    }
    if (type === 'array') {
      if (Object.hasOwn(declaration, 'items')) {
        node.items = valueSchema(declaration.items, path + '.items', false, seen);
      }
      return node;
    }
    if (!Object.hasOwn(declaration, 'additionalProperties') || typeof declaration.additionalProperties !== 'boolean') {
      throw invalid(path + '.additionalProperties', 'must be explicitly true or false');
    }
    node.additionalProperties = declaration.additionalProperties;
    if (Object.hasOwn(declaration, 'properties')) {
      const nested = propertyMap(declaration.properties, path + '.properties', seen);
      node.properties = nested.properties;
      if (nested.required !== undefined) node.required = nested.required;
    }
    return node;
  } finally {
    seen.delete(declaration);
  }
}

// One property map: an implicit open object. Entries lift `required: true` into the
// map's own `required` list; an empty list is omitted rather than sent as `[]`.
function propertyMap(spec, path, seen) {
  if (!isRecord(spec)) throw invalid(path, 'must be an object of value schemas');
  if (seen.has(spec)) throw invalid(path, 'is circular');
  seen.add(spec);
  try {
    const properties = {};
    const required = [];
    for (const [name, declaration] of Object.entries(spec)) {
      if (RESERVED_NAMES.has(name)) throw invalid(path + '.' + name, 'is a reserved property name');
      if (isRecord(declaration) && declaration.required === true) required.push(name);
      const node = valueSchema(declaration, path + '.' + name, true, seen);
      Object.defineProperty(properties, name, { value: node, enumerable: true, configurable: true, writable: true });
    }
    return { properties, required: required.length > 0 ? required : undefined };
  } finally {
    seen.delete(spec);
  }
}

// Compile the flat author map into the root schema a model provider expects.
export function parameterSchema(spec) {
  if (!isRecord(spec)) throw invalid('parameters', 'must be an object of property declarations');
  const compiled = propertyMap(spec, 'parameters', new Set());
  const schema = { type: 'object', properties: compiled.properties };
  if (compiled.required !== undefined) schema.required = compiled.required;
  return schema;
}
