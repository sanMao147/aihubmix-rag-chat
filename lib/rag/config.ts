/**
 * RAG 系统配置（对应原 Python 项目 config.py）。
 *
 * 这个文件集中管理“可配置项”和“固定标签映射”：
 * - 分类/难度标签用于元数据抽取和用户问题过滤。
 * - loadConfig 从环境变量读取模型、路径和生成参数。
 */

/** 菜品分类映射：数据目录名 → 页面和检索过滤使用的中文标签。 */
export const CATEGORY_MAPPING: Record<string, string> = {
  meat_dish: "荤菜",
  vegetable_dish: "素菜",
  soup: "汤品",
  dessert: "甜品",
  breakfast: "早餐",
  staple: "主食",
  aquatic: "水产",
  condiment: "调料",
  drink: "饮品",
  "semi-finished": "半成品",
};

/** 支持的分类标签列表，去重后供查询过滤逻辑使用。 */
export const CATEGORY_LABELS = Array.from(
  new Set(Object.values(CATEGORY_MAPPING))
);

/** 难度标签。顺序从易到难，与菜谱 Markdown 中的星级数量对应。 */
export const DIFFICULTY_LABELS = [
  "非常简单",
  "简单",
  "中等",
  "困难",
  "非常困难",
] as const;

/** RAG 系统运行时配置。 */
export interface RAGConfig {
  /** 菜谱 Markdown 数据路径（相对于项目根目录）。 */
  dataPath: string;
  /** 向量索引 JSON 缓存路径（相对于项目根目录）。 */
  indexSavePath: string;
  /** 是否在缓存不存在时自动构建向量索引。关闭时使用 BM25 本地检索快速启动。 */
  autoBuildVectorIndex: boolean;
  /** Embedding 模型名，用于把文本块转换成向量。 */
  embeddingModel: string;
  /** 聊天模型名，用于查询路由、查询重写和最终回答生成。 */
  llmModel: string;
  /** 最终返回给生成模块的检索文档数量。 */
  topK: number;
  /** 生成温度，越低越稳定，越高越发散。 */
  temperature: number;
  /** 单次回答允许生成的最大 token 数。 */
  maxTokens: number;
  /** AIHubMix 或兼容 OpenAI 服务的 API Key。 */
  apiKey: string;
  /** API Base URL，用于切换 AIHubMix、OpenAI 或其他兼容服务。 */
  baseURL: string;
  embeddingApiKey: string;
  embeddingBaseURL: string;
  /** 多轮对话保留的历史轮数。 */
  maxHistoryRounds: number;
}

/**
 * 从环境变量读取配置。
 *
 * API Key 是必需项，其余配置都有默认值，便于本地开发快速启动。
 */
export function loadConfig(): RAGConfig {
  const apiKey = process.env.AIHUBMIX_API_KEY;
  if (!apiKey) {
    throw new Error("请设置 AIHUBMIX_API_KEY 环境变量");
  }

  const baseURL = process.env.AIHUBMIX_BASE_URL || "https://aihubmix.com/v1";
  const embeddingBaseURL =
    process.env.EMBEDDING_BASE_URL || process.env.MODELSCOPE_BASE_URL || baseURL;
  const hasEmbeddingProviderOverride =
    Boolean(process.env.EMBEDDING_BASE_URL) ||
    Boolean(process.env.MODELSCOPE_BASE_URL);
  const embeddingApiKey =
    process.env.EMBEDDING_API_KEY ||
    process.env.MODELSCOPE_API_KEY ||
    (hasEmbeddingProviderOverride ? "" : apiKey);

  if (!embeddingApiKey) {
    throw new Error(
      "Please set EMBEDDING_API_KEY or MODELSCOPE_API_KEY when using EMBEDDING_BASE_URL/MODELSCOPE_BASE_URL"
    );
  }

  return {
    dataPath: process.env.RAG_DATA_PATH || "data/dishes",
    indexSavePath: process.env.RAG_INDEX_PATH || ".data/vector-store.json",
    autoBuildVectorIndex: process.env.RAG_AUTO_BUILD_VECTOR_INDEX !== "false",
    embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
    llmModel: process.env.CHAT_MODEL || "gpt-4o-mini",
    topK: parseInt(process.env.TOP_K || "3", 10),
    temperature: parseFloat(process.env.TEMPERATURE || "0.1"),
    maxTokens: parseInt(process.env.MAX_TOKENS || "2048", 10),
    apiKey,
    baseURL,
    embeddingApiKey,
    embeddingBaseURL,
    maxHistoryRounds: 6,
  };
}
