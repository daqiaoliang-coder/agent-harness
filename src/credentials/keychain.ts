// API key 凭据管理: macOS Keychain(零依赖, 经 security CLI) — 避免明文 .env 落盘。
// 解析顺序: ANTHROPIC_API_KEY 环境变量(空串视为未设置) > macOS Keychain > 无(调用方降级/报错)。
// 测试注入: SECURITY_BIN 指向假二进制(见 test/smoke.js); AGENT_HARNESS_NO_KEYCHAIN=1 强制禁用
// (web-smoke 用它防止读到开发者真实 Keychain key 导致 mock 模式失效)。
import { execFileSync } from "child_process";

export const KEYCHAIN_SERVICE = "agent-harness";
const KEYCHAIN_ACCOUNT = "anthropic-api-key";

function securityBin(): string {
  return process.env.SECURITY_BIN ?? "security";
}

// Keychain 是否可用: 显式禁用 → false; 注入假二进制(测试) → true; 否则仅 macOS
function keychainEnabled(): boolean {
  if (process.env.AGENT_HARNESS_NO_KEYCHAIN === "1") return false;
  if (process.env.SECURITY_BIN) return true;
  return process.platform === "darwin";
}

// 存入/更新(-U)。key 经 argv 短暂可见于本机进程表(与 gh auth 等 CLI 一致的可接受折衷)
export function keychainStore(apiKey: string): void {
  execFileSync(
    securityBin(),
    ["add-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w", apiKey, "-U"],
    { stdio: ["ignore", "ignore", "ignore"] }
  );
}

// 读取; 未存储(macOS security 退出码 44)/拒绝访问/非 macOS → null
export function keychainLoad(): string | null {
  try {
    const out = execFileSync(
      securityBin(),
      ["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    const key = out.toString().trim();
    return key || null;
  } catch {
    return null;
  }
}

// 删除; 未存储时返回 false
export function keychainDelete(): boolean {
  try {
    execFileSync(
      securityBin(),
      ["delete-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE],
      { stdio: ["ignore", "ignore", "ignore"] }
    );
    return true;
  } catch {
    return false;
  }
}

export interface ResolvedApiKey {
  apiKey: string;
  source: "env" | "keychain";
}

// 统一解析入口(chat/web 共用): env(非空) > Keychain > null
export function resolveApiKey(): ResolvedApiKey | null {
  const env = process.env.ANTHROPIC_API_KEY?.trim();
  if (env) return { apiKey: env, source: "env" };
  if (keychainEnabled()) {
    const key = keychainLoad();
    if (key) return { apiKey: key, source: "keychain" };
  }
  return null;
}
