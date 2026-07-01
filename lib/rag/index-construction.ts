import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { Document } from "@langchain/core/documents";
import type { Embeddings } from "@langchain/core/embeddings";
import { OpenAIEmbeddings } from "@langchain/openai";
import type {
  ChunkDocument,
  ChunkMetadata,
  IndexBuilderApi,
  VectorStoreApi,
  VectorStoreData,
} from "./types";
import { getProjectRoot, createLogger } from "../utils";

const log = createLogger("IndexConstruction");

/**
 * 简单的内存向量存储。
 *
 * LangChain.js 1.x 不再提供旧版 MemoryVectorStore，这里实现项目所需的最小能力：
 * - 批量把文档转成 embedding 向量。
 * - 查询时把问题转成向量。
 * - 使用余弦相似度排序，返回最相近的文档。
 *
 * 它适合当前 323 道菜谱这种中小规模数据；如果数据量上万，应替换成专业向量库。
 */
export function createVectorStore(embeddings: Embeddings): VectorStoreApi {
  let vectors: number[][] = [];
  let documents: Document[] = [];

  /**
   * 添加文档并批量向量化。
   *
   * batch=50 是为了避免一次请求文本过多导致 Embedding API 超限，也能减少请求次数。
   */
  async function addDocuments(docs: Document[]): Promise<void> {
    const batch = 50;
    for (let i = 0; i < docs.length; i += batch) {
      const chunk = docs.slice(i, i + batch);
      const texts = chunk.map((doc) => doc.pageContent);
      const embeddingsResult = await embeddings.embedDocuments(texts);
      vectors.push(...embeddingsResult);
      documents.push(...chunk);
    }
  }

  /** 从文档列表创建向量存储，本质上就是批量 addDocuments。 */
  async function fromDocuments(docs: Document[]): Promise<void> {
    await addDocuments(docs);
  }

  /**
   * 相似度搜索。
   *
   * query 先被向量化，然后和每个文档向量计算余弦相似度，分数越高语义越接近。
   */
  async function similaritySearch(
    query: string,
    k: number = 4
  ): Promise<Document[]> {
    const queryVector = await embeddings.embedQuery(query);

    const scores = vectors.map((vec, index) => ({
      index,
      score: cosineSimilarity(queryVector, vec),
    }));

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, k).map((score) => documents[score.index]);
  }

  /**
   * 余弦相似度。
   *
   * 取值范围通常在 -1 到 1 之间，越接近 1 表示两个向量方向越一致。
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

  /** 获取完整内存数据，用于写入 JSON 缓存。 */
  function getData(): { vectors: number[][]; documents: Document[] } {
    return { vectors, documents };
  }

  /** 从 JSON 缓存恢复内存数据，避免每次启动都重新调用 Embedding API。 */
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
 * 索引构建模块（对应原 Python index_construction.py）。
 *
 * 负责把 data-preparation 产出的 child chunks 转成向量索引，并把索引保存到本地。
 * 这样首次构建较慢，后续启动可以直接从 .data/vector-store.json 加载。
 */
export function createIndexBuilder(
  modelName: string,
  indexSavePath: string,
  apiKey: string,
  baseURL: string
): IndexBuilderApi {
  const embeddings = new OpenAIEmbeddings({
    model: modelName,
    apiKey,
    configuration: { baseURL },
  });

  // 缓存传入的 chunks，供 saveIndex 持久化
  let cachedChunks: ChunkDocument[] = [];

  /** 构建向量索引，输入必须是已经切分好的 child chunks。 */
  async function buildVectorIndex(
    chunks: ChunkDocument[]
  ): Promise<VectorStoreApi> {
    log.info("正在构建向量索引...");

    if (chunks.length === 0) {
      throw new Error("文档块列表不能为空");
    }

    cachedChunks = chunks;
    const vectorstore = createVectorStore(embeddings);
    await vectorstore.fromDocuments(chunks);

    log.info(
      `向量索引构建完成，包含 ${vectorstore.size} 个向量`
    );
    return vectorstore;
  }

  /**
   * 保存向量索引到 JSON 文件。
   *
   * 同时持久化 chunks 元数据，后续加载时可跳过文档分块步骤。
   */
  async function saveIndex(vectorstore: VectorStoreApi): Promise<void> {
    const fullPath = join(getProjectRoot(), indexSavePath);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const { vectors, documents } = vectorstore.getData();
    const data: VectorStoreData = {
      vectors,
      documents: documents.map((doc) => ({
        pageContent: doc.pageContent,
        metadata: doc.metadata as ChunkMetadata,
      })),
      embeddingModel: modelName,
      createdAt: new Date().toISOString(),
      chunks: cachedChunks.map((chunk) => ({
        pageContent: chunk.pageContent,
        metadata: chunk.metadata,
      })),
    };

    writeFileSync(fullPath, JSON.stringify(data), "utf-8");
    log.info(`向量索引已保存到: ${indexSavePath}`);
  }

  /**
   * 从 JSON 文件加载向量索引。
   *
   * 如果文件不存在或解析失败，返回 null，让上层决定是否重建索引。
   * 成功加载时会同时恢复 chunks 到 cachedChunks，供 buildKnowledgeBase 使用。
   */
  async function loadIndex(): Promise<VectorStoreApi | null> {
    const fullPath = join(getProjectRoot(), indexSavePath);

    if (!existsSync(fullPath)) {
      log.info(
        `索引文件不存在: ${indexSavePath}，将构建新索引`
      );
      return null;
    }

    try {
      const raw = readFileSync(fullPath, "utf-8");
      const data: VectorStoreData = JSON.parse(raw);
      const vectorstore = createVectorStore(embeddings);

      vectorstore.setData({
        vectors: data.vectors,
        documents: data.documents.map((doc) => ({
          pageContent: doc.pageContent,
          metadata: doc.metadata,
        })),
      });

      // 恢复缓存的 chunks，避免重复分块
      if (data.chunks && data.chunks.length > 0) {
        cachedChunks = data.chunks.map((chunk) => ({
          pageContent: chunk.pageContent,
          metadata: chunk.metadata,
        })) as ChunkDocument[];
        log.info(
          `从缓存恢复了 ${cachedChunks.length} 个 chunks`
        );
      }

      log.info(
        `向量索引已从 ${indexSavePath} 加载（${vectorstore.size} 个向量）`
      );
      return vectorstore;
    } catch (e) {
      log.warn("加载向量索引失败:", e);
      return null;
    }
  }

  /** 获取缓存的 chunks（从索引恢复或构建时设置）。 */
  function getCachedChunks(): ChunkDocument[] {
    return cachedChunks;
  }

  /** 对外暴露统一的相似度搜索接口，隐藏底层向量库实现。 */
  async function similaritySearch(
    vectorstore: VectorStoreApi,
    query: string,
    k: number = 5
  ): Promise<ChunkDocument[]> {
    const results = await vectorstore.similaritySearch(query, k);
    return results as ChunkDocument[];
  }

  return {
    buildVectorIndex,
    saveIndex,
    loadIndex,
    similaritySearch,
    getCachedChunks,
  };
}
