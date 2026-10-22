// Independently implemented SHA-256 from NIST FIPS 180-4, sections 5 and 6.2:
// https://csrc.nist.gov/pubs/fips/180-4/upd1/final
// Keeps 352 bytes of typed-array workspace regardless of checkpoint length.
// This synchronous stream never retains the caller's bytes or needs a worker.
const ROUND = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const typedBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const bufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;

function borrowedBytes(input: Uint8Array): Uint8Array {
  // Intrinsic access ignores user-supplied properties, iterators and methods.
  // Shared/resizable/detached storage cannot provide a stable synchronous input.
  try {
    if (typedTag.call(input) !== 'Uint8Array') throw new Error();
    const buffer = typedBuffer.call(input) as ArrayBuffer;
    bufferLength.call(buffer); // Reject SharedArrayBuffer and impostors.
    if (bufferResizable?.call(buffer)) throw new Error();
    return new Uint8Array(buffer, typedOffset.call(input), typedLength.call(input));
  } catch { throw new TypeError('Checkpoint hashing requires fixed, attached Uint8Array storage.'); }
}
const rotate = (word: number, bits: number) => (word >>> bits) | (word << (32 - bits));

export class IncrementalCheckpointHash {
  #state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  #schedule = new Uint32Array(64);
  #pending = new Uint8Array(64);
  #pendingLength = 0;
  #length = 0;
  #hex: string | undefined;
  #disposed = false;

  update(input: Uint8Array): void {
    if (this.#disposed || this.#hex !== undefined) throw new Error('Checkpoint hash is closed.');
    const bytes = borrowedBytes(input);
    const length = this.#length + bytes.length;
    if (!Number.isSafeInteger(length)) throw new RangeError('Checkpoint hash length exceeds the safe byte range.');
    this.#length = length;
    let offset = 0;
    if (this.#pendingLength) {
      const count = Math.min(64 - this.#pendingLength, bytes.length);
      for (; offset < count; offset++) this.#pending[this.#pendingLength++] = bytes[offset];
      if (this.#pendingLength === 64) {
        this.#compress(this.#pending, 0);
        this.#pendingLength = 0;
      }
    }
    for (; offset + 64 <= bytes.length; offset += 64) this.#compress(bytes, offset);
    for (; offset < bytes.length; offset++) this.#pending[this.#pendingLength++] = bytes[offset];
  }

  digest(): string {
    if (this.#disposed) throw new Error('Checkpoint hash is disposed.');
    if (this.#hex !== undefined) return this.#hex;
    this.#pending[this.#pendingLength++] = 0x80;
    this.#pending.fill(0, this.#pendingLength);
    if (this.#pendingLength > 56) {
      this.#compress(this.#pending, 0);
      this.#pending.fill(0);
    }
    // Encode the exact 64-bit bit count without losing integer precision.
    const high = Math.floor(this.#length / 0x2000_0000);
    const low = (this.#length % 0x2000_0000) * 8;
    for (let byte = 0; byte < 4; byte++) {
      this.#pending[56 + byte] = high >>> (24 - byte * 8);
      this.#pending[60 + byte] = low >>> (24 - byte * 8);
    }
    this.#compress(this.#pending, 0);
    this.#hex = Array.from(this.#state, word => word.toString(16).padStart(8, '0')).join('');
    this.#clear();
    return this.#hex;
  }

  dispose(): void {
    this.#clear();
    this.#hex = undefined;
    this.#disposed = true;
  }

  #clear(): void {
    this.#state.fill(0);
    this.#schedule.fill(0);
    this.#pending.fill(0);
    this.#length = this.#pendingLength = 0;
  }

  #compress(bytes: Uint8Array, offset: number): void {
    const words = this.#schedule;
    for (let index = 0; index < 16; index++) {
      const start = offset + 4 * index;
      words[index] = (bytes[start] << 24) | (bytes[start + 1] << 16) | (bytes[start + 2] << 8) | bytes[start + 3];
    }
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15], b = words[index - 2];
      const sigma0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
      const sigma1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
      words[index] = words[index - 16] + sigma0 + words[index - 7] + sigma1;
    }
    const state = this.#state;
    let a = state[0], b = state[1], c = state[2], d = state[3];
    let e = state[4], f = state[5], g = state[6], h = state[7];
    for (let index = 0; index < 64; index++) {
      const sigma1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const first = (h + sigma1 + choose + ROUND[index] + words[index]) >>> 0;
      const sigma0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (sigma0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0;
      d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d;
    state[4] += e; state[5] += f; state[6] += g; state[7] += h;
  }
}
