import { describe, expect, it, vi } from "vitest";
import {
  createDictionaryStore,
  createMemoryDictionaryIo,
  defaultDictionaryFile,
  parseDictionaryJson,
  serializeDictionaryFile,
} from "../../src/services/dictionary";

describe("parseDictionaryJson", () => {
  it("accepts a valid v1 document", () => {
    const raw = serializeDictionaryFile(["TypeScript", "Vite"]);
    const parsed = parseDictionaryJson(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.words).toEqual(["TypeScript", "Vite"]);
  });

  it("rejects corrupt JSON without inventing a silent wipe path", () => {
    const parsed = parseDictionaryJson("{not-json");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/not valid JSON/i);
  });

  it("rejects unknown versions", () => {
    const parsed = parseDictionaryJson(JSON.stringify({
      version: 99,
      words: ["a"],
    }));
    expect(parsed.ok).toBe(false);
  });

  it("skips invalid entries and de-dupes case-insensitively", () => {
    const parsed = parseDictionaryJson(JSON.stringify({
      version: 1,
      words: ["Vite", "  ", 12, "vite", "Postgres"],
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.words).toEqual(["Postgres", "Vite"]);
  });
});

describe("createDictionaryStore", () => {
  it("loads missing file as empty", async () => {
    const store = createDictionaryStore(createMemoryDictionaryIo(null));
    const result = await store.load();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file).toEqual(defaultDictionaryFile());
  });

  it("round-trips save then load", async () => {
    const io = createMemoryDictionaryIo(null);
    const store = createDictionaryStore(io);
    await store.save(["TypeScript", "Vite"]);
    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.file.words).toEqual(["TypeScript", "Vite"]);
    expect(io.snapshot()).toContain('"version": 1');
    expect(io.snapshot()).toContain("Vite");
  });

  it("returns empty + error on corrupt bytes without writing", async () => {
    const io = createMemoryDictionaryIo("{corrupt");
    const store = createDictionaryStore(io);
    const loaded = await store.load();
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.file).toEqual(defaultDictionaryFile());
    expect(io.snapshot()).toBe("{corrupt");
  });

  it("surfaces read IO failures with empty defaults", async () => {
    const store = createDictionaryStore({
      read: async () => {
        throw new Error("disk gone");
      },
      write: async () => undefined,
    });
    const loaded = await store.load();
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toMatch(/disk gone/);
    expect(loaded.file.words).toEqual([]);
  });

  it("propagates save failures to the caller", async () => {
    const store = createDictionaryStore({
      read: async () => null,
      write: async () => {
        throw new Error("write denied");
      },
    });
    await expect(store.save(["Vite"])).rejects.toThrow(/write denied/);
  });
});

describe("dictionary store does not touch settings or history IO", () => {
  it("only reads/writes through the injected dictionary IO", async () => {
    const settingsWrite = vi.fn();
    const historyWrite = vi.fn();
    const io = createMemoryDictionaryIo(null);
    const store = createDictionaryStore({
      read: () => io.read(),
      write: async (contents) => {
        await io.write(contents);
        expect(settingsWrite).not.toHaveBeenCalled();
        expect(historyWrite).not.toHaveBeenCalled();
      },
    });
    await store.save(["Vite"]);
    expect(io.snapshot()).toContain("Vite");
    expect(settingsWrite).not.toHaveBeenCalled();
    expect(historyWrite).not.toHaveBeenCalled();
  });
});
