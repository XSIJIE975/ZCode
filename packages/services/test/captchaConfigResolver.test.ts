// Start Plan 验证码配置解析器与协议 reason 枚举单元测试：
// 60s TTL 缓存、失败不缓存、in-flight 去重（发行版 f3 语义）；
// captcha-retry 刷新原因在协议 schema 中双向可用。
import assert from "node:assert/strict";
import test from "node:test";
import type { ClientConfigSnapshot } from "@zcode/shared";
import { zcodeProviderRuntimeHeadersRequestReasonSchema } from "@zcode/shared";
import { createCaptchaConfigResolver } from "../src/client-config/captchaConfigResolver.js";
import type { IClientConfigService } from "../src/client-config/clientConfig.js";

function makeService(
  snapshot: ClientConfigSnapshot | Error,
): { service: IClientConfigService; calls: () => number } {
  let calls = 0;
  const service: IClientConfigService = {
    async getSnapshot() {
      calls += 1;
      if (snapshot instanceof Error) throw snapshot;
      return snapshot;
    },
  };
  return { service, calls: () => calls };
}

const emptySnapshot: ClientConfigSnapshot = { pluginStoreOrder: null, captcha: null };

test("captchaConfigResolver：成功结果缓存 60s，期间不再请求", async () => {
  const { service, calls } = makeService({
    ...emptySnapshot,
    captcha: { enabled: true, skipModelRequest: false, region: "cn", prefix: "x", sceneId: "s" },
  });
  const resolve = createCaptchaConfigResolver({ clientConfigService: service });
  const first = await resolve();
  assert.equal(first?.skipModelRequest, false);
  assert.equal(calls(), 1);
  await resolve();
  assert.equal(calls(), 1);
});

test("captchaConfigResolver：失败返回 null 且不缓存，下次请求重试", async () => {
  let failing = true;
  let calls = 0;
  const service: IClientConfigService = {
    async getSnapshot() {
      calls += 1;
      if (failing) throw new Error("boom");
      return emptySnapshot;
    },
  };
  const resolve = createCaptchaConfigResolver({ clientConfigService: service });
  assert.equal(await resolve(), null);
  assert.equal(calls, 1);
  failing = false;
  assert.deepEqual(await resolve(), null);
  assert.equal(calls, 2);
});

test("captchaConfigResolver：并发请求共享同一 in-flight Promise", async () => {
  const { service, calls } = makeService(emptySnapshot);
  const resolve = createCaptchaConfigResolver({ clientConfigService: service });
  const [a, b] = await Promise.all([resolve(), resolve()]);
  assert.deepEqual(a, null);
  assert.deepEqual(b, null);
  assert.equal(calls(), 1);
});

test("协议 reason 枚举：captcha-retry 双向可用，未知值拒绝", () => {
  assert.equal(
    zcodeProviderRuntimeHeadersRequestReasonSchema.safeParse("captcha-retry").success,
    true,
  );
  assert.equal(
    zcodeProviderRuntimeHeadersRequestReasonSchema.safeParse("model-request").success,
    true,
  );
  assert.equal(zcodeProviderRuntimeHeadersRequestReasonSchema.safeParse("off-peak").success, false);
});
