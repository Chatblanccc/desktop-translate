import { Transform, type TransformCallback } from 'node:stream';

export const MAX_NATIVE_FRAME_BYTES = 1024 * 1024;

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_NATIVE_FRAME_BYTES) {
    throw new RangeError(`Native IPC frame exceeds ${MAX_NATIVE_FRAME_BYTES} bytes`);
  }

  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export class FrameDecoder extends Transform {
  private buffered = Buffer.alloc(0);
  private readonly utf8Decoder = new TextDecoder('utf-8', { fatal: true });

  public constructor() {
    super({ readableObjectMode: true });
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);

    try {
      while (this.buffered.length >= 4) {
        const length = this.buffered.readUInt32LE(0);
        if (length === 0 || length > MAX_NATIVE_FRAME_BYTES) {
          throw new RangeError(`Invalid Native IPC frame length: ${length}`);
        }
        if (this.buffered.length < 4 + length) {
          break;
        }

        const body = this.buffered.subarray(4, 4 + length);
        const json = this.utf8Decoder.decode(body);
        const value: unknown = JSON.parse(json);
        assertJsonComplexityAndUniqueKeys(json);
        this.push(value);
        this.buffered = this.buffered.subarray(4 + length);
      }
      if (this.buffered.length > MAX_NATIVE_FRAME_BYTES + 4) {
        throw new RangeError('Native IPC decoder buffer exceeded its limit');
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  public override _flush(callback: TransformCallback): void {
    if (this.buffered.length !== 0) {
      callback(new SyntaxError('Native IPC stream ended with a truncated frame'));
      return;
    }
    callback();
  }
}

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 65_536;

function assertJsonComplexityAndUniqueKeys(json: string): void {
  let index = 0;
  let nodes = 0;

  const skipWhitespace = (): void => {
    while (index < json.length && /\s/u.test(json[index]!)) index += 1;
  };

  const readString = (): string => {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < json.length) {
      const character = json[index]!;
      index += 1;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        return JSON.parse(json.slice(start, index)) as string;
      }
    }
    throw new SyntaxError('Unterminated JSON string');
  };

  const parseValue = (depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new RangeError('Native IPC JSON contains too many nodes');
    if (depth > MAX_JSON_DEPTH) throw new RangeError('Native IPC JSON nesting is too deep');
    skipWhitespace();
    const character = json[index];

    if (character === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (json[index] === '}') {
        index += 1;
        return;
      }
      while (index < json.length) {
        skipWhitespace();
        if (json[index] !== '"') throw new SyntaxError('Expected JSON object key');
        const key = readString();
        if (keys.has(key)) throw new SyntaxError('Duplicate JSON object key');
        keys.add(key);
        skipWhitespace();
        if (json[index] !== ':') throw new SyntaxError('Expected colon after JSON object key');
        index += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (json[index] === '}') {
          index += 1;
          return;
        }
        if (json[index] !== ',') throw new SyntaxError('Expected comma in JSON object');
        index += 1;
      }
      throw new SyntaxError('Unterminated JSON object');
    }

    if (character === '[') {
      index += 1;
      skipWhitespace();
      if (json[index] === ']') {
        index += 1;
        return;
      }
      while (index < json.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (json[index] === ']') {
          index += 1;
          return;
        }
        if (json[index] !== ',') throw new SyntaxError('Expected comma in JSON array');
        index += 1;
      }
      throw new SyntaxError('Unterminated JSON array');
    }

    if (character === '"') {
      readString();
      return;
    }

    const scalar = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(
      json.slice(index)
    );
    if (!scalar) throw new SyntaxError('Invalid JSON scalar');
    index += scalar[0].length;
  };

  parseValue(0);
  skipWhitespace();
  if (index !== json.length) throw new SyntaxError('Unexpected trailing JSON content');
}
