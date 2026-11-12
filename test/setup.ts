/** Node lacks the Workers-only FixedLengthStream; this stand-in enforces the same byte-count contract. */
class FixedLengthStreamPolyfill extends TransformStream<Uint8Array, Uint8Array> {
  constructor(expectedLength: number) {
    let seen = 0;
    super({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > expectedLength) throw new TypeError("FixedLengthStream: too many bytes written");
        controller.enqueue(chunk);
      },
      flush() {
        if (seen !== expectedLength) throw new TypeError("FixedLengthStream: too few bytes written");
      },
    });
  }
}

const globals = globalThis as Record<string, unknown>;
if (!globals.FixedLengthStream) globals.FixedLengthStream = FixedLengthStreamPolyfill;
