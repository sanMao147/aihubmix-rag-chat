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

/** 向量存储 API */
export interface VectorStoreApi {
  similaritySearch(query: string, k?: number): Promise<Document[]>;
  size: number;
  /** 构建索引（内部使用） */
  fromDocuments(docs: Document[]): Promise<void>;
  /** 添加文档（内部使用） */
  addDocuments(docs: Document[]): Promise<void>;
  /** 获取所有数据（用于持久化） */
  getData(): { vectors: number[][]; documents: Document[] };
  /** 从数据恢复 */
  setData(data: { vectors: number[][]; documents: Document[] }): void;
}

/** 数据准备状态 */
export interface DataPreparationState {
  documents: ChunkDocument[];
  chunks: ChunkDocument[];
  parentChildMap: Record<string, string>;
}

/** 索引构建器 API */
export interface IndexBuilderApi {
  buildVectorIndex(chunks: ChunkDocument[]): Promise<VectorStoreApi>;
  saveIndex(vectorstore: VectorStoreApi): Promise<void>;
  loadIndex(): Promise<VectorStoreApi | null>;
  similaritySearch(vectorstore: VectorStoreApi, query: string, k?: number): Promise<ChunkDocument[]>;
}

/** 检索引擎 API */
export interface RetrievalEngineApi {
  hybridSearch(query: string, topK?: number): Promise<ChunkDocument[]>;
  metadataFilteredSearch(
    query: string,
    filters: Partial<Record<keyof ChunkMetadata, string>>,
    topK?: number
  ): Promise<ChunkDocument[]>;
}

/** LLM 生成引擎 API */
export interface LLMEngineApi {
  queryRouter(query: string): Promise<RouteType>;
  queryRewrite(query: string): Promise<string>;
  generateListAnswer(query: string, contextDocs: ChunkDocument[]): { content: string; isList: true };
  generateBasicAnswerStream(
    query: string,
    contextDocs: ChunkDocument[],
    history?: Array<{ role: string; content: string }>
  ): AsyncGenerator<string>;
  generateStepByStepAnswerStream(
    query: string,
    contextDocs: ChunkDocument[],
    history?: Array<{ role: string; content: string }>
  ): AsyncGenerator<string>;
}

/** RAG 系统 API */
export interface RAGSystem {
  initializeSystem(): void;
  buildKnowledgeBase(forceRebuild?: boolean): Promise<void>;
  askQuestion(
    question: string,
    history?: Array<{ role: string; content: string }>
  ): Promise<{
    sources: SourceDoc[];
    routeType: RouteType;
    stream: AsyncGenerator<string>;
  }>;
  getStats(): KnowledgeBaseStats | null;
  isReady(): boolean;
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
