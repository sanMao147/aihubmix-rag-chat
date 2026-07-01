import { createRAGSystem } from "../rag/rag-system";
import { loadConfig } from "../rag/config";
import { closeNeo4jDriver } from "../rag/neo4j-connection";
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
    // 首次访问时才读取配置，避免模块导入阶段因缺少环境变量直接失败。
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
    // 缓存初始化 Promise，多个并发请求会等待同一次知识库构建。
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

/**
 * 进程退出时清理资源（在入口文件注册）
 */
export async function cleanupRAGResources(): Promise<void> {
  await closeNeo4jDriver();
  console.log("[RAGInstance] RAG 资源已清理");
}

