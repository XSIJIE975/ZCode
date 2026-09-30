// AliyunCaptcha SDK 集成：脚本加载、控制器生命周期、无感/交互验证执行。
// 按发行版 3.14.4 逆向规格还原（docs/specs/start-plan-captcha.md 与逆向报告 §八）：
// 超时层级（脚本加载后静置 2s / instance 等待 10s / 整体验证 120s / 控制器复用 20min）、
// fail 回调里的终态通过、F008 防重复提交、abort 传播全部对齐。
import { logger } from "@/logger.js";
import { CaptchaInteractiveRequiredError } from "./aliyunCaptchaShared.js";
import { handleSdkFail, type SdkFailHooks } from "./captchaSdkEvents.js";

const SDK_SCRIPT_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
/** instance 等待 / 初始化 drain 超时。 */
const INSTANCE_WAIT_TIMEOUT_MS = 10_000;
/** 脚本加载完成后的静置等待（不足则补齐）。 */
const TRIGGER_DELAY_MS = 2_000;
/** SDK 控制器复用 TTL：配置未变且初始化未超龄时直接复用。 */
const CONTROLLER_REUSE_TTL_MS = 1_200_000;

export interface AliyunCaptchaConfig {
  region: string;
  prefix: string;
  sceneId: string;
  language: "cn" | "en";
}

interface AliyunCaptchaInstance {
  show?: () => void;
  startTracelessVerification?: () => void;
}

interface AliyunCaptchaInitOptions {
  SceneId: string;
  mode: string;
  language: string;
  prefix?: string;
  region?: string;
  showErrorTip: boolean;
  element: string;
  button: string;
  captchaLogoImg?: string;
  getInstance: (instance: AliyunCaptchaInstance) => void;
  success: (captchaVerifyParam: string) => void;
  fail: (payload: unknown) => void;
  onError: (payload: unknown) => void;
}

type InitAliyunCaptcha = (options: AliyunCaptchaInitOptions) => AliyunCaptchaInstance | undefined;

declare global {
  interface Window {
    initAliyunCaptcha?: InitAliyunCaptcha;
    AliyunCaptchaConfig?: { region?: string; prefix?: string };
  }
}

// ── 模块级单例状态（与发行版 e3/t3/n3/r3/i3 对应）──
let scriptPromise: Promise<void> | null = null;
let scriptLoadedAt = 0;
export interface CaptchaController {
  configKey: string;
  instancePromise: Promise<AliyunCaptchaInstance>;
  initStartedAt: number;
  buttonElement: HTMLButtonElement;
}
export interface PendingVerification {
  resolve: (param: string) => void;
  reject: (error: unknown) => void;
  allowInteractive: boolean;
  awaitingDeferredSdkSuccess?: boolean;
}
/**
 * 模块级运行时单例（发行版 e3/t3/n3/r3/i3 的容器）：
 * 控制器、初始化串行门、pending 验证、验证进行中标志。拆分文件共享同一份状态。
 */
export const captchaRuntime: {
  controller: CaptchaController | undefined;
  initGate: { completion: Promise<void> } | undefined;
  pendingVerification: PendingVerification | undefined;
  verificationInFlight: boolean;
} = {
  controller: undefined,
  initGate: undefined,
  pendingVerification: undefined,
  verificationInFlight: false,
};

const domIds = {
  element: "zcode-aliyun-captcha-element",
  button: "zcode-aliyun-captcha-button",
} as const;

export function isCurrentController(candidate: CaptchaController): boolean {
  return captchaRuntime.controller === candidate;
}

/** 复位控制器与 pending 验证（发行版 s3）：SDK 回调只对「当前控制器」生效。 */
export function resetController(previous?: CaptchaController): void {
  if (previous) {
    logger.debug("[captcha] controller.reset", { controllerKey: previous.configKey });
  }
  captchaRuntime.pendingVerification = undefined;
  captchaRuntime.controller = undefined;
  document.getElementById(domIds.element)?.replaceChildren();
}

export function rejectCurrentPending(error: unknown): void {
  const pending = captchaRuntime.pendingVerification;
  captchaRuntime.pendingVerification = undefined;
  pending?.reject(error);
}

