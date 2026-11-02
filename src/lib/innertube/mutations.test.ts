import { describe, expect, it, vi } from "vitest";

// mutations.ts reaches shared.ts, which imports the Tauri HTTP plugin and
// `invoke` at module load; stub both so the pure helper can be imported.
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => Promise.reject(new Error("no tauri in tests")),
}));

const { isDuplicateRefusal } = await import("./mutations");

// The nesting below follows YouTube Music's "already in the playlist"
// dialog as far as it is known; the walker does not depend on it, only
// on the retry action itself, so a captured response can differ in
// shape without breaking this.
function refusal(addedVideoId: string) {
  return {
    status: "STATUS_FAILED",
    actions: [
      {
        confirmDialogEndpoint: {
          content: {
            confirmDialogRenderer: {
              dialogMessages: [{ runs: [{ text: "already in the playlist" }] }],
              confirmButton: {
                buttonRenderer: {
                  command: {
                    playlistEditEndpoint: {
                      playlistId: "PLx",
                      actions: [
                        {
                          action: "ACTION_ADD_VIDEO",
                          addedVideoId,
                          dedupeOption: "DEDUPE_OPTION_SKIP",
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
  };
}

describe("isDuplicateRefusal", () => {
  it("recognises the retry for the same video", () => {
    expect(isDuplicateRefusal(refusal("abc"), "abc")).toBe(true);
  });

  it("does not match a retry for another video", () => {
    expect(isDuplicateRefusal(refusal("xyz"), "abc")).toBe(false);
  });

  it("does not match a refusal without a retry", () => {
    const json = {
      status: "STATUS_FAILED",
      actions: [{ openPopupAction: { popup: { text: "not the owner" } } }],
    };
    expect(isDuplicateRefusal(json, "abc")).toBe(false);
  });

  it("handles an empty response", () => {
    expect(isDuplicateRefusal({}, "abc")).toBe(false);
  });

  it("finds a retry buried far down", () => {
    let json: Record<string, unknown> = refusal("abc");
    for (let i = 0; i < 20; i++) json = { wrap: json };
    expect(isDuplicateRefusal(json, "abc")).toBe(true);
  });
});
