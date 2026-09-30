// 0023：客户端签名观测随模型用量事实持久化——会话统计条与签名徽标在应用重启后
// 仍能展示「最近一次签名状态」。只新增两列可空文本，不回填历史行。
export const MODEL_USAGE_CLIENT_SIGNING_MIGRATION_SQL = `
alter table model_usage add column client_signing_kind text;
alter table model_usage add column client_signing_reason text;
`;