/** SDK fail 回调的状态钩子：pending 单例由本模块持有，事件处理经参数访问。 */
const sdkFailHooks: SdkFailHooks = {
  getPending: () => captchaRuntime.pendingVerification,
  takePending: () => {
    const pending = captchaRuntime.pendingVerification;
    captchaRuntime.pendingVerification = undefined;
    return pending;
  },
  rejectCurrentPending,
  resetController: () => resetController(captchaRuntime.controller),
};

// ── 脚本加载（发行版 enn：memoized，失败置空允许重试）──
function loadCaptchaScript(): Promise<void> {
  if (typeof window.initAliyunCaptcha === "function") return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SDK_SCRIPT_URL}"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("Failed to load captcha script.")),
        { once: true },
      );
      return;
    }
    const script = document.createElement("script");
    script.src = SDK_SCRIPT_URL;
    script.async = true;
    script.addEventListener(
      "load",
      () => {
        scriptLoadedAt = Date.now();
        resolve();
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => {
        script.remove();
        reject(new Error("Failed to load captcha script."));
      },
      { once: true },
    );
    document.head.appendChild(script);
  });
  scriptPromise.catch(() => {
    scriptPromise = null;
  });
  return scriptPromise;
}

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** 脚本加载后的静置等待（发行版 ann）。 */
export async function settleAfterScriptLoad(signal?: AbortSignal): Promise<void> {
  if (!scriptLoadedAt) return;
  const elapsed = Date.now() - scriptLoadedAt;
  if (elapsed >= TRIGGER_DELAY_MS) return;
  await waitForAbort(new Promise((resolve) => setTimeout(resolve, TRIGGER_DELAY_MS - elapsed)), signal);
}

/** 初始化串行 drain（发行版 nnn）：同一时刻至多一次 init。 */
async function drainInitialization(signal?: AbortSignal): Promise<void> {
  while (captchaRuntime.initGate) {
    const gate = captchaRuntime.initGate;
    await waitForAbort(
      Promise.race([
        gate.completion,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Captcha initialization timed out. Please restart the app or reload the page and try again.")),
            INSTANCE_WAIT_TIMEOUT_MS,
          ),
        ),
      ]),
      signal,
    );
  }
}

