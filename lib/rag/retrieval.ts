import { BM25Retriever } from "@langchain/community/retrievers/bm25";
import type { Document } from "@langchain/core/documents";
import type { ChunkDocument, ChunkMetadata, RetrievalEngineApi } from "./types";
import { md5 } from "../utils";

/** 向量存储接口（duck typing，只需有 similaritySearch 方法） */
interface VectorStoreLike {
  similaritySearch(query: string, k?: number): Promise<Document[]>;
}

/**
 * 检索优化模块（对应原 Python retrieval_optimization.py）
 * 负责：向量+BM25 混合检索、RRF 重排、元数据过滤
 *
 * 已重构为工厂函数 + 闭包，不再使用 class/this。
 */
export function createRetrievalEngine(
  vectorstore: VectorStoreLike,
  chunks: ChunkDocument[]
): RetrievalEngineApi {
  const bm25Retriever = BM25Retriever.fromDocuments(chunks, { k: 5 });
  console.log("[Retrieval] 检索器设置完成");

  /**
   * 混合检索 - 结合向量检索和 BM25 检索，使用 RRF 重排
   * 对应原 Python hybrid_search
   */
  async function hybridSearch(query: string, topK: number = 3): Promise<ChunkDocument[]> {
    // 向量检索
    const vectorDocs = (await vectorstore.similaritySearch(query, 5)) as ChunkDocument[];

    // BM25 检索
    const bm25Docs = (await bm25Retriever.invoke(query)) as ChunkDocument[];

    // RRF 重排
    const rerankedDocs = rrfRerank(vectorDocs, bm25Docs);
    return rerankedDocs.slice(0, topK);
  }

  /**
   * 带元数据过滤的检索
   * 对应原 Python metadata_filtered_search
   */
  async function metadataFilteredSearch(
    query: string,
    filters: Partial<Record<keyof ChunkMetadata, string>>,
    topK: number = 5
  ): Promise<ChunkDocument[]> {
    // 先混合检索，获取更多候选
    const docs = await hybridSearch(query, topK * 3);

    // 应用元数据过滤
    const filteredDocs: ChunkDocument[] = [];
    for (const doc of docs) {
      let match = true;
      for (const [key, value] of Object.entries(filters)) {
        const docValue = doc.metadata[key as keyof ChunkMetadata];
        if (docValue !== value) {
          match = false;
          break;
        }
      }
      if (match) {
        filteredDocs.push(doc);
        if (filteredDocs.length >= topK) break;
      }
    }

    return filteredDocs;
  }

  /**
   * RRF (Reciprocal Rank Fusion) 重排算法
   * 对应原 Python _rrf_rerank
   *
   * 公式: score = 1 / (k + rank + 1)
   * k=60 用于平滑排名
   */
  function rrfRerank(
    vectorDocs: ChunkDocument[],
    bm25Docs: ChunkDocument[],
    k: number = 60
  ): ChunkDocument[] {
    const docScores: Record<string, number> = {};
    const docObjects: Record<string, ChunkDocument> = {};

    // 计算向量检索结果的 RRF 分数
    vectorDocs.forEach((doc, rank) => {
      const docId = md5(doc.pageContent);
      docObjects[docId] = doc;
      const rrfScore = 1.0 / (k + rank + 1);
      docScores[docId] = (docScores[docId] || 0) + rrfScore;
    });

    // 计算 BM25 检索结果的 RRF 分数
    bm25Docs.forEach((doc, rank) => {
      const docId = md5(doc.pageContent);
      docObjects[docId] = doc;
      const rrfScore = 1.0 / (k + rank + 1);
      docScores[docId] = (docScores[docId] || 0) + rrfScore;
    });

    // 按最终 RRF 分数排序
    const sortedDocs = Object.entries(docScores)
      .sort(([, a], [, b]) => b - a)
      .map(([docId, finalScore]) => {
        const doc = docObjects[docId];
        // 将 RRF 分数添加到元数据
        doc.metadata.rrf_score = finalScore;
        return doc;
      });

    console.log(
      `[Retrieval] RRF 重排完成: 向量 ${vectorDocs.length} 个, BM25 ${bm25Docs.length} 个, 合并后 ${sortedDocs.length} 个`
    );

    return sortedDocs;
  }

  return {
    hybridSearch,
    metadataFilteredSearch,
  };
}
