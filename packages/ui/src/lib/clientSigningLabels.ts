/** 客户端签名观测 kind → i18n id；开发者工具面板与信息条徽标共用。 */
export function signingKindLabelId(kind: string): string {
  switch (kind) {
    case "signed_sent":
    case "unsigned_sent":
    case "handshake_failed":
    case "verify_rejected":
    case "bypass_entered":
    case "request_failed_closed":
      return `developerTools.network.signing.kind.${kind}`;
    default:
      return "developerTools.network.signing";
  }
}

/** signed_sent 是唯一的全链路成功态；其余（未签名/握手失败/验签被拒/降级）都提示需要关注。 */
export function isSigningAttentionKind(kind: string): boolean {
  return kind !== "signed_sent";
}
