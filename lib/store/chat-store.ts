import type { ChatSession, ChatMessage, MessageRole } from "@/lib/rag/types";
import { uuid } from "@/lib/utils";

/**
 * 对话历史管理（localStorage 持久化）。
 *
 * 这个模块只在浏览器侧真正读写 localStorage。Next.js 服务端渲染时没有 window，
 * 所以每个函数开头都要先判断 typeof window，避免 SSR 阶段访问浏览器 API 报错。
 */

/** 存储所有会话列表的 localStorage key。 */
const STORAGE_KEY = "rag-chat-sessions";

/** 存储当前选中会话 ID 的 localStorage key。 */
const CURRENT_SESSION_KEY = "rag-chat-current";

/**
 * 从 localStorage 加载所有会话。
 *
 * 返回值会按 updatedAt 从新到旧排序，方便侧边栏把最近对话显示在最上面。
 * 如果本地数据为空、JSON 解析失败，或者当前处于服务端环境，都返回空数组。
 */
export function loadSessions(): ChatSession[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const sessions = JSON.parse(raw) as ChatSession[];
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/**
 * 保存所有会话到 localStorage。
 *
 * localStorage 只能保存字符串，所以这里把 ChatSession[] 序列化成 JSON。
 * 写入失败常见于隐私模式、浏览器存储额度不足等情况，因此只记录错误，不中断 UI。
 */
export function saveSessions(sessions: ChatSession[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch (e) {
    console.error("[ChatStore] 保存会话失败:", e);
  }
}

/**
 * 获取当前会话 ID。
 *
 * 当前会话 ID 与会话列表分开存储，刷新页面后可以恢复用户最后打开的对话。
 */
export function getCurrentSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(CURRENT_SESSION_KEY);
}

/**
 * 设置当前会话 ID。
 */
export function setCurrentSessionId(id: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(CURRENT_SESSION_KEY, id);
}

/**
 * 创建新会话。
 *
 * 这里只构造内存对象，不负责写入 localStorage；调用方通常会把它插入 sessions 后，
 * 再调用 saveSessions 统一持久化。
 */
export function createSession(title: string = "新对话"): ChatSession {
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
 * 创建消息。
 *
 * role 决定消息显示在用户侧还是助手侧；sources 由后续 RAG 接口返回后再挂到助手消息上。
 */
export function createMessage(
  role: MessageRole,
  content: string
): ChatMessage {
  return {
    id: uuid(),
    role,
    content,
    createdAt: Date.now(),
  };
}

/**
 * 根据用户第一条消息生成会话标题。
 *
 * 为了保证侧边栏简洁，只保留前 20 个字符，超出时追加省略号。
 */
export function generateTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim();
  if (trimmed.length <= 20) return trimmed;
  return trimmed.slice(0, 20) + "...";
}

/**
 * 清空所有会话和当前会话指针。
 */
export function clearAllSessions(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(CURRENT_SESSION_KEY);
}
