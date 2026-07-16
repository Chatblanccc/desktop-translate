import { describe, expect, it } from 'vitest';
import { FrameDecoder, MAX_NATIVE_FRAME_BYTES, encodeFrame } from './frame-codec.js';

async function decode(chunks: Buffer[]): Promise<unknown[]> {
  const decoder = new FrameDecoder();
  const messages: unknown[] = [];
  decoder.on('data', (message) => messages.push(message));
  for (const chunk of chunks) decoder.write(chunk);
  decoder.end();
  await new Promise<void>((resolve, reject) => {
    decoder.once('finish', resolve);
    decoder.once('error', reject);
  });
  return messages;
}

describe('native frame codec', () => {
  it('decodes a fragmented frame', async () => {
    const frame = encodeFrame({ v: 1, method: 'health' });
    await expect(decode([frame.subarray(0, 2), frame.subarray(2, 7), frame.subarray(7)])).resolves.toEqual([
      { v: 1, method: 'health' }
    ]);
  });

  it('decodes multiple frames from one chunk', async () => {
    const chunk = Buffer.concat([encodeFrame({ id: 1 }), encodeFrame({ id: 2 })]);
    await expect(decode([chunk])).resolves.toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('accepts empty containers, escaped strings, arrays, and every JSON scalar form', async () => {
    const value = {
      emptyObject: {},
      emptyArray: [],
      values: [true, false, null, -1, 1.5, 1e2],
      text: 'escaped\\value'
    };
    await expect(decode([encodeFrame(value)])).resolves.toEqual([value]);
  });

  it('rejects zero and oversized incoming frame lengths', async () => {
    const zero = Buffer.alloc(4);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(MAX_NATIVE_FRAME_BYTES + 1, 0);
    await expect(decode([zero])).rejects.toThrow(/frame length/u);
    await expect(decode([oversized])).rejects.toThrow(/frame length/u);
  });

  it('rejects JSON documents with too many nodes', async () => {
    const body = Buffer.from(`[${'0,'.repeat(65_536)}0]`, 'utf8');
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    await expect(decode([frame])).rejects.toThrow(/too many nodes/u);
  });

  it('rejects oversized outgoing frames', () => {
    expect(() => encodeFrame({ value: 'x'.repeat(MAX_NATIVE_FRAME_BYTES) })).toThrow(RangeError);
  });

  it('rejects truncated frames', async () => {
    const frame = encodeFrame({ ok: true });
    await expect(decode([frame.subarray(0, frame.length - 1)])).rejects.toThrow('truncated frame');
  });

  it('rejects malformed UTF-8', async () => {
    const frame = Buffer.from([2, 0, 0, 0, 0xc3, 0x28]);
    await expect(decode([frame])).rejects.toThrow();
  });

  it('rejects duplicate object keys, including escaped equivalents', async () => {
    const body = Buffer.from('{"id":1,"\\u0069d":2}', 'utf8');
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    await expect(decode([frame])).rejects.toThrow('Duplicate JSON object key');
  });

  it('rejects excessive JSON nesting', async () => {
    const body = Buffer.from(`${'['.repeat(34)}0${']'.repeat(34)}`, 'utf8');
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    await expect(decode([frame])).rejects.toThrow('nesting is too deep');
  });
});
