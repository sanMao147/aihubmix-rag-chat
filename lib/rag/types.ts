import type { Document } from "@langchain/core/documents";

/** 文档元数据 */
export interface ChunkMetadata {
  source: string;
  parent_id: string;
  doc_type: "parent" | "child";
  category: string;
  dish_name: string;
  difficulty: string;
  chunk_id?: string;
  chunk_index?: number;
  batch_index?: number;
  chunk_size?: number;
  rrf_score?: number;
  /** Markdown 标题路径，如 "可乐鸡翅的做法 > 必备原料和工具" */
  header_path?: string;
}

/** 带元数据的文档类型 */
export type ChunkDocument = Document<ChunkMetadata>;

/** 聊天消息角色 */
export type MessageRole = "user" | "assistant";

/** 聊天消息 */
export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  sources?: SourceDoc[];
  createdAt: number;
}

/** 来源文档信息（展示给用户） */
export interface SourceDoc {
  dish_name: string;
  category: string;
  difficulty: string;
  rrf_score: number;
  source: string;
}

/** 查询路由类型 */
export type RouteType = "list" | "detail" | "general";

/** 对话会话 */
export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/** 知识库统计信息 */
export interface KnowledgeBaseStats {
  total_documents: number;
  total_chunks: number;
  categories: Record<string, number>;
  difficulties: Record<string, number>;
  avg_chunk_size: number;
}

/** 向量存储持久化数据结构 */
export interface VectorStoreData {
  vectors: number[][];
  documents: Array<{
    pageContent: string;
    metadata: ChunkMetadata;
  }>;
  embeddingModel: string;
  createdAt: string;
}

/** RAG 请求体 */
export interface ChatRequestBody {
  query: string;
  history: Array<{ role: MessageRole; content: string }>;
}

/** SSE 事件数据 */
export interface SSESourcesEvent {
  type: "sources";
  data: SourceDoc[];
}

export interface SSETokenEvent {
  type: "token";
  data: string;
}

export interface SSEErrorEvent {
  type: "error";
  data: string;
}

export interface SSEDoneEvent {
  type: "done";
  data: string;
}

export type SSEEvent =
  | SSESourcesEvent
  | SSETokenEvent
  | SSEErrorEvent
  | SSEDoneEvent;
