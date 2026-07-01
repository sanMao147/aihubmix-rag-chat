import type { Document } from "@langchain/core/documents";

/** 搜索策略 */
export type SearchStrategy = "hybrid_traditional" | "graph_rag" | "combined";

/** 查询分析结果（对应 C9 QueryAnalysis） */
export interface QueryAnalysis {
  queryComplexity: number;
  relationshipIntensity: number;
  reasoningRequired: boolean;
  entityCount: number;
  recommendedStrategy: SearchStrategy;
  confidence: number;
  reasoning: string;
}

/** 图查询意图类型 */
export type GraphQueryType = "entity_relation" | "multi_hop" | "subgraph" | "path_finding" | "clustering";

/** 图查询意图 */
export interface GraphQuery {
  queryType: GraphQueryType;
  sourceEntities: string[];
  targetEntities: string[];
  relationTypes: string[];
  maxDepth: number;
  maxNodes: number;
  constraints: Record<string, unknown>;
}

/** 图路径 */
export interface GraphPath {
  nodes: { id: string; type: string; name: string; properties: Record<string, unknown> }[];
  relationships: { type: string; source: { id: string; name: string }; target: { id: string; name: string }; signature: string; themes: string[] }[];
  length: number;
  score: number;
}

/** 知识子图 */
export interface KnowledgeSubgraph {
  nodes: { id: string; type: string; name: string; properties: Record<string, unknown> }[];
  relations: { type: string; source: { id: string; name: string }; target: { id: string; name: string }; signature: string; themes: string[] }[];
  density: number;
  reasoning: string;
}

/** 双层关键词提取结果 */
export interface QueryKeywords {
  entityKeywords: string[];
  topicKeywords: string[];
}

/** 增强 RRF 融合的 ranked list 输入 */
export interface RankedDocList {
  source: string;
  docs: ChunkDocument[];
}

/** 图节点 */
export interface GraphNode {
  id: string;
  type: "Recipe" | "Ingredient" | "CookingStep" | "Category";
  name: string;
  properties: Record<string, unknown>;
}

/** 图关系 */
export interface GraphRelation {
  type: string;
  source: GraphNode;
  target: GraphNode;
  signature: string;
  themes: string[];
}

/** 文档元数据 */
export interface ChunkMetadata {
  /** 原始文件路径，用于来源展示和排查命中文档 */
  source: string;
  /** 父文档稳定 ID，同一食谱文件的所有子块共享该 ID */
  parent_id: string;
  /** parent 表示整篇食谱，child 表示按 Markdown 结构切出的片段 */
  doc_type: "parent" | "child";
  /** 菜品分类，如荤菜、素菜、汤品 */
  category: string;
  /** 菜品名称，通常来自 Markdown 文件名 */
  dish_name: string;
  /** 难度标签，来自原文星级解析 */
  difficulty: string;
  /** 子块 ID，仅 child 文档存在 */
  chunk_id?: string;
  /** 子块在父文档内的顺序 */
  chunk_index?: number;
  /** 子块在全量 chunks 中的顺序，便于调试和持久化 */
  batch_index?: number;
  /** 子块文本长度，用于统计平均 chunk 大小 */
  chunk_size?: number;
  /** RRF 重排后的融合分数 */
  rrf_score?: number;
  /** Markdown 标题路径，如 "可乐鸡翅的做法 > 必备原料和工具" */
  header_path?: string;
  /** 检索来源标记，如 vector/bm25/graph_rag */
  search_method?: string;
  /** 检索层级，如 entity/topic/path/subgraph */
  retrieval_level?: string;
  /** 多路 RRF 来源 */
  rrf_sources?: string[];
  /** 各来源中的排名 */
  rrf_ranks?: Record<string, number>;
  /** chunk 命中次数 */
  rrf_chunk_hits?: number;
  /** 最终融合分数 */
  final_score?: number;
  /** BM25 分数 */
  bm25_score?: number;
  /** 查询路由策略 */
  route_strategy?: SearchStrategy;
  /** 查询复杂度 */
  query_complexity?: number;
  /** 路由置信度 */
  route_confidence?: number;
  /** 路径长度（图 RAG） */
  path_length?: number;
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
  /** 前端来源卡片展示的菜品名称 */
  dish_name: string;
  /** 前端来源卡片展示的分类 */
  category: string;
  /** 前端来源卡片展示的难度 */
  difficulty: string;
  /** 检索阶段产生的相关性分数 */
  rrf_score: number;
  /** 原始文件路径 */
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
  /** 与 documents 一一对应的 embedding 向量 */
  vectors: number[][];
  /** 可序列化后的 LangChain 文档 */
  documents: Array<{
    pageContent: string;
    metadata: ChunkMetadata;
  }>;
  /** 生成索引时使用的 embedding 模型，便于后续兼容性检查 */
  embeddingModel: string;
  /** 索引创建时间 */
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
  /** 原始父文档列表 */
  documents: ChunkDocument[];
  /** Markdown 结构化切分后的子块列表 */
  chunks: ChunkDocument[];
  /** child chunk ID 到 parent document ID 的映射 */
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
  enhancedSearch(query: string, topK?: number): Promise<ChunkDocument[]>;
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
  analyzeQuery(query: string): Promise<QueryAnalysis>;
  extractQueryKeywords(query: string): Promise<QueryKeywords>;
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
