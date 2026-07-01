import type { ChatSession, ChatMessage, MessageRole } from "@/lib/rag/types";
import { uuid } from "@/lib/utils";

/**
 * 对话历史管理（localStorage 持久化）
 * 对应原计划中的 lib/store/chat-store.ts
 */

const STORAGE_KEY = "rag-chat-sessions";
const CURRENT_SESSION_KEY = "rag-chat-current";

/**
 * 从 localStorage 加载所有会话
 */
export function loadSessions(): ChatSession[] {
  // localStorage 只存在于浏览器，服务端渲染阶段直接返回空列表。
  if (typeof window === "undefined") return [];

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const sessions = JSON.parse(raw) as ChatSession[];
    // 按更新时间降序排序
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/**
 * 保存所有会话到 localStorage
 */
export function saveSessions(sessions: ChatSession[]): void {
  // 写入失败通常来自隐私模式、容量限制或浏览器禁用本地存储。
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch (e) {
    console.error("[ChatStore] 保存会话失败:", e);
  }
}

/**
 * 获取当前会话 ID
 */
export function getCurrentSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(CURRENT_SESSION_KEY);
}

/**
 * 设置当前会话 ID
 */
export function setCurrentSessionId(id: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(CURRENT_SESSION_KEY, id);
}

/**
 * 创建新会话
 */
export function createSession(title: string = "新对话"): ChatSession {
  // 会话时间戳统一用毫秒，方便排序和前端格式化。
  const now = Date.now();
  return {
    id: uuid(),
    title,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 创建消息
 */
export function createMessage(
  role: MessageRole,
  content: string
): ChatMessage {
  // sources 在 RAG 回答完成后再补充，普通用户消息不需要该字段。
  return {
    id: uuid(),
    role,
    content,
    createdAt: Date.now(),
  };
}

/**
 * 根据消息列表生成会话标题（取第一条用户消息前 20 字）
 */
export function generateTitle(firstMessage: string): string {
  // 标题只做截断，不做语义摘要，避免额外调用模型。
  const trimmed = firstMessage.trim();
  if (trimmed.length <= 20) return trimmed;
  return trimmed.slice(0, 20) + "...";
}

/**
 * 清空所有会话
 */
export function clearAllSessions(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(CURRENT_SESSION_KEY);
}
