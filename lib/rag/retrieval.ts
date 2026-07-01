import { BM25Retriever } from "@langchain/community/retrievers/bm25";
import type { Document } from "@langchain/core/documents";
import type { ChunkDocument, ChunkMetadata, RetrievalEngineApi, RankedDocList, QueryKeywords } from "./types";
import { md5 } from "../utils";

/** 向量存储接口（duck typing，只需有 similaritySearch 方法） */
interface VectorStoreLike {
  similaritySearch(query: string, k?: number): Promise<Document[]>;
}

/** 中文烹饪场景停用词表 */
const CHINESE_STOP_WORDS = new Set([
  "的", "了", "和", "是", "在", "有", "我", "都", "个", "与", "也", "对", "为", "能", "很", "可以", "就", "不", "会", "要", "没有", "我们", "这", "那", "上", "他", "而", "及", "与", "或",
  "一个", "没有", "根据", "进行", "使用", "需要", "以及", "但是", "因为", "所以", "如果", "那么", "如何", "怎样", "什么", "哪些", "一下",
  "做法", "制作", "步骤", "怎么", "推荐", "介绍", "查询",
]);

/**
 * 分词并去除中文停用词（简单按字符切分，适合中文短文本）
 */
function tokenizeChinese(text: string): string[] {
  return text
    .split(/\s+/)
    .flatMap((token) => {
      // 对无空格中文按字符切分
      if (/^[\u4e00-\u9fa5]+$/.test(token)) {
        return token.split("");
      }
      return [token];
    })
    .filter((char) => char.length > 0 && !CHINESE_STOP_WORDS.has(char));
}

/**
 * 预处理文档文本，用于 BM25 构建
 */
function preprocessForBM25(text: string): string {
  return tokenizeChinese(text.toLowerCase()).join(" ");
}

/**
 * 检索优化模块（对应原 Python retrieval_optimization.py）
 * 负责：向量+BM25 混合检索、RRF 重排、元数据过滤、双层关键词检索
 *
 * 已重构为工厂函数 + 闭包，不再使用 class/this。
 */
