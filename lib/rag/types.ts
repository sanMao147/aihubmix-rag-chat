import type { Document } from "@langchain/core/documents";

/**
 * 文档元数据。
 *
 * parent 文档代表一整篇菜谱 Markdown，child 文档代表按标题切出来的局部片段。
 * 检索阶段主要命中 child，生成阶段再回溯 parent，以保证回答拿到完整食谱上下文。
 */
export interface ChunkMetadata {
  /** 原始 Markdown 文件的绝对路径。 */
  source: string;
  /** 父文档稳定 ID，由文件相对路径 MD5 得到。 */
  parent_id: string;
  /** 文档类型：parent 是整篇菜谱，child 是切分后的片段。 */
  doc_type: "parent" | "child";
  /** 菜品分类，例如“荤菜”“素菜”“汤品”。 */
  category: string;
  /** 菜品名称，默认来自 Markdown 文件名。 */
  dish_name: string;
  /** 难度标签，由 Markdown 中的星级推断。 */
  difficulty: string;
  /** 子块唯一 ID，仅 child 文档有。 */
  chunk_id?: string;
  /** 当前子块在父文档内的序号。 */
  chunk_index?: number;
  /** 当前子块在全部子块数组中的全局序号。 */
  batch_index?: number;
  /** 子块字符长度，用于统计平均 chunk 大小。 */
  chunk_size?: number;
  /** RRF 混合重排后的相关性分数。 */
  rrf_score?: number;
  /** Markdown 标题路径，如 "可乐鸡翅的做法 > 必备原料和工具" */
  header_path?: string;
}

/** 带菜谱元数据的 LangChain Document 类型。 */
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

/** 来源文档信息（展示给用户），从 ChunkMetadata 中提取安全、简洁的字段。 */
export interface SourceDoc {
  dish_name: string;
  category: string;
  difficulty: string;
  rrf_score: number;
  source: string;
}

/** 查询路由类型：决定使用列表回答、分步回答还是普通回答。 */
export type RouteType = "list" | "detail" | "general";

/** 对话会话 */
export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/** 知识库统计信息，用于管理接口或页面展示。 */
export interface KnowledgeBaseStats {
  total_documents: number;
  total_chunks: number;
  categories: Record<string, number>;
  difficulties: Record<string, number>;
  avg_chunk_size: number;
}

/** 向量存储持久化数据结构，对应 .data/vector-store.json。 */
export interface VectorStoreData {
  vectors: number[][];
  documents: Array<{
    pageContent: string;
    metadata: ChunkMetadata;
  }>;
  embeddingModel: string;
  createdAt: string;
  /** 缓存 chunk 元数据列表，用于从索引恢复时跳过重复的文档加载和分块。 */
  chunks?: Array<{
    pageContent: string;
    metadata: ChunkMetadata;
  }>;
}

/**
 * 向量存储 API。
 *
 * 项目里使用自实现的内存向量库，但上层只依赖这个接口，
 * 后续可以替换成 FAISS、PGVector、Milvus 等外部向量库。
 */
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

/** 数据准备模块内部状态：保存原始文档、子块和子块到父文档的映射。 */
export interface DataPreparationState {
  documents: ChunkDocument[];
  chunks: ChunkDocument[];
  parentChildMap: Record<string, string>;
}

/** 索引构建器 API：负责构建、保存、加载和查询向量索引。 */
export interface IndexBuilderApi {
  buildVectorIndex(chunks: ChunkDocument[]): Promise<VectorStoreApi>;
  saveIndex(vectorstore: VectorStoreApi): Promise<void>;
  loadIndex(): Promise<VectorStoreApi | null>;
  similaritySearch(vectorstore: VectorStoreApi, query: string, k?: number): Promise<ChunkDocument[]>;
  /** 获取从缓存索引恢复的 chunks，用于跳过冗余的文档加载和分块。 */
  getCachedChunks(): ChunkDocument[];
}

/** 检索引擎 API：封装向量检索、BM25 检索、RRF 重排和元数据过滤。 */
export interface RetrievalEngineApi {
  hybridSearch(query: string, topK?: number): Promise<ChunkDocument[]>;
  metadataFilteredSearch(
    query: string,
    filters: Partial<Record<keyof ChunkMetadata, string>>,
    topK?: number
  ): Promise<ChunkDocument[]>;
}

/** LLM 生成引擎 API：封装查询理解和不同回答模式。 */
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

/** RAG 系统 API：对 route handler 暴露的主入口。 */
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

/** RAG 请求体。 */
export interface ChatRequestBody {
  query: string;
  history: Array<{ role: MessageRole; content: string }>;
}

/**
 * SSE 事件数据。
 *
 * /api/chat 使用 Server-Sent Events 分多次返回：
 * sources 先返回引用来源，token 持续返回模型增量文本，done 表示结束。
 */
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
