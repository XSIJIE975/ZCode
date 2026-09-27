export const DEVELOPER_TOOLS_STORAGE_KEYS = [
  "zcode:developer-tools:enabled",
  "zcode:token-debug:enabled",
] as const;

const DISABLED_VALUES = new Set(["0", "false", "off", "no"]);

function isDeveloperToolsStorageValueEnabled(value: string | null): boolean {
  // 缺省显示开发者工具入口：它是客户端签名状态等诊断信息的常驻明细入口，
  // 不应要求用户手写 localStorage 才能找到；显式写入 0/false/off/no 才隐藏。
  if (value === null) {
    return true;
  }
  const normalized = value.trim().toLowerCase();
  return !DISABLED_VALUES.has(normalized);
}

export function readDeveloperToolsEnabled(storage: Storage | undefined = getLocalStorage()) {
  if (!storage) {
    return false;
  }
  return DEVELOPER_TOOLS_STORAGE_KEYS.some((key) => {
    try {
      return isDeveloperToolsStorageValueEnabled(storage.getItem(key));
    } catch {
      return false;
    }
  });
}

function getLocalStorage(): Storage | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
