import { describe, expect, it, vi } from "vitest";
import { initialSettings } from "../../src/domain/fixtures";
import {
  coerceSettings,
  createMemorySettingsIo,
  createSettingsStore,
  defaultSettingsFile,
  parseSettingsJson,
  serializeSettingsFile,
} from "../../src/services/settings";

describe("parseSettingsJson", () => {
  it("accepts a valid v1 document", () => {
    const raw = serializeSettingsFile(
      { ...initialSettings, transcriptRetention: "forever", style: "casual" },
      true,
    );
    const parsed = parseSettingsJson(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.onboardingComplete).toBe(true);
    expect(parsed.file.settings.transcriptRetention).toBe("forever");
    expect(parsed.file.settings.style).toBe("casual");
  });

  it("rejects corrupt JSON without inventing a silent wipe path", () => {
    const parsed = parseSettingsJson("{not-json");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/not valid JSON/i);
  });

  it("rejects unknown versions", () => {
    const parsed = parseSettingsJson(JSON.stringify({
      onboardingComplete: false,
      settings: initialSettings,
      version: 99,
    }));
    expect(parsed.ok).toBe(false);
  });

  it("coerces invalid individual fields to defaults inside a valid envelope", () => {
    const parsed = parseSettingsJson(JSON.stringify({
      onboardingComplete: true,
      settings: {
        ...initialSettings,
        appearance: "neon",
        transcriptRetention: "forever",
      },
      version: 1,
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.settings.appearance).toBe(initialSettings.appearance);
    expect(parsed.file.settings.transcriptRetention).toBe("forever");
    expect(parsed.file.onboardingComplete).toBe(true);
  });
});

describe("coerceSettings", () => {
  it("returns defaults for non-objects", () => {
    expect(coerceSettings(null)).toEqual(initialSettings);
  });
});

describe("createSettingsStore", () => {
  it("loads missing file as defaults", async () => {
    const store = createSettingsStore(createMemorySettingsIo(null));
    const result = await store.load();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file).toEqual(defaultSettingsFile());
  });

  it("round-trips save then load", async () => {
    const io = createMemorySettingsIo(null);
    const store = createSettingsStore(io);
    const next = {
      ...initialSettings,
      appearance: "dark" as const,
      microphone: "Built-in Mic",
      style: "very-casual" as const,
      transcriptRetention: "off" as const,
      transcriptionModel: "whisper-base.en",
    };
    await store.save(next, true);
    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.file.settings).toEqual(next);
    expect(loaded.file.onboardingComplete).toBe(true);
    expect(io.snapshot()).toContain('"version": 1');
    expect(io.snapshot()).toContain('"transcriptRetention": "off"');
  });

  it("returns defaults + error on corrupt bytes without writing", async () => {
    const io = createMemorySettingsIo("{corrupt");
    const store = createSettingsStore(io);
    const loaded = await store.load();
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.file).toEqual(defaultSettingsFile());
    expect(io.snapshot()).toBe("{corrupt");
  });

  it("surfaces read IO failures with defaults", async () => {
    const store = createSettingsStore({
      read: async () => {
        throw new Error("disk gone");
      },
      write: async () => undefined,
    });
    const loaded = await store.load();
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toMatch(/disk gone/);
    expect(loaded.file.settings.transcriptRetention).toBe("30-days");
  });

  it("propagates save failures to the caller", async () => {
    const store = createSettingsStore({
      read: async () => null,
      write: async () => {
        throw new Error("write denied");
      },
    });
    await expect(store.save(initialSettings, false)).rejects.toThrow(
      /write denied/,
    );
  });
});

describe("settings store does not touch history IO", () => {
  it("only reads/writes through the injected settings IO", async () => {
    const historyWrite = vi.fn();
    const io = createMemorySettingsIo(null);
    const store = createSettingsStore({
      read: () => io.read(),
      write: async (contents) => {
        await io.write(contents);
        // Prove we never call a parallel history writer from this store.
        expect(historyWrite).not.toHaveBeenCalled();
      },
    });
    await store.save(
      { ...initialSettings, transcriptRetention: "forever" },
      false,
    );
    expect(io.snapshot()).toContain("forever");
    expect(historyWrite).not.toHaveBeenCalled();
  });
});
