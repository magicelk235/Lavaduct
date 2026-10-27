// CityHash64 from Google's CityHash v1.0 (MIT licence), the version Firefox
// bundles in other-licenses/nsis/Contrib/CityHash. Firefox names each
// install's section in profiles.ini after this hash of the install directory,
// so the port has to match the C++ bit for bit, including its little-endian
// unaligned loads.

const MASK = 0xffffffffffffffffn;

const k0 = 0xc3a5c85c97cb3127n;
const k1 = 0xb492b66fbe98f273n;
const k2 = 0x9ae16a3b2f90404fn;
const k3 = 0xc949d7c7509e6557n;
const kMul = 0x9ddfea08eb382d69n;

const add = (a: bigint, b: bigint): bigint => (a + b) & MASK;
const sub = (a: bigint, b: bigint): bigint => (a - b) & MASK;
const mul = (a: bigint, b: bigint): bigint => (a * b) & MASK;

function rotate(val: bigint, shift: number): bigint {
  if (shift === 0) return val;
  const s = BigInt(shift);
  return ((val >> s) | (val << (64n - s))) & MASK;
}

const shiftMix = (val: bigint): bigint => val ^ (val >> 47n);

function hashLen16(u: bigint, v: bigint): bigint {
  let a = mul(u ^ v, kMul);
  a ^= a >> 47n;
  let b = mul(v ^ a, kMul);
  b ^= b >> 47n;
  return mul(b, kMul);
}

function hashLen0to16(s: Buffer, p: number, len: number): bigint {
  const n = BigInt(len);
  if (len > 8) {
    const a = s.readBigUInt64LE(p);
    const b = s.readBigUInt64LE(p + len - 8);
    return hashLen16(a, rotate(add(b, n), len)) ^ b;
  }
  if (len >= 4) {
    const a = BigInt(s.readUInt32LE(p));
    return hashLen16(add(n, a << 3n), BigInt(s.readUInt32LE(p + len - 4)));
  }
  if (len > 0) {
    const a = s[p];
    const b = s[p + (len >> 1)];
    const c = s[p + len - 1];
    const y = BigInt(a + (b << 8));
    const z = BigInt(len + (c << 2));
    return mul(shiftMix(mul(y, k2) ^ mul(z, k3)), k2);
  }
  return k2;
}

function hashLen17to32(s: Buffer, p: number, len: number): bigint {
  const a = mul(s.readBigUInt64LE(p), k1);
  const b = s.readBigUInt64LE(p + 8);
  const c = mul(s.readBigUInt64LE(p + len - 8), k2);
  const d = mul(s.readBigUInt64LE(p + len - 16), k0);
  return hashLen16(
    add(add(rotate(sub(a, b), 43), rotate(c, 30)), d),
    add(sub(add(a, rotate(b ^ k3, 20)), c), BigInt(len)),
  );
}

function weakHashLen32WithSeeds(s: Buffer, p: number, a: bigint, b: bigint): [bigint, bigint] {
  const w = s.readBigUInt64LE(p);
  const x = s.readBigUInt64LE(p + 8);
  const y = s.readBigUInt64LE(p + 16);
  const z = s.readBigUInt64LE(p + 24);
  a = add(a, w);
  b = rotate(add(add(b, a), z), 21);
  const c = a;
  a = add(a, x);
  a = add(a, y);
  b = add(b, rotate(a, 44));
  return [add(a, z), add(b, c)];
}

function hashLen33to64(s: Buffer, p: number, len: number): bigint {
  const at = (off: number): bigint => s.readBigUInt64LE(p + off);
  let z = at(24);
  let a = add(at(0), mul(add(BigInt(len), at(len - 16)), k0));
  let b = rotate(add(a, z), 52);
  let c = rotate(a, 37);
  a = add(a, at(8));
  c = add(c, rotate(a, 7));
  a = add(a, at(16));
  const vf = add(a, z);
  const vs = add(add(b, rotate(a, 31)), c);
  a = add(at(16), at(len - 32));
  z = at(len - 8);
  b = rotate(add(a, z), 52);
  c = rotate(a, 37);
  a = add(a, at(len - 24));
  c = add(c, rotate(a, 7));
  a = add(a, at(len - 16));
  const wf = add(a, z);
  const ws = add(add(b, rotate(a, 31)), c);
  const r = shiftMix(add(mul(add(vf, ws), k2), mul(add(wf, vs), k0)));
  return mul(shiftMix(add(mul(r, k0), vs)), k2);
}

/** CityHash64 (v1.0) of `data`, as an unsigned 64-bit value. */
export function cityHash64(data: Buffer): bigint {
  let len = data.length;
  if (len <= 32) return len <= 16 ? hashLen0to16(data, 0, len) : hashLen17to32(data, 0, len);
  if (len <= 64) return hashLen33to64(data, 0, len);

  // Over 64 bytes: hash the tail first, then walk 64-byte chunks keeping
  // 56 bytes of state in v, w, x, y and z.
  let p = 0;
  let x = data.readBigUInt64LE(0);
  let y = data.readBigUInt64LE(len - 16) ^ k1;
  let z = data.readBigUInt64LE(len - 56) ^ k0;
  let v = weakHashLen32WithSeeds(data, len - 64, BigInt(len), y);
  let w = weakHashLen32WithSeeds(data, len - 32, mul(BigInt(len), k1), k0);
  z = add(z, mul(shiftMix(v[1]), k1));
  x = mul(rotate(add(z, x), 39), k1);
  y = mul(rotate(y, 33), k1);

  len = (len - 1) & ~63;
  do {
    x = mul(rotate(add(add(add(x, y), v[0]), data.readBigUInt64LE(p + 16)), 37), k1);
    y = mul(rotate(add(add(y, v[1]), data.readBigUInt64LE(p + 48)), 42), k1);
    x ^= w[1];
    y ^= v[0];
    z = rotate(z ^ w[0], 33);
    v = weakHashLen32WithSeeds(data, p, mul(v[1], k1), add(x, w[0]));
    w = weakHashLen32WithSeeds(data, p + 32, add(z, w[1]), y);
    [z, x] = [x, z];
    p += 64;
    len -= 64;
  } while (len !== 0);
  return hashLen16(
    add(add(hashLen16(v[0], w[0]), mul(shiftMix(y), k1)), z),
    add(hashLen16(v[1], w[1]), x),
  );
}

/**
 * The key Firefox uses for an install in profiles.ini (`[Install<hash>]`) and
 * installs.ini: CityHash64 of the UTF-16LE path of the directory holding the
 * binary, as uppercase hex without zero padding.
 */
export function installHash(installDir: string): string {
  return cityHash64(Buffer.from(installDir, "utf16le")).toString(16).toUpperCase();
}
