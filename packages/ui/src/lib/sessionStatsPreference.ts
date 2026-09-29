import { useSyncExternalStore } from "react";

/**
 * 会话统计条显示偏好：6 个可开关段（签名徽标固定展示，不参与配置）。
 * 全局一份配置（所有会话共用），localStorage 持久化、勾选即存即生效；
 * 跨组件实例（主统计条 / 子代理统计条）经 useSyncExternalStore 同步。
 * 仿 developerToolsPreference 的 localStorage 偏好模式，纯 UI 层无协议改动。
 */

const STORAGE_KEY = "zcode:session-stats:segments";

export interface SessionStatsSegments {
  turns: boolean;
  steps: boolean;
  lastTps: boolean;
  avgTps: boolean;
  input: boolean;
  output: boolean;
}

/** 默认全部显示：信息完整，由用户自行裁剪。 */
const DEFAULT_SEGMENTS: SessionStatsSegments = {
  turns: true,
  steps: true,
  lastTps: true,
  avgTps: true,
  input: true,
  output: true,
};

const SEGMENT_KEYS = ["turns", "steps", "lastTps", "avgTps", "input", "output"] as const;

let cached: SessionStatsSegments | null = null;
const listeners = new Set<() => void>();

function readStorage(): SessionStatsSegments {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SEGMENTS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_SEGMENTS };
    }
    const record = parsed as Record<string, unknown>;
    // 逐键容错：旧版本/损坏值只影响对应段，不整体重置。
    const resolved = { ...DEFAULT_SEGMENTS };
    for (const key of SEGMENT_KEYS) {
      if (typeof record[key] === "boolean") {
        resolved[key] = record[key] as boolean;
      }
    }
    return resolved;
  } catch {
    return { ...DEFAULT_SEGMENTS };
  }
}

function snapshot(): SessionStatsSegments {
  if (!cached) {
    cached = readStorage();
  }
  return cached;
}

function setSegments(next: SessionStatsSegments): void {
  cached = { ...next };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // 隐私模式等写入失败只影响持久化，本次会话内仍然生效。
  }
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSessionStatsSegments(): {
  segments: SessionStatsSegments;
  update: (patch: Partial<SessionStatsSegments>) => void;
  reset: () => void;
} {
  const segments = useSyncExternalStore(subscribe, snapshot, snapshot);
  return {
    segments,
    update: (patch) => setSegments({ ...snapshot(), ...patch }),
    reset: () => setSegments({ ...DEFAULT_SEGMENTS }),
  };
}
