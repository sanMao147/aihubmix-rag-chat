import { createHash } from "crypto";

/**
 * 生成 MD5 哈希（与 Python hashlib.md5 结果一致）
 */
export function md5(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex");
}

/**
 * 生成 UUID v4
 */
export function uuid(): string {
  return crypto.randomUUID();
}

/**
 * 合并类名（过滤 falsy 值）
 */
export function cn(...classes: Array<string | false | undefined | null>): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * 格式化时间戳为可读字符串
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
 * 获取项目根目录（兼容 dev 和 production）
 */
export function getProjectRoot(): string {
  return process.cwd();
}
