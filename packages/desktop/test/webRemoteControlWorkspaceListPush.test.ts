import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  requestRelayWorkspaceListPush,
  type RelayWorkspaceListPushTarget,
} from "../src/main/webRemoteControl/relayWorkspaceListPush.js";

// workspace-list-updated 的推送调度：内容没变不推（发行版的签名去重），
// 在途期间的变更不能被丢，必须补一轮，否则终端会一直停在旧列表上。

interface ListResult {
  revision: number;
}

function createSession(): RelayWorkspaceListPushTarget & { sent: ListResult[] } {
  return {
    state: "paired",
    sent: [],
  };
}

function createDeps(
  session: RelayWorkspaceListPushTarget & { sent: ListResult[] },
  input: { build: () => Promise<ListResult>; onBuild?: () => void },
) {
  return {
    build: async () => {
      input.onBuild?.();
      return input.build();
    },
    signatureOf: (result: ListResult) => String(result.revision),
    isPaired: () => session.state === "paired",
    send: (result: ListResult) => {
      session.sent.push(result);
    },
    onFailure: (error: unknown) => {
      throw error;
    },
  };
}

describe("workspace 列表主动推送", () => {
  it("内容未变的重复变更只推一次", async () => {
    const session = createSession();
    let revision = 1;
    const deps = createDeps(session, { build: async () => ({ revision }) });
    requestRelayWorkspaceListPush(session, deps);
    requestRelayWorkspaceListPush(session, deps);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(session.sent.length, 1);
  });

  it("在途期间来了新内容时补推一轮，不丢变更", async () => {
    const session = createSession();
    let revision = 1;
    let release: (() => void) | undefined;
    let buildCount = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = createDeps(session, {
      build: async () => {
        buildCount += 1;
        // 组装在开始时就取当刻的列表快照，await 期间发生的新变更要留给下一轮。
        const snapshot = revision;
        if (buildCount === 1) await gate;
        return { revision: snapshot };
      },
    });

    requestRelayWorkspaceListPush(session, deps);
    // 第一次组装还挂着时又来一次变更：只记待重推，不能就地发送。
    revision = 2;
    requestRelayWorkspaceListPush(session, deps);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(session.sent.length, 0);

    release?.();
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      session.sent.map((item) => item.revision),
      [1, 2],
    );
    assert.equal(buildCount, 2);
  });

  it("掉线后不再组装，也不再补推", async () => {
    const session = createSession();
    let buildCount = 0;
    const deps = createDeps(session, {
      build: async () => {
        buildCount += 1;
        return { revision: buildCount };
      },
    });
    session.state = "waiting_terminal";
    requestRelayWorkspaceListPush(session, deps);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(buildCount, 0);
    assert.equal(session.sent.length, 0);
  });
});
