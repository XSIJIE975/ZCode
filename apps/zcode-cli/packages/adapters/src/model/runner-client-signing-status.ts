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
 * `model_client_signing` 状态事件。只投进程级 statusSink——它是会话调试
 * 快照（开发者工具面板网络区）的数据源；不投 requestStatusSink，签名观测
 * 不属于对话产品状态。观测在签名层完成时已被记录，取空即无事件。
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
  if (!store || !params.statusSink) return;
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
