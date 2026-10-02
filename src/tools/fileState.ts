// 架构参考:的 readFileState 追踪 — Edit 前必须 Read, 且 Read 之后文件被外部修改则拒绝编辑
// (编辑新鲜度校验: 防止覆盖用户/其他进程的并发修改)
import * as fs from "fs";

interface FileSnapshot {
  mtimeMs: number;
  size: number;
}

const snapshots = new Map<string, FileSnapshot>();

function snap(p: string): FileSnapshot {
  const st = fs.statSync(p);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

export function markRead(p: string): void {
  snapshots.set(p, snap(p));
}

export function markWritten(p: string): void {
  // Write/Edit 成功后更新快照, 允许本轮连续编辑
  snapshots.set(p, snap(p));
}

// ── 文件级互斥(参考原版架构编辑互斥锁): 同一文件的 Edit/Write 串行执行 ──
// 并行工具调用下, 读-校验-写 三步必须原子; 否则两个并行 Edit 都基于旧内容整写 → 后写覆盖先写(丢失编辑)
// (进程内共享: 主会话与子代理同进程, 锁天然跨上下文生效)
const fileLocks = new Map<string, Promise<unknown>>();

export function withFileLock<T>(p: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(p) ?? Promise.resolve();
  const run = prev.then(fn, fn); // 前序失败不阻塞后续(错误已在各自工具结果中上报)
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  fileLocks.set(p, tail);
  void tail.then(() => {
    // 链尾自清理: 仅当没有新的等待者接上时才删除(Map 不无限增长)
    if (fileLocks.get(p) === tail) fileLocks.delete(p);
  });
  return run;
}

export type Freshness = "ok" | "unread" | "stale";

export function checkFreshness(p: string): Freshness {
  const rec = snapshots.get(p);
  if (!rec) return "unread";
  try {
    const cur = snap(p);
    return cur.mtimeMs === rec.mtimeMs && cur.size === rec.size ? "ok" : "stale";
  } catch {
    return "stale"; // 文件已被删除/不可访问
  }
}