// ── SDK 控制器（发行版 rnn）──
export async function ensureController(
  config: AliyunCaptchaConfig,
  signal?: AbortSignal,
): Promise<CaptchaController> {
  const configKey = [config.region, config.prefix, config.sceneId, config.language].join("::");
  if (
    captchaRuntime.controller &&
    captchaRuntime.controller.configKey === configKey &&
    Date.now() - captchaRuntime.controller.initStartedAt < CONTROLLER_REUSE_TTL_MS
  ) {
    return captchaRuntime.controller;
  }
  resetController(captchaRuntime.controller);
  await drainInitialization(signal);
  if (
    captchaRuntime.controller &&
    captchaRuntime.controller.configKey === configKey &&
    Date.now() - captchaRuntime.controller.initStartedAt < CONTROLLER_REUSE_TTL_MS
  ) {
    return captchaRuntime.controller;
  }
  signal?.throwIfAborted();

  // region/prefix 不走 init 参数，走全局配置（发行版同款两段设置）。
  window.AliyunCaptchaConfig = { region: config.region, prefix: config.prefix };
  await waitForAbort(loadCaptchaScript(), signal);
  logger.debug("[captcha] script.ready", undefined);
  await drainInitialization(signal);
  if (
    captchaRuntime.controller &&
    captchaRuntime.controller.configKey === configKey &&
    Date.now() - captchaRuntime.controller.initStartedAt < CONTROLLER_REUSE_TTL_MS
  ) {
    return captchaRuntime.controller;
  }
  signal?.throwIfAborted();

  const init = window.initAliyunCaptcha;
  if (typeof init !== "function") {
    throw new Error("Captcha SDK is unavailable.");
  }
  const element = document.getElementById(domIds.element);
  const buttonElement = document.getElementById(domIds.button);
  if (!(element instanceof HTMLElement)) {
    throw new Error("Captcha host element is not mounted.");
  }
  if (!(buttonElement instanceof HTMLButtonElement)) {
    throw new Error("Captcha fallback button is not mounted.");
  }

  logger.info("[captcha] aliyun sdk init start", {
    configKey,
    language: config.language,
  });
  let instanceResolve: (instance: AliyunCaptchaInstance) => void = () => {};
  let instanceReject: (error: unknown) => void = () => {};
  const instancePromise = new Promise<AliyunCaptchaInstance>((resolve, reject) => {
    instanceResolve = resolve;
    instanceReject = reject;
  });
  const created: CaptchaController = {
    configKey,
    instancePromise,
    initStartedAt: Date.now(),
    buttonElement,
  };
  captchaRuntime.controller = created;
  const isCurrent = (): boolean => isCurrentController(created);
  const gate: { completion: Promise<void> } = {
    completion: instancePromise.then(
      () => {},
      () => {},
    ),
  };
  captchaRuntime.initGate = gate;

  let settledInstance: unknown;
  try {
    const returned = init({
      SceneId: config.sceneId,
      mode: "popup",
      language: config.language,
      showErrorTip: false,
      element: `#${domIds.element}`,
      button: `#${domIds.button}`,
      getInstance: (instance) => {
        if (!isCurrent()) return;
        logger.info("[captcha] aliyun sdk instance ready", {
          configKey,
          hasShow: typeof instance?.show === "function",
          hasStartTracelessVerification:
            typeof instance?.startTracelessVerification === "function",
        });
        instanceResolve(instance);
      },
      success: (captchaVerifyParam) => {
        if (!isCurrent()) return;
        logger.debug("[captcha] sdk.success", { paramLength: captchaVerifyParam?.length ?? 0 });
        const pending = captchaRuntime.pendingVerification;
        captchaRuntime.pendingVerification = undefined;
        pending?.resolve(captchaVerifyParam);
      },
      fail: (payload) => {
        if (!isCurrent()) return;
        handleSdkFail(sdkFailHooks, payload, (error) => {
          settledInstance = error;
          instanceReject(error);
        });
      },
      onError: (payload) => {
        if (!isCurrent()) return;
        logger.warn("[captcha] aliyun sdk onError", {
          configKey,
          message: payload instanceof Error ? payload.message : String(payload),
        });
        if (captchaRuntime.pendingVerification && !captchaRuntime.pendingVerification.allowInteractive) {
          rejectCurrentPending(new CaptchaInteractiveRequiredError());
          return;
        }
        const error =
          payload instanceof Error ? payload : new Error("Captcha errored before instance ready.");
        instanceReject(error);
        rejectCurrentPending(error);
      },
    });
    if (settledInstance !== undefined) {
      if (isCurrent()) resetController(created);
      throw settledInstance;
    }
    void returned;
  } catch (error) {
    if (isCurrent()) resetController(created);
    if (captchaRuntime.initGate === gate) captchaRuntime.initGate = undefined;
    logger.warn("[captcha] aliyun sdk init threw", {
      configKey,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error instanceof Error ? error : new Error(String(error));
  }
  instancePromise.finally(() => {
    if (captchaRuntime.initGate === gate) captchaRuntime.initGate = undefined;
  });
  return created;
}

export async function waitForInstance(
  target: CaptchaController,
  signal?: AbortSignal,
): Promise<AliyunCaptchaInstance> {
  const startedAt = Date.now();
  try {
    return await waitForAbort(
      Promise.race([
        target.instancePromise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Captcha instance timed out after ${INSTANCE_WAIT_TIMEOUT_MS}ms.`)),
            INSTANCE_WAIT_TIMEOUT_MS,
          ),
        ),
      ]),
      signal,
    );
  } catch (error) {
    logger.warn("[captcha] aliyun sdk instance wait timed out", {
      configKey: target.configKey,
      timeoutMs: INSTANCE_WAIT_TIMEOUT_MS,
      elapsedMs: Date.now() - startedAt,
    });
    throw error;
  }
}

export { runCaptchaVerification } from "./captchaVerification.js";
export { extractCertifyId, CaptchaInteractiveRequiredError } from "./aliyunCaptchaShared.js";
