/**
 * RAG 系统配置（对应原 Python 项目 config.py）
 */

/** 菜品分类映射：目录名 → 中文标签 */
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

/** 支持的分类标签列表 */
export const CATEGORY_LABELS = Array.from(new Set(Object.values(CATEGORY_MAPPING)));

/** 难度标签 */
export const DIFFICULTY_LABELS = [
  "非常简单",
  "简单",
  "中等",
  "困难",
  "非常困难",
] as const;

/** RAG 系统配置 */
export interface RAGConfig {
  /** 数据路径（相对于项目根目录） */
  dataPath: string;
  /** 索引保存路径 */
  indexSavePath: string;
  /** Embedding 模型名 */
  embeddingModel: string;
  /** LLM 模型名 */
  llmModel: string;
  /** 检索 top_k */
  topK: number;
  /** 生成温度 */
  temperature: number;
  /** 最大 token 数 */
  maxTokens: number;
  /** API Key */
  apiKey: string;
  /** API Base URL */
  baseURL: string;
  /** 多轮对话保留的历史轮数 */
  maxHistoryRounds: number;
}

/** 从环境变量读取配置 */
export function loadConfig(): RAGConfig {
  const apiKey = process.env.AIHUBMIX_API_KEY;
  if (!apiKey) {
    throw new Error("请设置 AIHUBMIX_API_KEY 环境变量");
  }

  return {
    dataPath: process.env.RAG_DATA_PATH || "data/dishes",
    indexSavePath: process.env.RAG_INDEX_PATH || ".data/vector-store.json",
    embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
    llmModel: process.env.CHAT_MODEL || "gpt-4o-mini",
    topK: parseInt(process.env.TOP_K || "3", 10),
    temperature: parseFloat(process.env.TEMPERATURE || "0.1"),
    maxTokens: parseInt(process.env.MAX_TOKENS || "2048", 10),
    apiKey,
    baseURL: process.env.AIHUBMIX_BASE_URL || "https://aihubmix.com/v1",
    maxHistoryRounds: 6,
  };
}
