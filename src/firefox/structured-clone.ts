// SpiderMonkey's structured-clone format (js/src/vm/StructuredClone.cpp) as
// IndexedDB stores it. The buffer is a sequence of 8-byte little-endian pairs,
// data in the low 32 bits and a tag in the high 32. This reads the plain data a
// storage.local value is made of: objects, arrays, strings, numbers, booleans,
// null, undefined and repeated references to one object. Any other type throws,
// naming its tag.

const SCTAG_FLOAT_MAX = 0xfff00000;
const SCTAG_HEADER = 0xfff10000;
const SCTAG_NULL = 0xffff0000;
const SCTAG_UNDEFINED = 0xffff0001;
const SCTAG_BOOLEAN = 0xffff0002;
const SCTAG_INT32 = 0xffff0003;
const SCTAG_STRING = 0xffff0004;
const SCTAG_ARRAY_OBJECT = 0xffff0007;
const SCTAG_OBJECT_OBJECT = 0xffff0008;
const SCTAG_BACK_REFERENCE_OBJECT = 0xffff000d;
const SCTAG_END_OF_KEYS = 0xffff0013;

// Old IndexedDB clones carry scope 0; current ones SameProcess (1) through
// DifferentProcessForIndexedDB (3).
const MAX_SCOPE = 3;

const STRING_LENGTH_MASK = 0x3fffffff;
const STRING_LATIN1 = 0x80000000;
// The string's characters live in a buffer at a pointer, only valid in the
// process that wrote it.
const STRING_HAS_BUFFER = 0x40000000;

class CloneReader {
  private pos = 0;
  // Every object and array in the order it was first seen, which is what a
  // back-reference indexes.
  private readonly objects: object[] = [];

  constructor(private readonly buf: Buffer) {}

  read(): unknown {
    // Clones written before the header existed start straight with the value.
    if (this.buf.length >= 8 && this.buf.readUInt32LE(4) === SCTAG_HEADER) {
      const [, scope] = this.pair();
      if (scope > MAX_SCOPE) throw new Error(`Structured clone has an invalid scope (${scope})`);
    }
    return this.value();
  }

  /** The next pair, and the offset it started at. */
  private pair(): [tag: number, data: number, at: number] {
    const at = this.pos;
    if (at + 8 > this.buf.length) throw new Error("Structured clone is truncated");
    this.pos = at + 8;
    return [this.buf.readUInt32LE(at + 4), this.buf.readUInt32LE(at), at];
  }

  private value(): unknown {
    const [tag, data, at] = this.pair();
    // Doubles have no tag of their own: a pair whose high word is at most that of
    // -Infinity holds the bits of a double. NaN is always written in its
    // canonical form, which sits below that line.
    if (tag <= SCTAG_FLOAT_MAX) return this.buf.readDoubleLE(at);
    switch (tag) {
      case SCTAG_NULL:
        return null;
      case SCTAG_UNDEFINED:
        return undefined;
      case SCTAG_BOOLEAN:
        return data !== 0;
      case SCTAG_INT32:
        return data | 0;
      case SCTAG_STRING:
        return this.string(data);
      case SCTAG_ARRAY_OBJECT:
        return this.properties(new Array<unknown>(data));
      case SCTAG_OBJECT_OBJECT:
        return this.properties({});
      case SCTAG_BACK_REFERENCE_OBJECT: {
        const seen = this.objects[data];
        if (!seen) throw new Error(`Structured clone refers back to object ${data}, which hasn't been read`);
        return seen;
      }
      default:
        throw new Error(`Structured clone holds a type this reader doesn't decode (tag 0x${tag.toString(16)})`);
    }
  }

  private string(data: number): string {
    if (data & STRING_HAS_BUFFER) throw new Error("Structured clone holds a same-process string pointer");
    const latin1 = (data & STRING_LATIN1) !== 0;
    const bytes = (data & STRING_LENGTH_MASK) * (latin1 ? 1 : 2);
    const start = this.pos;
    // Characters are zero-padded to a whole pair.
    const end = start + Math.ceil(bytes / 8) * 8;
    if (end > this.buf.length) throw new Error("Structured clone is truncated");
    this.pos = end;
    return this.buf.toString(latin1 ? "latin1" : "utf16le", start, start + bytes);
  }

  // Key/value pairs up to END_OF_KEYS. Keys are strings, or INT32 for index-like
  // keys, on arrays and plain objects alike.
  private properties<T extends object>(target: T): T {
    this.objects.push(target);
    for (;;) {
      const [tag, data] = this.pair();
      // Old clones ended an object's properties with a null.
      if (tag === SCTAG_END_OF_KEYS || tag === SCTAG_NULL) return target;
      let key: string;
      if (tag === SCTAG_STRING) key = this.string(data);
      else if (tag === SCTAG_INT32) key = String(data | 0);
      else throw new Error(`Structured clone has a property key with tag 0x${tag.toString(16)}`);
      // Defined rather than assigned, so a key like "__proto__" stays an own property.
      Object.defineProperty(target, key, { value: this.value(), writable: true, enumerable: true, configurable: true });
    }
  }
}

/** Decode a SpiderMonkey structured-clone buffer, e.g. one IndexedDB value. */
export function readStructuredClone(buf: Buffer): unknown {
  return new CloneReader(buf).read();
}
