import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { z } from "zod";
import {
  openRelayBridge,
  type OpenRelayBridgeDeps,
} from "../src/main/webRemoteControl/relayBridgeSession.js";
import {
  findRelayWorkspaceTarget,
  isBridgeableRelayTarget,
  listRelayWorkspaces,
  type RelayWorkspaceDescriptor,
  type RelayWorkspaceTarget,
} from "../src/main/webRemoteControl/relayControlPlane.js";
import {
  buildBridgeDescriptor,
  mapRelayBridgeFailureReason,
} from "../src/main/webRemoteControl/relayManagerSupport.js";
import { createRelayPayloadRouter } from "../src/main/webRemoteControl/relayPayloadRouter.js";

// 远程 workspace 建桥对齐用例。
//
// 依据是终端产物 `src-*.js` 里的 zod 定义（发行版记为 `cg`），不是转述：
//   Z = string().trim().min(1)，Q = Z.max(256).regex(/^[A-Za-z0-9._~-]+$/)
//   bridge = 判别式联合 on "kind"：
//     local  = {bridgeSessionId:Q, bridgeGeneration?, recoveryId?, workspaceKey:Z, workspacePath:Z, initialTaskId?}
//     remote = local 的字段 + workspaceIdentity:Z + remoteSessionId:Z（两者都是必填）
//   终端的 object schema 不 strict，多余键被剥离；风险只有一个方向——必填缺失或空串会让整帧被丢弃。
// 下面用同样的约束建一份等价 schema，保证"发出去的帧能被终端接受"是可断言的而不是口头承诺。

const Z = z.string().trim().min(1);
const Q = Z.max(256).regex(/^[A-Za-z0-9._~-]+$/);
const optionalGeneration = z.number().int().nonnegative().optional();

const terminalBridgeSchema = z.discriminatedUnion("kind", [
  z.object({
    bridgeSessionId: Q,
    bridgeGeneration: optionalGeneration,
    recoveryId: Q.optional(),
    kind: z.literal("local"),
    workspaceKey: Z,
    workspacePath: Z,
    initialTaskId: Z.optional(),
  }),
  z.object({
    bridgeSessionId: Q,
    bridgeGeneration: optionalGeneration,
    recoveryId: Q.optional(),
    kind: z.literal("remote"),
    workspaceKey: Z,
    workspacePath: Z,
    workspaceIdentity: Z,
    remoteSessionId: Z,
    initialTaskId: Z.optional(),
  }),
]);

const REMOTE_IDENTITY = "remote:ssh:host.example:22:alice:/srv/app";
const localTarget: RelayWorkspaceTarget = {
  workspacePath: "E:/Personal/Demo",
  workspaceIdentity: "E:/Personal/Demo",
  kind: "local",
};
const remoteTarget: RelayWorkspaceTarget = {
  workspacePath: "/srv/app",
  workspaceIdentity: REMOTE_IDENTITY,
  remoteSessionId: "rs-77",
  kind: "remote",
};
const openPayload = {
  requestId: "req-1",
  bridgeSessionId: "bridge-abc",
  bridgeGeneration: 2,
  workspaceKey: "E:/Personal/Demo",
  taskId: "task-9",
};

/** Node 风格端口：对齐 Electron MessagePortMain 的 on/off/postMessage/start/close。 */
class FakePort extends EventEmitter {
  closed = false;
  postMessage(): void {}
  start(): void {}
  close(): void {
    this.closed = true;
  }
}

type FakeHost = { postMessage: (message: unknown) => void };

function makeBridgeDeps(input: {
  host?: FakeHost;
  target?: RelayWorkspaceTarget;
  sent: Record<string, unknown>[];
  ports: FakePort[];
}): OpenRelayBridgeDeps {
  return {
    windowId: 7,
    getHostProcess: () => (input.host as never) ?? undefined,
    createMessageChannel: () => {
      const port1 = new FakePort();
      input.ports.push(port1);
      return { port1: port1 as never, port2: new FakePort() as never };
    },
    resolveTarget: (workspaceKey) =>
      input.target && input.target.workspaceIdentity === workspaceKey ? input.target : undefined,
    sendPayload: (payload) => {
      input.sent.push(payload as Record<string, unknown>);
      return { kind: "sent" } as never;
    },
    getDeviceSid: () => "sid-demo",
    logger: { info: () => {}, warn: () => {} },
  };
}

function frameOf(sent: readonly Record<string, unknown>[], type: string): Record<string, unknown> {
  const frame = sent.find((candidate) => candidate.zcode_type === type);
  assert.ok(frame, `缺少 ${type} 帧`);
  return frame;
}

function descriptorOf(sent: readonly Record<string, unknown>[]): Record<string, unknown> {
  const bridge = frameOf(sent, "workspace-bridge-ready").bridge;
  assert.equal(typeof bridge, "object");
  return bridge as Record<string, unknown>;
}

