import { describe, expect, it } from "vitest";

import { decode, encode } from "../src/shared/codec.ts";

describe("codec", () => {
  it("keeps what structured clone keeps", () => {
    const value = {
      when: new Date("2030-01-01T00:00:00.000Z"),
      counts: new Map([["a", 1]]),
      tags: new Set(["x", "y"]),
      big: 12345678901234567890n,
      bytes: new Uint8Array([1, 2, 255]),
      missing: [undefined, null],
      infinite: Infinity,
      failure: new TypeError("bad"),
    };

    const decoded = decode(encode(value)) as typeof value;

    expect(decoded.when).toEqual(value.when);
    expect(decoded.counts).toEqual(value.counts);
    expect(decoded.tags).toEqual(value.tags);
    expect(decoded.big).toBe(value.big);
    expect([...decoded.bytes]).toEqual([1, 2, 255]);
    expect(decoded.missing).toEqual([undefined, null]);
    expect(decoded.infinite).toBe(Infinity);
    expect(decoded.failure).toBeInstanceOf(Error);
    expect(decoded.failure.message).toBe("bad");
    expect(decoded.failure.name).toBe("TypeError");
  });

  it("drops functions and undefined fields as structured clone would not carry them", () => {
    const decoded = decode(encode({ keep: 1, gone: undefined, run: () => 1 })) as Record<string, unknown>;

    expect(decoded).toEqual({ keep: 1 });
  });

  it("carries array buffers and plain values", () => {
    expect([...(decode(encode(new Uint8Array([9]).buffer)) as Uint8Array)]).toEqual([9]);
    expect(decode(encode("text"))).toBe("text");
    expect(decode(encode(undefined))).toBeUndefined();
    expect(decode(encode(NaN))).toBeNaN();
  });
});
