import { BM25Retriever } from "@langchain/community/retrievers/bm25";
import type { Document } from "@langchain/core/documents";
import type { ChunkDocument, ChunkMetadata, RetrievalEngineApi } from "./types";
import { createLogger } from "../utils";

const log = createLogger("Retrieval");

/** 向量存储接口：只要对象提供 similaritySearch，就可以接入检索引擎。 */
interface VectorStoreLike {
  similaritySearch(query: string, k?: number): Promise<Document[]>;
}

/**
 * 获取文档唯一标识：优先使用 chunk_id（更精确），不存在时回退到内容 MD5。
 */
function getDocId(doc: ChunkDocument): string {
  return doc.metadata.chunk_id || `${doc.metadata.source}:${doc.metadata.chunk_index ?? doc.pageContent.length}`;
}

/**
 * 检索优化模块（对应原 Python retrieval_optimization.py）。
 *
 * 这里把两类检索结果融合：
 * - 向量检索：擅长语义相似，例如“下饭菜”和“家常肉菜”。
 * - BM25：擅长关键词精确匹配，例如具体菜名、食材名。
 *
 * 两者结果再通过 RRF 重排，降低单一检索策略漏召回的风险。
 */
export function createRetrievalEngine(
  vectorstore: VectorStoreLike | null,
  chunks: ChunkDocument[]
): RetrievalEngineApi {
  const bm25Retriever = BM25Retriever.fromDocuments(chunks, { k: 5 });
  log.info(
    vectorstore
      ? "检索器设置完成"
      : "检索器设置完成（Embedding 不可用，已降级为 BM25 检索）"
  );

  /**
   * 混合检索。
   *
   * 先分别取向量 Top5 和 BM25 Top5，再用 RRF 融合排名，最后截取 topK。
   */
  async function hybridSearch(
    query: string,
    topK: number = 3
  ): Promise<ChunkDocument[]> {
    const vectorDocs = vectorstore
      ? ((await vectorstore.similaritySearch(query, 5)) as ChunkDocument[])
      : [];
    const bm25Docs = (await bm25Retriever.invoke(query)) as ChunkDocument[];
    const rerankedDocs = rrfRerank(vectorDocs, bm25Docs);
    return rerankedDocs.slice(0, topK);
  }

  /**
   * 带元数据过滤的检索。
   *
   * 先扩大候选集，再按 category / difficulty 等字段过滤，避免过滤后结果太少。
   */
  async function metadataFilteredSearch(
    query: string,
    filters: Partial<Record<keyof ChunkMetadata, string>>,
    topK: number = 5
  ): Promise<ChunkDocument[]> {
    const docs = await hybridSearch(query, topK * 3);
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

    if (filteredDocs.length > 0) {
      return filteredDocs;
    }

    const fallbackDocs = chunks.filter((doc) =>
      Object.entries(filters).every(([key, value]) => {
        const docValue = doc.metadata[key as keyof ChunkMetadata];
        return docValue === value;
      })
    );

    return fallbackDocs.slice(0, topK);
  }

  /**
   * RRF (Reciprocal Rank Fusion) 重排算法。
   *
   * 公式：score = 1 / (k + rank + 1)
   * rank 越靠前，贡献越高；k=60 用于平滑，避免某一路检索的第一名过度压制其他结果。
   */
  function rrfRerank(
    vectorDocs: ChunkDocument[],
    bm25Docs: ChunkDocument[],
    k: number = 60
  ): ChunkDocument[] {
    const docScores: Record<string, number> = {};
    const docObjects: Record<string, ChunkDocument> = {};

    vectorDocs.forEach((doc, rank) => {
      const docId = getDocId(doc);
      docObjects[docId] = doc;
      const rrfScore = 1 / (k + rank + 1);
      docScores[docId] = (docScores[docId] || 0) + rrfScore;
    });

    bm25Docs.forEach((doc, rank) => {
      const docId = getDocId(doc);
      docObjects[docId] = doc;
      const rrfScore = 1 / (k + rank + 1);
      docScores[docId] = (docScores[docId] || 0) + rrfScore;
    });

    const sortedDocs = Object.entries(docScores)
      .sort(([, a], [, b]) => b - a)
      .map(([docId, finalScore]) => {
        const doc = docObjects[docId];
        doc.metadata.rrf_score = finalScore;
        return doc;
      });

    log.info(
      `RRF 重排完成: 向量 ${vectorDocs.length} 个, BM25 ${bm25Docs.length} 个, 合并后 ${sortedDocs.length} 个`
    );

    return sortedDocs;
  }

  return {
    hybridSearch,
    metadataFilteredSearch,
  };
}
