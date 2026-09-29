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
