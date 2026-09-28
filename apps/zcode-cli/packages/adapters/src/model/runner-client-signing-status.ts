// 客户端签名观测发布：runner-status.ts 顶到 oxlint max-lines 上限（400 行），
// 与 runner-attribution.ts 同样按主题拆出。依赖方向：本文件运行时依赖
// runner-status.ts 的 publishModelStatus / ModelStatusContext，反向不成环。
import type {
  Logger,
  ModelClientSigningObservationStatus,
  ModelStatusSink,
} from "@zcode/contracts";
import type { ClientSigningObservation } from "./client-request-signing.js";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "./runner-runtime.js";
import { publishModelStatus, type ModelStatusContext } from "./runner-status.js";

/**
 * 把本次尝试期间记录的客户端签名观测按 requestId 取出并发布为
 * `model_client_signing` 状态事件。必须同时投 requestStatusSink——它是
 * core 运行时产生 SessionEvent 的汇，会话调试快照（开发者工具面板网络区、
 * 侧边栏签名徽标）都从那里读取；只投进程级 telemetry sink 的话观测永远
 * 不会出现在任何界面上。不投 admissionTicket：签名观测不是尝试生命周期
 * 事件，不应进入并发治理器的尝试记账。
 */
export async function publishClientSigningObservations(params: {
  attempt: number;
  logger?: Logger;
  request: AiSdkModelTextRequest;
  resolved: ResolvedAiSdkModel;
  statusContext: ModelStatusContext;
  statusSink?: ModelStatusSink;
}): Promise<void> {
  const store = params.resolved.clientSigningObservations;
  if (!store) return;
  const requestStatusSink = params.request.statusSink;
  if (!requestStatusSink && !params.statusSink) return;
  const observations = store.take(params.statusContext.requestId);
  if (observations.length === 0) return;
  for (const observation of observations) {
    await publishModelStatus(
      {
        ...params.statusContext,
        attempt: params.attempt,
        clientSigning: toModelClientSigningObservationStatus(observation),
        timestamp: new Date().toISOString(),
        type: "model_client_signing",
      },
      {
        logger: params.logger,
        requestStatusSink,
        statusSink: params.statusSink,
      },
    );
  }
}

function toModelClientSigningObservationStatus(
  observation: ClientSigningObservation,
): ModelClientSigningObservationStatus {
  return {
    kind: observation.kind,
    ...(observation.reason !== undefined ? { reason: observation.reason } : {}),
    ...(observation.signedAttempt !== undefined
      ? { signedAttempt: observation.signedAttempt }
      : {}),
    ...(observation.errorKind !== undefined ? { errorKind: observation.errorKind } : {}),
    ...(observation.httpStatus !== undefined ? { httpStatus: observation.httpStatus } : {}),
    ...(observation.businessCode !== undefined
      ? { businessCode: observation.businessCode }
      : {}),
  };
}