test("bridge 描述符按目标类型产出 local / remote 两种形态", () => {
  const local = buildBridgeDescriptor(openPayload, localTarget, "bridge-abc");
  assert.deepEqual(terminalBridgeSchema.parse(local).kind, "local");
  // local 变体不能出现远程字段：多带不会拒，但把它们当本地作用域发出去是错的语义。
  assert.ok(!("workspaceIdentity" in local) && !("remoteSessionId" in local));

  const remote = buildBridgeDescriptor(
    { ...openPayload, workspaceKey: REMOTE_IDENTITY },
    remoteTarget,
    "bridge-abc",
  );
  const parsed = terminalBridgeSchema.parse(remote);
  assert.equal(parsed.kind, "remote");
  // workspaceKey 用身份键而不是路径：远程身份的 key 是 workspaceIdentity。
  assert.equal(parsed.workspaceKey, REMOTE_IDENTITY);
  assert.equal(parsed.workspacePath, "/srv/app");
  assert.equal(parsed.workspaceIdentity, REMOTE_IDENTITY);
  assert.equal(parsed.remoteSessionId, "rs-77");
});

test("远程目标缺 workspaceIdentity 或 remoteSessionId 时拒绝建桥而不是降级为 local", () => {
  for (const partial of [
    { ...remoteTarget, workspaceIdentity: undefined },
    { ...remoteTarget, remoteSessionId: undefined },
    { ...remoteTarget, workspaceIdentity: "  " },
    { ...remoteTarget, remoteSessionId: "" },
  ]) {
    assert.throws(
      () => buildBridgeDescriptor(openPayload, partial, "bridge-abc"),
      (error: unknown) => (error as { code?: string }).code === "REMOTE_WORKSPACE_IDENTITY_MISSING",
    );
    // 可桥接判定与描述符必须同一口径，否则会出现「门禁放行、建桥失败」的分歧。
    assert.equal(isBridgeableRelayTarget(partial), false);
  }
});

test("空白可选字段以「键不出现」上线，避免空串让整帧被终端丢弃", () => {
  const descriptor = buildBridgeDescriptor(
    { ...openPayload, recoveryId: "   ", taskId: "" },
    localTarget,
    "bridge-abc",
  );
  assert.ok(!("recoveryId" in descriptor) && !("initialTaskId" in descriptor));
  terminalBridgeSchema.parse(descriptor);

  const withRecovery = buildBridgeDescriptor(
    { ...openPayload, recoveryId: "rec-1", taskId: undefined },
    localTarget,
    "bridge-abc",
  );
  assert.equal(withRecovery.recoveryId, "rec-1");
  assert.ok(!("initialTaskId" in withRecovery));

  // 同一条判定也要作用于 handle.initialTaskId：它会被当 activeTaskId 回给终端。
  const sent: Record<string, unknown>[] = [];
  const handle = openRelayBridge(
    makeBridgeDeps({ host: { postMessage: () => {} }, target: localTarget, sent, ports: [] }),
    { ...openPayload, taskId: "  " },
    "bridge-abc",
  );
  assert.ok(handle);
  assert.equal(handle.initialTaskId, undefined);
  assert.ok(!("initialTaskId" in descriptorOf(sent)));
});

test("建桥失败按错误码回不同 reason，且 reason 落在终端枚举内", () => {
  const cases: Array<[string, string]> = [
    ["DESKTOP_HOST_MISSING", "desktop-disconnected"],
    ["REMOTE_SESSION_MISSING", "workspace-closed"],
    ["REMOTE_SESSION_WINDOW_MISMATCH", "workspace-closed"],
    ["REMOTE_WORKSPACE_IDENTITY_MISSING", "unsupported-action"],
    ["REMOTE_WORKSPACE_IDENTITY_MISMATCH", "unsupported-action"],
  ];
  for (const [code, reason] of cases) {
    assert.equal(
      mapRelayBridgeFailureReason(Object.assign(new Error("x"), { code })),
      reason,
      `code=${code}`,
    );
  }
  assert.equal(mapRelayBridgeFailureReason(new Error("无码")), "unexpected-error");
  assert.equal(mapRelayBridgeFailureReason("抛出物不是 Error"), "unexpected-error");
});

test("Host 缺失与目标未知分别走自己的 reason", () => {
  const noHost: Record<string, unknown>[] = [];
  const ports: FakePort[] = [];
  assert.equal(
    openRelayBridge(makeBridgeDeps({ sent: noHost, ports }), openPayload, "bridge-abc"),
    undefined,
  );
  assert.equal(frameOf(noHost, "workspace-bridge-error").reason, "desktop-disconnected");
  // 失败路径不能留下没有对端的 attachment。
  assert.equal(ports.length, 0);

  const unknown: Record<string, unknown>[] = [];
  assert.equal(
    openRelayBridge(
      makeBridgeDeps({ host: { postMessage: () => {} }, sent: unknown, ports: [] }),
      { ...openPayload, workspaceKey: "E:/Not/Open" },
      "bridge-abc",
    ),
    undefined,
  );
  assert.equal(frameOf(unknown, "workspace-bridge-error").reason, "unexpected-error");
});

