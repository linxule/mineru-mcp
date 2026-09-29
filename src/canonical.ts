/** Strict portable hashing for new artifact receipts; never legacy hashers. */
import { createHash } from 'node:crypto';

export const HASH_PROFILE = 'scholia.canonical-json.v1';
export const MAX_SAFE_INTEGER = 9007199254740991;
export const MAX_DECIMAL_CHARS = 100_000;
export const MAX_DEPTH = 128;
export class CanonicalJSONError extends Error {}
/** Decimal lexeme, retained without a binary-floating-point round trip. */
export class ExactDecimal {
  constructor(readonly value: string) {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
      throw new CanonicalJSONError('Invalid decimal lexeme');
    }
  }
}
function scalarString(value: string): string {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new CanonicalJSONError('Unpaired Unicode surrogate');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new CanonicalJSONError('Unpaired Unicode surrogate');
  }
  return value;
}
/** Compare code points, not JavaScript's default UTF-16 code units. */
export function compareUnicodeScalars(a: string, b: string): number {
  const aa = Array.from(a, c => c.codePointAt(0)!);
  const bb = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  }
  return aa.length - bb.length;
}

/** Duplicate-aware parser preserving every number's exact decimal value. */
export function strictLoads(input: string | Uint8Array): unknown {
  let text: string;
  try { text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); }
  catch { throw new CanonicalJSONError('Invalid UTF-8'); }
  let pos = 0;
  const fail = (): never => { throw new CanonicalJSONError(`Invalid JSON at offset ${pos}`); };
  const space = () => { while (pos < text.length && /[ \t\r\n]/.test(text[pos])) pos++; };
  const string = (): string => {
    const start = pos++;
    while (pos < text.length) {
      const char = text[pos++];
      if (char === '"') {
        try { return scalarString(JSON.parse(text.slice(start, pos))); }
        catch (error) { if (error instanceof CanonicalJSONError) throw error; return fail(); }
      }
      if (char === '\\') pos++;
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > MAX_DEPTH) throw new CanonicalJSONError('JSON nesting limit exceeded');
    space();
    if (text[pos] === '"') return string();
    if (text[pos] === '{') {
      pos++; space();
      const result: Record<string, unknown> = Object.create(null);
      if (text[pos] === '}') { pos++; return result; }
      while (true) {
        space(); if (text[pos] !== '"') return fail();
        const key = string(); space();
        if (Object.hasOwn(result, key)) throw new CanonicalJSONError(`Duplicate object key: ${key}`);
        if (text[pos++] !== ':') return fail();
        result[key] = value(depth + 1); space();
        if (text[pos] === '}') { pos++; return result; }
        if (text[pos++] !== ',') return fail();
      }
    }
    if (text[pos] === '[') {
      pos++; space();
      const result: unknown[] = [];
      if (text[pos] === ']') { pos++; return result; }
      while (true) {
        result.push(value(depth + 1)); space();
        if (text[pos] === ']') { pos++; return result; }
        if (text[pos++] !== ',') return fail();
      }
    }
    for (const [word, result] of [['null', null], ['true', true], ['false', false]] as const) {
      if (text.startsWith(word, pos)) { pos += word.length; return result; }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(pos));
    if (!match) return fail();
    pos += match[0].length;
    if (!/[.eE]/.test(match[0])) {
      const number = Number(match[0]);
      if (Number.isSafeInteger(number)) return number === 0 ? 0 : number;
    }
    return new ExactDecimal(match[0]);
  };
  const result = value(0); space();
  if (pos !== text.length) return fail();
  return result;
}

function decimal(value: ExactDecimal): unknown {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value.value)!;
  let digits = (match[2] + (match[3] ?? '')).replace(/^0+/, '');
  if (!digits) return 0;
  let exponent = BigInt(match[4] ?? '0') - BigInt((match[3] ?? '').length);
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); exponent++; }
  const point = BigInt(digits.length) + exponent;
  const length = exponent >= 0n ? point : (BigInt(digits.length + 1) > 2n - exponent ? BigInt(digits.length + 1) : 2n - exponent);
  if (length > MAX_DECIMAL_CHARS) throw new CanonicalJSONError('Fixed decimal representation exceeds local limit');
  let fixed: string;
  if (exponent >= 0n) fixed = digits + '0'.repeat(Number(exponent));
  else if (point > 0n) fixed = digits.slice(0, Number(point)) + '.' + digits.slice(Number(point));
  else fixed = '0.' + '0'.repeat(Number(-point)) + digits;
  fixed = match[1] + fixed;
  if (!fixed.includes('.')) {
    const number = Number(fixed);
    if (Number.isSafeInteger(number)) return number;
  }
  return { '$scholia.type': 'decimal', '$scholia.value': fixed };
}
function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
export function normalizeHashInput(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new CanonicalJSONError('JSON nesting limit exceeded');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return scalarString(value);
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return value === 0 ? 0 : value;
    throw new CanonicalJSONError('Use ExactDecimal or strictLoads for noninteger/unsafe numbers');
  }
  if (value instanceof ExactDecimal) return decimal(value);
  if (Array.isArray(value)) return Array.from(value, child => normalizeHashInput(child, depth + 1));
  if (plainObject(value)) {
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) {
      scalarString(key);
      if (key.startsWith('$scholia.')) throw new CanonicalJSONError('Reserved $scholia. key prefix in caller input');
      result[key] = normalizeHashInput(value[key], depth + 1);
    }
    if (Object.getOwnPropertySymbols(value).length) throw new CanonicalJSONError('Symbol object keys are not JSON');
    return result;
  }
  throw new CanonicalJSONError('Unsupported JSON value');
}

function serializeNormalized(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new CanonicalJSONError('JSON nesting limit exceeded');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(scalarString(value));
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value === 0 ? 0 : value);
  if (Array.isArray(value)) return '[' + Array.from(value, child => serializeNormalized(child, depth + 1)).join(',') + ']';
  if (plainObject(value)) {
    const keys = Object.keys(value).map(scalarString).sort(compareUnicodeScalars);
    if (Object.getOwnPropertySymbols(value).length) throw new CanonicalJSONError('Symbol object keys are not JSON');
    if (keys.some(key => key.startsWith('$scholia.'))) {
      if (keys.length !== 2 || value['$scholia.type'] !== 'decimal' || typeof value['$scholia.value'] !== 'string') {
        throw new CanonicalJSONError('Invalid normalized decimal tag');
      }
      const normalized = decimal(new ExactDecimal(value['$scholia.value']));
      if (!plainObject(normalized) || normalized['$scholia.value'] !== value['$scholia.value']) {
        throw new CanonicalJSONError('Noncanonical normalized decimal');
      }
    }
    // Manual emission is required: JSON.stringify reorders integer-like keys.
    return '{' + keys.map(key => JSON.stringify(key) + ':' + serializeNormalized(value[key], depth + 1)).join(',') + '}';
  }
  throw new CanonicalJSONError('Normalized values must contain only safe integers and decimal tags');
}
export function canonicalNormalizedBytes(value: unknown): Buffer {
  return Buffer.from(serializeNormalized(value), 'utf-8');
}
export function canonicalBytes(value: unknown): Buffer {
  return canonicalNormalizedBytes(normalizeHashInput(value));
}
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalBytes(value)).digest('hex');
}
