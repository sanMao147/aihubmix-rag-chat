import { createHash } from "crypto";

/**
 * 创建带模块名前缀的统一日志记录器。
 *
 * 生产环境中可以通过设置 NEXT_PUBLIC_LOG_LEVEL 环境变量控制日志级别：
 * - "error"：仅输出错误
 * - "warn"：输出警告和错误
 * - "info"（默认）：输出所有日志
 * - "debug"：输出所有日志（含 debug 级别）
 */
export function createLogger(module: string) {
  const logLevel = (process.env.NEXT_PUBLIC_LOG_LEVEL || "info").toLowerCase();
  const levels: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

  function shouldLog(level: string): boolean {
    return (levels[level] ?? 1) >= (levels[logLevel] ?? 1);
  }

  const prefix = `[${module}]`;

  return {
    debug: (message: string, ...args: unknown[]) => {
      if (shouldLog("debug")) console.debug(`${prefix} ${message}`, ...args);
    },
    info: (message: string, ...args: unknown[]) => {
      if (shouldLog("info")) console.log(`${prefix} ${message}`, ...args);
    },
    warn: (message: string, ...args: unknown[]) => {
      if (shouldLog("warn")) console.warn(`${prefix} ${message}`, ...args);
    },
    error: (message: string, ...args: unknown[]) => {
      if (shouldLog("error")) console.error(`${prefix} ${message}`, ...args);
    },
  };
}

/** 默认全局 logger，供不需要模块前缀的场景使用。 */
export const logger = createLogger("App");

/**
 * 生成 MD5 哈希。
 *
 * 在本项目中主要用于把“文档相对路径”或“文档内容”压缩成稳定 ID：
 * - 同一份文件路径每次启动都会得到相同 parent_id，便于父子文档关联。
 * - 检索重排时也可以用内容哈希给文档去重。
 *
 * 这里显式指定 utf8，保证结果与 Python 的 hashlib.md5(text.encode("utf-8"))
 * 一致，便于从 Python 版本迁移或对照调试。
 */
export function md5(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex");
}

/**
 * 生成 UUID v4。
 *
 * 用于会话 ID、消息 ID、chunk_id 等“不要求可复现，只要求全局足够唯一”的场景。
 * Node.js 和现代浏览器都支持 crypto.randomUUID()。
 */
export function uuid(): string {
  return crypto.randomUUID();
}

/**
 * 合并 CSS 类名，并过滤 false / undefined / null。
 *
 * 这是一个轻量版 className 工具，适合组件中按条件拼接 Tailwind 类名：
 * cn("base", isActive && "active")。
 */
export function cn(...classes: Array<string | false | undefined | null>): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * 将时间戳格式化为适合聊天列表展示的中文相对时间。
 *
 * 规则：
 * - 1 分钟内：刚刚
 * - 1 小时内：x 分钟前
 * - 24 小时内：x 小时前
 * - 7 天内：x 天前
 * - 更早：显示月日
 */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days < 7) return `${days} 天前`;

  return date.toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
  });
}

/**
 * 获取项目根目录。
 *
 * 在 Next.js 服务端运行时，process.cwd() 通常指向项目根目录。
 * RAG 模块用它来定位 data/dishes 和 .data/vector-store.json 等本地文件。
 */
export function getProjectRoot(): string {
  return process.cwd();
}
