import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { OpenAIEmbeddings } from "@langchain/openai";
import type { Document } from "@langchain/core/documents";
import type { Embeddings } from "@langchain/core/embeddings";
import type { ChunkDocument, ChunkMetadata, VectorStoreData } from "./types";
import { getProjectRoot } from "../utils";

/**
 * 简单的内存向量存储（替代 LangChain 1.x 移除的 MemoryVectorStore）
 * 使用余弦相似度进行搜索，适合中小规模数据（<10k 向量）
 */
class SimpleMemoryVectorStore {
  private vectors: number[][] = [];
  private documents: Document[] = [];
  private embeddings: Embeddings;

  constructor(embeddings: Embeddings) {
    this.embeddings = embeddings;
  }

  /**
   * 从文档列表创建向量存储
   */
  static async fromDocuments(
    docs: Document[],
    embeddings: Embeddings
  ): Promise<SimpleMemoryVectorStore> {
    const store = new SimpleMemoryVectorStore(embeddings);
    await store.addDocuments(docs);
    return store;
  }

  /**
   * 添加文档（批量向量化）
   */
  async addDocuments(docs: Document[]): Promise<void> {
    const batch = 50;
    for (let i = 0; i < docs.length; i += batch) {
      const chunk = docs.slice(i, i + batch);
      const texts = chunk.map((d) => d.pageContent);
      const vectors = await this.embeddings.embedDocuments(texts);
      this.vectors.push(...vectors);
      this.documents.push(...chunk);
    }
  }

  /**
   * 相似度搜索（余弦相似度）
   */
  async similaritySearch(query: string, k: number = 4): Promise<Document[]> {
    const queryVector = await this.embeddings.embedQuery(query);

    const scores = this.vectors.map((vec, i) => ({
      index: i,
      score: this.cosineSimilarity(queryVector, vec),
    }));

    scores.sort((a, b) => b.score - a.score);

    return scores.slice(0, k).map((s) => this.documents[s.index]);
  }

  /**
   * 余弦相似度计算
   */
  private cosineSimilarity(a: number[], b: number[]): number {
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
  getData(): { vectors: number[][]; documents: Document[] } {
    return { vectors: this.vectors, documents: this.documents };
  }

  /**
   * 从数据恢复
   */
  static fromData(
    data: { vectors: number[][]; documents: Document[] },
    embeddings: Embeddings
  ): SimpleMemoryVectorStore {
    const store = new SimpleMemoryVectorStore(embeddings);
    store.vectors = data.vectors;
    store.documents = data.documents;
    return store;
  }

  /** 向量数量 */
  get size(): number {
    return this.vectors.length;
  }
}

/**
 * 索引构建模块（对应原 Python index_construction.py）
 * 负责：向量化和内存向量索引构建、JSON 持久化
 */
export class IndexConstructionModule {
  private embeddings: OpenAIEmbeddings;
  private vectorstore: SimpleMemoryVectorStore | null = null;

  constructor(
    private modelName: string,
    private indexSavePath: string,
    apiKey: string,
    baseURL: string
  ) {
    this.embeddings = new OpenAIEmbeddings({
      model: modelName,
      apiKey,
      configuration: { baseURL },
    });
  }

  /**
   * 构建向量索引
   */
  async buildVectorIndex(chunks: ChunkDocument[]): Promise<SimpleMemoryVectorStore> {
    console.log("[IndexConstruction] 正在构建向量索引...");

    if (chunks.length === 0) {
      throw new Error("文档块列表不能为空");
    }

    this.vectorstore = await SimpleMemoryVectorStore.fromDocuments(
      chunks,
      this.embeddings
    );

    console.log(
      `[IndexConstruction] 向量索引构建完成，包含 ${this.vectorstore.size} 个向量`
    );
    return this.vectorstore;
  }

  /**
   * 保存向量索引到 JSON 文件
   */
  async saveIndex(): Promise<void> {
    if (!this.vectorstore) {
      throw new Error("请先构建向量索引");
    }

    const fullPath = join(getProjectRoot(), this.indexSavePath);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const { vectors, documents } = this.vectorstore.getData();

    const data: VectorStoreData = {
      vectors,
      documents: documents.map((doc) => ({
        pageContent: doc.pageContent,
        metadata: doc.metadata as ChunkMetadata,
      })),
      embeddingModel: this.modelName,
      createdAt: new Date().toISOString(),
    };

    writeFileSync(fullPath, JSON.stringify(data), "utf-8");
    console.log(`[IndexConstruction] 向量索引已保存到: ${this.indexSavePath}`);
  }

  /**
   * 从 JSON 文件加载向量索引
   * @returns 加载的向量存储，如果文件不存在返回 null
   */
  async loadIndex(): Promise<SimpleMemoryVectorStore | null> {
    const fullPath = join(getProjectRoot(), this.indexSavePath);

    if (!existsSync(fullPath)) {
      console.log(
        `[IndexConstruction] 索引文件不存在: ${this.indexSavePath}，将构建新索引`
      );
      return null;
    }

    try {
      const raw = readFileSync(fullPath, "utf-8");
      const data: VectorStoreData = JSON.parse(raw);

      this.vectorstore = SimpleMemoryVectorStore.fromData(
        {
          vectors: data.vectors,
          documents: data.documents.map((d) => ({
            pageContent: d.pageContent,
            metadata: d.metadata,
          })),
        },
        this.embeddings
      );

      console.log(
        `[IndexConstruction] 向量索引已从 ${this.indexSavePath} 加载（${this.vectorstore.size} 个向量）`
      );
      return this.vectorstore;
    } catch (e) {
      console.warn(`[IndexConstruction] 加载向量索引失败:`, e);
      return null;
    }
  }

  /**
   * 相似度搜索
   */
  async similaritySearch(query: string, k: number = 5): Promise<ChunkDocument[]> {
    if (!this.vectorstore) {
      throw new Error("请先构建或加载向量索引");
    }

    const results = await this.vectorstore.similaritySearch(query, k);
    return results as ChunkDocument[];
  }
}
