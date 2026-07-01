import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { OpenAIEmbeddings } from "@langchain/openai";
import type { Document } from "@langchain/core/documents";
import type { Embeddings } from "@langchain/core/embeddings";
import type { ChunkDocument, ChunkMetadata, IndexBuilderApi, VectorStoreApi, VectorStoreData } from "./types";
import { getProjectRoot } from "../utils";

/**
 * 简单的内存向量存储（替代 LangChain 1.x 移除的 MemoryVectorStore）
 * 使用余弦相似度进行搜索，适合中小规模数据（<10k 向量）
 *
 * 已重构为工厂函数 + 闭包，不再使用 class/this。
 */
export function createVectorStore(embeddings: Embeddings): VectorStoreApi {
  // vectors 与 documents 使用相同下标关联，不额外维护 ID 索引。
  let vectors: number[][] = [];
  let documents: Document[] = [];

  /**
   * 添加文档（批量向量化）
   */
  async function addDocuments(docs: Document[]): Promise<void> {
    const batch = 50;
    for (let i = 0; i < docs.length; i += batch) {
      // 批量调用 embedding 接口，避免一次性提交过多文本导致请求过大。
      const chunk = docs.slice(i, i + batch);
      const texts = chunk.map((d) => d.pageContent);
      const embeddingsResult = await embeddings.embedDocuments(texts);
      vectors.push(...embeddingsResult);
      documents.push(...chunk);
    }
  }

  /**
   * 从文档列表创建向量存储
   */
  async function fromDocuments(docs: Document[]): Promise<void> {
    await addDocuments(docs);
  }

  /**
   * 相似度搜索（余弦相似度）
   */
  async function similaritySearch(query: string, k: number = 4): Promise<Document[]> {
    const queryVector = await embeddings.embedQuery(query);

    // 逐条计算 query 与索引向量的余弦相似度，再按分数降序截断。
    const scores = vectors.map((vec, i) => ({
      index: i,
      score: cosineSimilarity(queryVector, vec),
    }));

    scores.sort((a, b) => b.score - a.score);

    return scores.slice(0, k).map((s) => documents[s.index]);
  }

  /**
   * 余弦相似度计算
   */
  function cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dotProduct / denom;
  }

  /**
   * 获取所有数据（用于持久化）
   */
  function getData(): { vectors: number[][]; documents: Document[] } {
    return { vectors, documents };
  }

  /**
   * 从数据恢复
   */
  function setData(data: { vectors: number[][]; documents: Document[] }): void {
    vectors = data.vectors;
    documents = data.documents;
  }

  return {
    fromDocuments,
    addDocuments,
    similaritySearch,
    getData,
    setData,
    get size() {
      return vectors.length;
    },
  };
}

/**
 * 索引构建模块（对应原 Python index_construction.py）
 * 负责：向量化和内存向量索引构建、JSON 持久化
 *
 * 已重构为工厂函数 + 纯函数，不再使用 class/this。
 */
export function createIndexBuilder(
  modelName: string,
  indexSavePath: string,
  apiKey: string,
  baseURL: string
): IndexBuilderApi {
  // LangChain OpenAI 客户端通过 baseURL 接入 AIHubMix 兼容接口。
  const embeddings = new OpenAIEmbeddings({
    model: modelName,
    apiKey,
    configuration: { baseURL },
  });

  /**
   * 构建向量索引
   */
  async function buildVectorIndex(chunks: ChunkDocument[]): Promise<VectorStoreApi> {
    console.log("[IndexConstruction] 正在构建向量索引...");

    if (chunks.length === 0) {
      throw new Error("文档块列表不能为空");
    }

    const vectorstore = createVectorStore(embeddings);
    await vectorstore.fromDocuments(chunks);

    console.log(
      `[IndexConstruction] 向量索引构建完成，包含 ${vectorstore.size} 个向量`
    );
    return vectorstore;
  }

  /**
   * 保存向量索引到 JSON 文件
   */
  async function saveIndex(vectorstore: VectorStoreApi): Promise<void> {
    const fullPath = join(getProjectRoot(), indexSavePath);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const { vectors, documents } = (vectorstore as ReturnType<typeof createVectorStore>).getData();

    const data: VectorStoreData = {
      vectors,
      documents: documents.map((doc) => ({
        pageContent: doc.pageContent,
        metadata: doc.metadata as ChunkMetadata,
      })),
      embeddingModel: modelName,
      createdAt: new Date().toISOString(),
    };

    writeFileSync(fullPath, JSON.stringify(data), "utf-8");
    console.log(`[IndexConstruction] 向量索引已保存到: ${indexSavePath}`);
  }

  /**
   * 从 JSON 文件加载向量索引
   * @returns 加载的向量存储，如果文件不存在返回 null
   */
  async function loadIndex(): Promise<VectorStoreApi | null> {
    const fullPath = join(getProjectRoot(), indexSavePath);

    if (!existsSync(fullPath)) {
      console.log(
        `[IndexConstruction] 索引文件不存在: ${indexSavePath}，将构建新索引`
      );
      return null;
    }

    try {
      const raw = readFileSync(fullPath, "utf-8");
      const data: VectorStoreData = JSON.parse(raw);

      // 从 JSON 恢复时不重新计算 embedding，直接装载已持久化的向量和文档。
      const vectorstore = createVectorStore(embeddings);
      vectorstore.setData({
        vectors: data.vectors,
        documents: data.documents.map((d) => ({
          pageContent: d.pageContent,
          metadata: d.metadata,
        })),
      });

      console.log(
        `[IndexConstruction] 向量索引已从 ${indexSavePath} 加载（${vectorstore.size} 个向量）`
      );
      return vectorstore;
    } catch (e) {
      console.warn(`[IndexConstruction] 加载向量索引失败:`, e);
      return null;
    }
  }

  /**
   * 相似度搜索
   */
  async function similaritySearch(vectorstore: VectorStoreApi, query: string, k: number = 5): Promise<ChunkDocument[]> {
    const results = await vectorstore.similaritySearch(query, k);
    return results as ChunkDocument[];
  }

  return {
    buildVectorIndex,
    saveIndex,
    loadIndex,
    similaritySearch,
  };
}
