import type { WebRemoteControlState } from "@zcode/shared";

// workspace-list-updated 的主动推送调度。
//
// 发行版没有「在途就丢弃后续变更」这道门：它的列表是同步算出来的，一次变更对应一次比较与发送。
// 本仓库的列表要走 Host 异步组装，所以在途期间的新变更只记一次「待重推」，本轮跑完立刻补一轮，
// 终端既不会停在旧列表上，也不会收到交错的乱序推送。签名去重是发行版就有的行为，照搬。

export interface RelayWorkspaceListPushTarget {
  state: WebRemoteControlState;
  /** 上次推给终端的列表签名，用于去重主动推送。 */
  workspaceListPushSignature?: string;
  workspaceListPushRunning?: boolean;
  workspaceListPushPending?: boolean;
}

export interface RelayWorkspaceListPushDeps<T> {
  /** 组装一份完整列表；失败由 onFailure 记录，不抛出。 */
  build: () => Promise<T>;
  signatureOf: (result: T) => string;
  /** 掉线时终端会自己重新 bootstrap，补推只会是过期快照，所以这里以实时状态为准。 */
  isPaired: () => boolean;
  send: (result: T) => void;
  onFailure: (error: unknown) => void;
}

export function requestRelayWorkspaceListPush<T>(
  session: RelayWorkspaceListPushTarget,
  deps: RelayWorkspaceListPushDeps<T>,
): void {
  if (!deps.isPaired()) return;
  if (session.workspaceListPushRunning) {
    session.workspaceListPushPending = true;
    return;
  }
  session.workspaceListPushRunning = true;
  void deps
    .build()
    .then((result) => {
      if (!deps.isPaired()) return;
      const signature = deps.signatureOf(result);
      if (signature === session.workspaceListPushSignature) return;
      session.workspaceListPushSignature = signature;
      deps.send(result);
    })
    .catch(deps.onFailure)
    .finally(() => {
      session.workspaceListPushRunning = false;
      if (session.workspaceListPushPending) {
        session.workspaceListPushPending = false;
        requestRelayWorkspaceListPush(session, deps);
      }
    });
}
