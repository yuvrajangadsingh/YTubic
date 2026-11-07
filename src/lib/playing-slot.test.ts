import { describe, expect, it } from "vitest";
import { followSlot, type PlayingSlot } from "./playing-slot";

const a = { videoId: "a" };
const b = { videoId: "b" };
const start: PlayingSlot = { entry: a, index: 3, videoId: "a", id: 7 };

describe("followSlot", () => {
  it("keeps the slot when the playing entry only moves", () => {
    expect(followSlot(start, a, 2, "a").id).toBe(7);
    expect(followSlot(start, a, 5, "a").id).toBe(7);
  });

  it("keeps the slot when the queue is rebuilt around the same song", () => {
    expect(followSlot(start, { videoId: "a" }, 3, "a").id).toBe(7);
  });

  it("moves on for another track, or the same song in another slot", () => {
    expect(followSlot(start, b, 4, "b").id).toBe(8);
    expect(followSlot(start, b, 3, "b").id).toBe(8);
    expect(followSlot(start, { videoId: "a" }, 4, "a").id).toBe(8);
  });

  it("returns the same object when nothing changed", () => {
    expect(followSlot(start, a, 3, "a")).toBe(start);
  });
});