test("建桥成功：ready 帧合形、handle.target 取自解析结果、dispose 收回端口", () => {
  const sent: Record<string, unknown>[] = [];
  const ports: FakePort[] = [];
  const handle = openRelayBridge(
    makeBridgeDeps({ host: { postMessage: () => {} }, target: localTarget, sent, ports }),
    openPayload,
    "bridge-abc",
  );
  assert.ok(handle);
  assert.equal(handle.target.kind, "local");
  assert.equal(handle.initialTaskId, "task-9");
  terminalBridgeSchema.parse(descriptorOf(sent));
  assert.equal(ports[0].closed, false);
  handle.dispose();
  assert.equal(ports[0].closed, true);
});

test("远程身份齐备时能建出 remote 桥；缺 sid 时失败且不建 attachment", () => {
  const ok: Record<string, unknown>[] = [];
  const okPorts: FakePort[] = [];
  const handle = openRelayBridge(
    makeBridgeDeps({
      host: { postMessage: () => {} },
      target: remoteTarget,
      sent: ok,
      ports: okPorts,
    }),
    { ...openPayload, workspaceKey: REMOTE_IDENTITY },
    "bridge-abc",
  );
  assert.equal(handle?.target.kind, "remote");
  const bridge = descriptorOf(ok);
  assert.equal(bridge.kind, "remote");
  assert.equal(bridge.remoteSessionId, "rs-77");
  handle?.dispose();

  const missingSid: Record<string, unknown>[] = [];
  const missingPorts: FakePort[] = [];
  assert.equal(
    openRelayBridge(
      makeBridgeDeps({
        host: { postMessage: () => {} },
        target: { ...remoteTarget, remoteSessionId: undefined },
        sent: missingSid,
        ports: missingPorts,
      }),
      { ...openPayload, workspaceKey: REMOTE_IDENTITY },
      "bridge-abc",
    ),
    undefined,
  );
  assert.equal(missingPorts.length, 0);
  const error = frameOf(missingSid, "workspace-bridge-error");
  assert.equal(error.reason, "unsupported-action");
  assert.equal(error.bridgeSessionId, "bridge-abc");
  assert.equal(error.bridgeGeneration, 2);
});

test("目标解析按身份键，不与 workspacePath 混用", () => {
  const descriptors: RelayWorkspaceDescriptor[] = [
    {
      workspacePath: "/srv/app",
      workspaceIdentity: REMOTE_IDENTITY,
      remoteSessionId: "rs-77",
      label: "app",
      kind: "remote",
      connectionState: "connected",
    },
    ...listRelayWorkspaces({ listWorkspacePaths: () => ["E:/Personal/Demo"] }),
  ];
  assert.equal(findRelayWorkspaceTarget(descriptors, REMOTE_IDENTITY)?.remoteSessionId, "rs-77");
  // 远程路径不是身份键：按路径匹配会把远程 workspace 判成「本窗口没有」。
  assert.equal(findRelayWorkspaceTarget(descriptors, "/srv/app"), undefined);
  assert.equal(findRelayWorkspaceTarget(descriptors, "  "), undefined);
  assert.equal(findRelayWorkspaceTarget(descriptors, "E:/Personal/Demo")?.kind, "local");
});

test("workspace-reconnect 判定走同一份目标解析", () => {
  function reconnect(
    target: RelayWorkspaceTarget | undefined,
    workspaceKey: string,
  ): Record<string, unknown> {
    const sent: Record<string, unknown>[] = [];
    createRelayPayloadRouter({
      getBridge: () => undefined,
      sendPayload: (payload) => void sent.push(payload),
      controlPlane: () => ({}) as never,
      openBridge: () => {},
      resolveTarget: (key) => (key === target?.workspaceIdentity ? target : undefined),
      getDeviceSid: () => "sid",
      applyMobileViewState: () => {},
      logger: { info: () => {}, warn: () => {} },
    })({ zcode_type: "workspace-reconnect-request", requestId: "r1", workspaceKey });
    return sent[0];
  }
  assert.equal(reconnect(remoteTarget, REMOTE_IDENTITY).success, true);
  assert.equal(reconnect(localTarget, "E:/Personal/Demo").success, true);
  const closed = reconnect(remoteTarget, "/srv/app");
  assert.equal(closed.success, false);
  assert.equal(closed.error, "workspace-closed");
});
