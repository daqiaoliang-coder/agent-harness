// 架构参考:的所有阈值常量集中管理; 水位公式精确保留:
//   effectiveWindow = contextWindow − min(maxOutputTokens, 20K)
//   autoCompactAt   = effectiveWindow − 13K   (T4 触发)
//   warningAt       = autoCompactAt − 20K     (警告)
//   blockingAt      = effectiveWindow − 3K    (硬停: 拒绝新请求)
export interface CompactConfig {
  contextWindow: number; // 生产: 200_000
  maxOutputTokens: number; // 生产: 32_000
  autoCompactThreshold: number; // 生产: 13_000
  warningThreshold: number; // 生产: 20_000
  blockingThreshold: number; // 生产: 3_000
  // T0: 单个工具结果 token 预算, 超出 → 落盘+预览
  toolResultBudget: number; // 生产: 2_000
  // T1: 保留最近 N 条消息中的工具结果不清除
  microCompactKeepRecent: number; // 3
  // T2: buffer 超过 snipTarget + autoCompactThreshold 时触发 snip
  snipTarget: number; // 生产: ~100_000
  snipBatch: number; // 每次触发最多归档的工具交换对数
  // T3: 每到达一个百分比水位折叠一个逻辑段
  collapseLevels: number[]; // 生产: [0.90, 0.92, 0.94]
  // T4: 摘要与恢复预算
  summaryTokenCap: number; // 生产: 20_000
  restoreBudget: number; // 生产: 50_000 (压缩后恢复文件内容)
  restoreFileCap: number; // ≤5 个文件
  restoreFileBudget: number; // 每文件 生产: 5_000
  // T4 熔断: 连续 autocompact 失败次数上限
  maxConsecutiveAutoCompactFailures: number; // 3
}

export const PRODUCTION_COMPACT_CONFIG: CompactConfig = {
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  autoCompactThreshold: 13_000,
  warningThreshold: 20_000,
  blockingThreshold: 3_000,
  toolResultBudget: 2_000,
  microCompactKeepRecent: 3,
  snipTarget: 100_000,
  snipBatch: 2,
  collapseLevels: [0.9, 0.92, 0.94],
  summaryTokenCap: 20_000,
  restoreBudget: 50_000,
  restoreFileCap: 5,
  restoreFileBudget: 5_000,
  maxConsecutiveAutoCompactFailures: 3,
};

// demo 用缩小窗口, 阈值等比缩小(13K→800, 20K→1500, 3K→200)以便快速触发各层
export const DEMO_COMPACT_CONFIG: CompactConfig = {
  contextWindow: 16_384,
  maxOutputTokens: 2_000,
  autoCompactThreshold: 800,
  warningThreshold: 1_500,
  blockingThreshold: 200,
  toolResultBudget: 400,
  microCompactKeepRecent: 3,
  snipTarget: 10_000,
  snipBatch: 2,
  collapseLevels: [0.9, 0.92, 0.94],
  summaryTokenCap: 2_000,
  restoreBudget: 5_000,
  restoreFileCap: 5,
  restoreFileBudget: 500,
  maxConsecutiveAutoCompactFailures: 3,
};

export interface Watermarks {
  effectiveWindow: number;
  autoCompactAt: number;
  warningAt: number;
  blockingAt: number;
}

export function computeWatermarks(cfg: CompactConfig): Watermarks {
  // 关键公式: 输出预留封顶 20K(与真实实现一致)
  const effectiveWindow = cfg.contextWindow - Math.min(cfg.maxOutputTokens, 20_000);
  const autoCompactAt = effectiveWindow - cfg.autoCompactThreshold;
  return {
    effectiveWindow,
    autoCompactAt,
    warningAt: autoCompactAt - cfg.warningThreshold,
    blockingAt: effectiveWindow - cfg.blockingThreshold,
  };
}
