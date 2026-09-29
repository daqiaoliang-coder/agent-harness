// 架构参考: Glob/Grep 均内置文件遍历(尊重 .gitignore/.claudeignore); 此处固定忽略表 + .claudeignore + 深度/数量双守卫
import * as fs from "fs";
import * as path from "path";

export const DEFAULT_IGNORES = new Set([".git", "node_modules", "dist", ".agent-harness"]);

const MAX_DEPTH = 20;
const MAX_FILES = 20000;

// glob → 正则(*=单层, **=跨目录, ?=单字符; 不支持 {} 展开与字符类)
export function globToRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*"; // ** 跨目录
        i++;
        if (pattern[i + 1] === "/") i++; // **/ 的 / 由 .* 吸收(可匹配零层)
      } else {
        re += "[^/]*"; // * 单层
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // 仅单字符, 元字符转义
    }
  }
  return new RegExp(`^${re}$`);
}

// 解析 .claudeignore: 每行一个 glob(# 注释/空行跳过; 不支持 ! 否定)
function loadIgnorePatterns(root: string): string[] {
  const p = path.join(root, ".claudeignore");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

// 相对路径是否命中 ignore 模式: 目录型(build/ 或 build → 子树全忽略)或文件型(*.log 匹配 basename)
export function matchesIgnore(rel: string, pattern: string): boolean {
  const p = pattern.replace(/\/+$/, "");
  if (rel === p || rel.startsWith(p + "/")) return true; // 目录/精确路径 → 子树忽略
  const re = globToRegex(p);
  if (p.includes("/")) return re.test(rel); // 含 / 的模式按整路径匹配
  return re.test(rel) || re.test(path.basename(rel)); // 单段模式兼匹配 basename
}

// 递归列出文件绝对路径(忽略 DEFAULT_IGNORES 目录与 .claudeignore 命中项; 深度守卫防符号链接循环)
export function walkFiles(root: string, _depth = 0, out: string[] = []): string[] {
  const patterns = loadIgnorePatterns(root); // 每次遍历重读一次(文件小, 正确性优先)
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 不可读目录 → 跳过
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) break;
      if (e.isDirectory() && DEFAULT_IGNORES.has(e.name)) continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).split(path.sep).join("/");
      if (patterns.some((pat) => matchesIgnore(rel, pat))) continue; // .claudeignore 命中 → 跳过
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}