export function createRetrievalEngine(
  vectorstore: VectorStoreLike,
  chunks: ChunkDocument[],
  options: {
    extractKeywords?: (query: string) => Promise<QueryKeywords>;
  } = {}
): RetrievalEngineApi {
  // 预处理 chunk 文本，过滤中文停用词后构建 BM25 检索器
  const preprocessedChunks = chunks.map((chunk) => ({
    ...chunk,
    pageContent: preprocessForBM25(chunk.pageContent),
  })) as ChunkDocument[];

  const bm25Retriever = BM25Retriever.fromDocuments(preprocessedChunks, {
    k: 10,
    includeScore: true,
  });
  console.log("[Retrieval] 检索器设置完成");

  /**
   * 混合检索 - 结合向量检索和 BM25 检索，使用 RRF 重排
   * 对应原 Python hybrid_search
   */
  async function hybridSearch(query: string, topK: number = 3): Promise<ChunkDocument[]> {
    const preprocessedQuery = preprocessForBM25(query);

    // 向量检索
    const vectorDocs = (await vectorstore.similaritySearch(query, topK * 2)) as ChunkDocument[];

    // BM25 检索（使用停用词过滤后的查询）
    const bm25Docs = (await bm25Retriever.invoke(preprocessedQuery)) as ChunkDocument[];

    const rankedLists: RankedDocList[] = [
      { source: "vector", docs: vectorDocs },
      { source: "bm25", docs: bm25Docs },
    ];

    // RRF 融合
    const rerankedDocs = _rrfMerge(rankedLists, topK);
    return rerankedDocs;
  }

  /**
   * 增强搜索：向量 + 双层关键词 BM25 检索，进入通用 RRF 融合
   */
  async function enhancedSearch(query: string, topK: number = 3): Promise<ChunkDocument[]> {
    const vectorDocs = (await vectorstore.similaritySearch(query, topK * 2)) as ChunkDocument[];
    const rankedLists: RankedDocList[] = [{ source: "vector", docs: vectorDocs }];

    if (options.extractKeywords) {
      try {
        const keywords = await options.extractKeywords(query);

        if (keywords.entityKeywords.length > 0) {
          const entityQuery = preprocessForBM25(keywords.entityKeywords.join(" "));
          const entityDocs = (await bm25Retriever.invoke(entityQuery)) as ChunkDocument[];
          rankedLists.push({ source: "entity_keywords", docs: entityDocs });
        }

        if (keywords.topicKeywords.length > 0) {
          const topicQuery = preprocessForBM25(keywords.topicKeywords.join(" "));
          const topicDocs = (await bm25Retriever.invoke(topicQuery)) as ChunkDocument[];
          rankedLists.push({ source: "topic_keywords", docs: topicDocs });
        }
      } catch (error) {
        console.warn("[Retrieval] 双层关键词提取失败，回退到基础 BM25:", error);
        const basicBm25Docs = (await bm25Retriever.invoke(preprocessForBM25(query))) as ChunkDocument[];
        rankedLists.push({ source: "bm25", docs: basicBm25Docs });
      }
    } else {
      const basicBm25Docs = (await bm25Retriever.invoke(preprocessForBM25(query))) as ChunkDocument[];
      rankedLists.push({ source: "bm25", docs: basicBm25Docs });
    }

    return _rrfMerge(rankedLists, topK);
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
   * 通用 RRF (Reciprocal Rank Fusion) 融合算法
   * 支持多路来源标记、parent_id 优先去重、chunk 命中统计
   *
   * 公式: score = 1 / (k + rank + 1)
   * k=60 用于平滑排名
   */
  function _rrfMerge(rankedLists: RankedDocList[], topK: number = 3, k: number = 60): ChunkDocument[] {
    // docKey -> 合并记录
    const docRecords: Record<
      string,
      {
        doc: ChunkDocument;
        bestRank: number;
        sources: Set<string>;
        ranks: Record<string, number>;
        hits: number;
      }
    > = {};

    for (const list of rankedLists) {
      for (let rank = 0; rank < list.docs.length; rank++) {
        const doc = list.docs[rank];

        // 过滤 BM25 分数 <= 0 的结果（兼容 BM25Retriever 的 bm25Score 字段）
        const bm25Score = (doc.metadata as Record<string, unknown>).bm25Score as number | undefined;
        if (bm25Score !== undefined && bm25Score <= 0) {
          continue;
        }
        // 同时记录到 metadata
        if (bm25Score !== undefined) {
          (doc.metadata as Record<string, unknown>).bm25_score = bm25Score;
        }

        // 去重 key：parent_id 优先，pageContent hash 兜底
        const dedupKey = doc.metadata.parent_id || md5(doc.pageContent);

        if (!docRecords[dedupKey]) {
          docRecords[dedupKey] = {
            doc,
            bestRank: rank,
            sources: new Set(),
            ranks: {},
            hits: 0,
          };
        }

        const record = docRecords[dedupKey];
        record.sources.add(list.source);
        record.ranks[list.source] = Math.min(record.ranks[list.source] ?? Number.MAX_SAFE_INTEGER, rank);
        record.bestRank = Math.min(record.bestRank, rank);
        record.hits += 1;
      }
    }

    // 计算 RRF 分数并排序
    const scoredDocs = Object.values(docRecords).map((record) => {
      let rrfScore = 0;
      for (const [source, rank] of Object.entries(record.ranks)) {
        const sourceScore = 1.0 / (k + rank + 1);
        rrfScore += sourceScore;
      }

      const doc = record.doc;
      doc.metadata.rrf_score = rrfScore;
      doc.metadata.rrf_sources = Array.from(record.sources);
      doc.metadata.rrf_ranks = record.ranks;
      doc.metadata.rrf_chunk_hits = record.hits;
      doc.metadata.final_score = rrfScore;
      doc.metadata.search_method = record.sources.has("graph_rag") ? "graph_rag" : "hybrid";

      return doc;
    });

    // 排序：RRF 分数 -> 全局最佳 rank -> 命中次数
    scoredDocs.sort((a, b) => {
      const scoreDiff = (b.metadata.rrf_score || 0) - (a.metadata.rrf_score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      const rankDiff = (a.metadata.rrf_ranks?.["vector"] ?? 999) - (b.metadata.rrf_ranks?.["vector"] ?? 999);
      if (rankDiff !== 0) return rankDiff;
      return (b.metadata.rrf_chunk_hits || 0) - (a.metadata.rrf_chunk_hits || 0);
    });

    console.log(
      `[Retrieval] RRF 重排完成: ${rankedLists.length} 路来源, 合并后 ${scoredDocs.length} 个, 返回前 ${topK} 个`
    );

    return scoredDocs.slice(0, topK);
  }

  return {
    hybridSearch,
    metadataFilteredSearch,
    enhancedSearch,
  };
}

