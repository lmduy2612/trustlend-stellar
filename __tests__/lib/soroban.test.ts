import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/stellar/wallet", () => ({
  signTransactionWithWallet: vi.fn(),
}));

import { getAccountSequence } from "@/lib/stellar/soroban";

const VALID_ADDRESS = "GAJRNUO6HSMQG4FNHNWQVRXJZJZ7QRA7HXPYYB6H5PTA3EAAJXJNZD7U";

describe("getAccountSequence", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("fetches sequence successfully for a valid Stellar address", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sequence: "123456789" }),
    });

    const sequence = await getAccountSequence(VALID_ADDRESS);
    expect(sequence).toBe("123456789");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/accounts/${encodeURIComponent(VALID_ADDRESS)}`),
    );
  });

  it("rejects malformed address and throws validation error without calling fetch", async () => {
    global.fetch = vi.fn();

    const invalidAddresses = [
      "invalid-address",
      "../traversal",
      "G12345",
      "GAJRNUO6HSMQG4FNHNWQVRXJZJZ7QRA7HXPYYB6H5PTA3EAAJXJNZD7?",
      "",
    ];

    for (const addr of invalidAddresses) {
      await expect(getAccountSequence(addr)).rejects.toThrow(
        /Invalid Stellar address format/,
      );
    }

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("handles 404 not found cleanly with funding instructions", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    await expect(getAccountSequence(VALID_ADDRESS)).rejects.toThrow(
      /Account .* not found on Stellar network/,
    );
  });
});
