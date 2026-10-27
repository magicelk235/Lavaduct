// IndexedDB's binary key encoding (dom/indexedDB/Key.cpp), which is the form
// storage.local keys take in the object_data.key column.

const STRING_TYPE = 0x30;
const ONE_BYTE_LIMIT = 0x7e;
const TWO_BYTE_LIMIT = 0x3fff + 0x7f;

/** Encode a string key the way Firefox stores it. Works on UTF-16 code units, as Firefox does. */
export function encodeIdbStringKey(s: string): Buffer {
  const out = [STRING_TYPE];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= ONE_BYTE_LIMIT) {
      out.push(c + 1);
    } else if (c <= TWO_BYTE_LIMIT) {
      const v = c - 0x7f + 0x8000;
      out.push(v >> 8, v & 0xff);
    } else {
      const v = (c << 6) | 0xc00000;
      out.push(v >> 16, (v >> 8) & 0xff, v & 0xff);
    }
  }
  // The terminator is a zero byte, and Firefox trims every trailing zero off a
  // finished key, including any the last character ended with.
  let end = out.length;
  while (out[end - 1] === 0) end--;
  return Buffer.from(out.slice(0, end));
}
