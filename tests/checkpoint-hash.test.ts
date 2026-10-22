import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import { IncrementalCheckpointHash } from '../src/document/checkpointHash';

const reference = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encode = (text: string) => new TextEncoder().encode(text);

test.each([
  ['empty', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['multiblock', 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ['million a', 'a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
])('stream matches standard SHA-256 vector %s', (_name, text, expected) => {
  const hash = new IncrementalCheckpointHash();
  const bytes = encode(text);
  for (let offset = 0; offset < bytes.length; offset += 997) hash.update(bytes.subarray(offset, offset + 997));
  assert.equal(hash.digest(), expected);
  assert.equal(hash.digest(), expected);
  assert.throws(() => hash.update(new Uint8Array()), /closed/);
  hash.dispose();
  assert.throws(() => hash.digest(), /disposed/);
});

test('all padding boundaries and nonzero-offset chunk partitions match independent Node SHA-256', () => {
  for (const length of [0, 1, 7, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1023, 1048577]) {
    const parent = Uint8Array.from({ length: length + 17 }, (_, i) => (i * 131 + i * i) & 255);
    const bytes = parent.subarray(9, 9 + length);
    const expected = reference(bytes);
    for (const chunkSize of [1, 7, 55, 56, 63, 64, 65, 4093, 1048576]) {
      const hash = new IncrementalCheckpointHash();
      hash.update(new Uint8Array());
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        hash.update(bytes.subarray(offset, offset + chunkSize));
        hash.update(new Uint8Array());
      }
      assert.equal(hash.digest(), expected, `length=${length}, chunk=${chunkSize}`);
      hash.dispose();
    }
  }
});

test('chunk storage can be mutated or transferred immediately after synchronous update', () => {
  const hash = new IncrementalCheckpointHash();
  const first = encode('ab');
  hash.update(first);
  first.fill(0);
  structuredClone(first.buffer, { transfer: [first.buffer] });
  hash.update(encode('c'));
  assert.equal(hash.digest(), reference(encode('abc')));
});

test('intrinsic byte access ignores hostile shadow properties and iterators', () => {
  const input = encode('abc');
  const unexpected = () => { throw new Error('Untrusted input hook ran'); };
  Object.defineProperties(input, {
    buffer: { get: unexpected }, byteOffset: { get: unexpected }, byteLength: { get: unexpected },
    length: { get: unexpected }, subarray: { value: unexpected },
    [Symbol.iterator]: { value: unexpected },
  });
  const hash = new IncrementalCheckpointHash();
  hash.update(input);
  assert.equal(hash.digest(), reference(encode('abc')));
});

test('invalid, detached, shared and resizable inputs are refused without changing a live hash', () => {
  const detached = new Uint8Array(4);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  const invalid = [undefined, null, {}, [], new Int8Array(3), new Uint16Array(3),
    new DataView(new ArrayBuffer(3)), new Proxy(new Uint8Array(3), {}), detached,
    new Uint8Array(new SharedArrayBuffer(3)),
    new Uint8Array(Reflect.construct(ArrayBuffer, [3, { maxByteLength: 6 }]) as ArrayBuffer)];
  const hash = new IncrementalCheckpointHash();
  hash.update(encode('a'));
  for (const value of invalid) assert.throws(() => hash.update(value as Uint8Array), /fixed, attached/);
  hash.update(Buffer.from('bc'));
  assert.equal(hash.digest(), reference(encode('abc')));
});

test('disposal is idempotent and closes a partially populated stream', () => {
  const hash = new IncrementalCheckpointHash();
  hash.update(encode('private partial checkpoint'));
  hash.dispose(); hash.dispose();
  assert.throws(() => hash.digest(), /disposed/);
  assert.throws(() => hash.update(encode('more')), /closed/);
});
