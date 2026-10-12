import { describe, expect, it } from "vitest";
import {
  isDeveloperToolsStorageValueEnabled,
  readDeveloperToolsEnabled,
} from "../src/lib/developerToolsPreference.js";

function createStorage(values: Record<string, string>): Storage {
  const entries = new Map(Object.entries(values));
  return {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key: string) {
      return entries.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(entries.keys())[index] ?? null;
    },
    removeItem(key: string) {
      entries.delete(key);
    },
    setItem(key: string, value: string) {
      entries.set(key, value);
    },
  };
}

describe("developerToolsPreference", () => {
  it("enables developer tools when either supported localStorage key exists", () => {
    expect(
      readDeveloperToolsEnabled(
        createStorage({
          "zcode:developer-tools:enabled": "1",
        }),
      ),
    ).toBe(true);
    expect(
      readDeveloperToolsEnabled(
        createStorage({
          "zcode:token-debug:enabled": "debug",
        }),
      ),
    ).toBe(true);
  });

  it("treats explicit off values as disabled", () => {
    for (const value of ["0", "false", "off", "no"]) {
      expect(isDeveloperToolsStorageValueEnabled(value)).toBe(false);
    }
    // 定制语义（feature/xcode）：缺省显示开发者工具入口——它是客户端签名状态等
    // 诊断信息的常驻明细入口；上游缺省隐藏，显式 off 才隐藏的行为两侧一致。
    expect(isDeveloperToolsStorageValueEnabled(null)).toBe(true);
    expect(isDeveloperToolsStorageValueEnabled("true")).toBe(true);
  });
});
