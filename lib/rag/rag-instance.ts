import { loadConfig } from "../rag/config";
import { createRAGSystem } from "../rag/rag-system";
import type { RAGSystem } from "../rag/types";

/**
 * RAG 系统单例管理。
 *
 * Next.js 开发模式下会热重载模块；如果每次请求都重新创建 RAG 系统，
 * 会反复读取文件、构建 BM25、甚至重复构建向量索引。这里把实例挂到 globalThis，
 * 让同一个 Node.js 进程内的请求共享一套 RAG 系统。
 */
const globalForRAG = globalThis as unknown as {
  /** 已创建的 RAGSystem 实例。 */
  __ragSystem?: RAGSystem;
  /** 正在初始化的 Promise，用于合并并发请求。 */
  __ragInitPromise?: Promise<RAGSystem>;
};

/**
 * 获取 RAG 系统实例（懒加载）。
 *
 * 这个函数只负责创建实例，不保证知识库已经构建完成。
 */
export function getRAGSystem(): RAGSystem {
  if (!globalForRAG.__ragSystem) {
    const config = loadConfig();
    globalForRAG.__ragSystem = createRAGSystem(config);
  }
  return globalForRAG.__ragSystem;
}

/**
 * 获取已初始化的 RAG 系统。
 *
 * 首个请求会触发 initializeSystem + buildKnowledgeBase。
 * 如果多个请求同时进来，会共享同一个 __ragInitPromise，避免重复构建知识库。
 */
export async function getInitializedRAGSystem(): Promise<RAGSystem> {
  const system = getRAGSystem();

  if (system.isReady()) {
    return system;
  }

  if (!globalForRAG.__ragInitPromise) {
    globalForRAG.__ragInitPromise = (async () => {
      try {
        system.initializeSystem();
        await system.buildKnowledgeBase();
        return system;
      } catch (error) {
        globalForRAG.__ragInitPromise = undefined;
        throw error;
      }
    })();
  }

  return globalForRAG.__ragInitPromise;
}

/**
 * 重置 RAG 系统。
 *
 * 知识库管理接口可以调用它来丢弃内存实例，下一次请求会重新创建并加载/构建索引。
 */
export function resetRAGSystem(): void {
  globalForRAG.__ragSystem = undefined;
  globalForRAG.__ragInitPromise = undefined;
}
