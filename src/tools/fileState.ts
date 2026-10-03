// 架构参考的 readFileState 追踪 — Edit 前必须 Read, 且 Read 之后文件被外部修改则拒绝编辑
// (编辑新鲜度校验: 防止覆盖用户/其他进程的并发修改)
// 每会话独立 store: Web 多会话同进程, 全局 Map 会让 A 会话的 Read "虚假满足"B 会话的先读后改
// (跨会话泄漏); 可选持久化(resume 恢复快照 — freshness 仍由 mtime/size 兜底, 文件被动过即 stale)。
import * as fs from "fs";

interface FileSnapshot {
  mtimeMs: number;
  size: number;
}

function snap(p: string): FileSnapshot {
  const st = fs.statSync(p);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

// 持久化文件形状(version 字段留前向兼容)
interface PersistShape {
  version: 1;
  files: Record<string, FileSnapshot>;
}

export class FileStateStore {
  private snapshots = new Map<string, FileSnapshot>();

  constructor(private readonly opts: { persistTo?: string } = {}) {}

  // resume: 从上次进程的持久化快照恢复(缺失/损坏 → 静默 false; 恢复后 freshness 校验照常兜底)
  load(): boolean {
    if (!this.opts.persistTo) return false;
    let raw: string;
    try {
      raw = fs.readFileSync(this.opts.persistTo, "utf8");
    } catch {
      return false; // 无持久化文件(首会话/旧版本会话) → 保持"需重新 Read"旧语义
    }
    try {
      const data = JSON.parse(raw) as PersistShape;
      if (data.version !== 1 || typeof data.files !== "object" || data.files === null) return false;
      for (const [p, s] of Object.entries(data.files)) {
        if (typeof s?.mtimeMs === "number" && typeof s?.size === "number") this.snapshots.set(p, s);
      }
      return this.snapshots.size > 0;
    } catch {
      return false; // 损坏 → 当作无快照
    }
  }

  // 落盘(每次 mark 同步写; 文件小 + 会话为交互频率, 参考实现不做 debounce — crash 也不丢状态)
  private persist(): void {
    if (!this.opts.persistTo) return;
    const files: Record<string, FileSnapshot> = {};
    for (const [p, s] of this.snapshots) files[p] = s;
    try {
      fs.writeFileSync(this.opts.persistTo, JSON.stringify({ version: 1, files } satisfies PersistShape), "utf8");
    } catch {
      // 落盘失败不阻断工具(快照仍在内存, 本会话内校验不受影响)
    }
  }

  markRead(p: string): void {
    this.snapshots.set(p, snap(p));
    this.persist();
  }

  markWritten(p: string): void {
    // Write/Edit 成功后更新快照, 允许本轮连续编辑
    this.snapshots.set(p, snap(p));
    this.persist();
  }

  checkFreshness(p: string): Freshness {
    const rec = this.snapshots.get(p);
    if (!rec) return "unread";
    try {
      const cur = snap(p);
      return cur.mtimeMs === rec.mtimeMs && cur.size === rec.size ? "ok" : "stale";
    } catch {
      return "stale"; // 文件已被删除/不可访问
    }
  }

  size(): number {
    return this.snapshots.size;
  }
}

export type Freshness = "ok" | "unread" | "stale";

// 缺省共享单例: 裸构造的工具(测试/直调)沿用旧语义 — 同进程 Read/Edit/Write 互通快照;
// cli.ts 显式注入每会话 store 后不受此影响(防跨会话泄漏)
let _defaultStore: FileStateStore | undefined;
export function defaultFileStateStore(): FileStateStore {
  if (!_defaultStore) _defaultStore = new FileStateStore();
  return _defaultStore;
}

// ── 文件级互斥(参考原版架构编辑互斥锁): 同一文件的 Edit/Write 串行执行 ──
// 并行工具调用下, 读-校验-写 三步必须原子; 否则两个并行 Edit 都基于旧内容整写 → 后写覆盖先写(丢失编辑)
// (进程内共享: 主会话与子代理同进程, 锁天然跨上下文生效; 跨会话同文件串行同样是正确语义)
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
