import { createRAGSystem } from "../rag/rag-system";
import { loadConfig } from "../rag/config";
import type { RAGSystem } from "../rag/types";

/**
 * RAG 系统单例管理
 * 在服务端全局缓存 RAG 系统实例，避免每次请求重建
 */

// 使用 globalThis 避免热重载时重复初始化
const globalForRAG = globalThis as unknown as {
  __ragSystem?: RAGSystem;
  __ragInitPromise?: Promise<RAGSystem>;
};

/**
 * 获取 RAG 系统实例（懒加载，自动构建知识库）
 */
export function getRAGSystem(): RAGSystem {
  if (!globalForRAG.__ragSystem) {
    const config = loadConfig();
    globalForRAG.__ragSystem = createRAGSystem(config);
  }
  return globalForRAG.__ragSystem;
}

/**
 * 获取已初始化的 RAG 系统（确保知识库已构建）
 * 使用 Promise 缓存避免并发请求重复构建
 */
export async function getInitializedRAGSystem(): Promise<RAGSystem> {
  const system = getRAGSystem();

  if (system.isReady()) {
    return system;
  }

  if (!globalForRAG.__ragInitPromise) {
    globalForRAG.__ragInitPromise = (async () => {
      system.initializeSystem();
      await system.buildKnowledgeBase();
      return system;
    })();
  }

  return globalForRAG.__ragInitPromise;
}

/**
 * 重置 RAG 系统（用于强制重建知识库）
 */
export function resetRAGSystem(): void {
  globalForRAG.__ragSystem = undefined;
  globalForRAG.__ragInitPromise = undefined;
}
