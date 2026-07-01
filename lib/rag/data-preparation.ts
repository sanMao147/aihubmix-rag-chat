import { readdirSync, readFileSync, statSync } from "fs";
import { join, parse, relative, sep } from "path";
import type {
  ChunkDocument,
  ChunkMetadata,
  DataPreparationState,
  KnowledgeBaseStats,
} from "./types";
import { CATEGORY_LABELS, CATEGORY_MAPPING, DIFFICULTY_LABELS } from "./config";
import { getProjectRoot, md5, uuid, createLogger } from "../utils";

const log = createLogger("DataPreparation");

/**
 * 数据准备模块（对应原 Python data_preparation.py）。
 *
 * RAG 的第一步是把原始知识库转换成适合检索的数据结构：
 * 1. 递归读取 data/dishes 下的 Markdown 菜谱。
 * 2. 根据目录、文件名、星级补充 category / dish_name / difficulty。
 * 3. 按 Markdown 标题切成 child chunks，降低检索噪声。
 * 4. 保存 child → parent 映射，命中片段后能回到完整菜谱。
 *
 * 这里使用工厂函数 + 闭包状态，不使用 class/this，方便在服务端单例中组合。
 */
export function createDataPreparation(dataPath: string) {
  const state: DataPreparationState = {
    documents: [],
    chunks: [],
    parentChildMap: {},
  };

  /**
   * 加载所有 Markdown 文档。
   *
   * 每个 Markdown 文件先作为 parent 文档保存。parent_id 使用相对路径 MD5，
   * 因此只要文件路径不变，重启或重建索引后 ID 也保持一致。
   */
  function loadDocuments(): ChunkDocument[] {
    log.info(`正在从 ${dataPath} 加载文档...`);

    const fullPath = join(getProjectRoot(), dataPath);
    const documents: ChunkDocument[] = [];
    const mdFiles = findMarkdownFiles(fullPath);

    for (const mdFile of mdFiles) {
      try {
        const content = readFileSync(mdFile, "utf-8");
        const relativePath = relative(fullPath, mdFile).split(sep).join("/");
        const parentId = md5(relativePath || mdFile.split(sep).join("/"));

        documents.push({
          pageContent: content,
          metadata: {
            source: mdFile,
            parent_id: parentId,
            doc_type: "parent",
            category: "其他",
            dish_name: "",
            difficulty: "未知",
          },
        });
      } catch (e) {
        log.warn(`读取文件 ${mdFile} 失败:`, e);
      }
    }

    for (const doc of documents) {
      enhanceMetadata(doc);
    }

    state.documents = documents;
    log.info(`成功加载 ${documents.length} 个文档`);
    return documents;
  }

  /**
   * 递归查找所有 .md 文件。
   *
   * 数据目录按菜品分类组织，必须递归扫描才能收集全部菜谱。
   */
  function findMarkdownFiles(dir: string): string[] {
    const results: string[] = [];

    const walk = (currentDir: string) => {
      const entries = readdirSync(currentDir);
      for (const entry of entries) {
        const fullPath = join(currentDir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else if (entry.endsWith(".md")) {
          results.push(fullPath);
        }
      }
    };

    walk(dir);
    return results;
  }

  /**
   * 增强文档元数据：提取分类、菜品名、难度。
   *
   * 分类来自路径中的目录名，菜品名来自文件名，难度来自正文中的星级标记。
   * 这些字段后续会用于检索过滤和来源展示。
   */
  function enhanceMetadata(doc: ChunkDocument): void {
    const filePath = doc.metadata.source;
    const pathParts = filePath.split(sep);

    doc.metadata.category = "其他";
    for (const [key, value] of Object.entries(CATEGORY_MAPPING)) {
      if (pathParts.includes(key)) {
        doc.metadata.category = value;
        break;
      }
    }

    doc.metadata.dish_name = parse(filePath).name;
    const content = doc.pageContent;

    if (content.includes("★★★★★")) {
      doc.metadata.difficulty = "非常困难";
    } else if (content.includes("★★★★")) {
      doc.metadata.difficulty = "困难";
    } else if (content.includes("★★★")) {
      doc.metadata.difficulty = "中等";
    } else if (content.includes("★★")) {
      doc.metadata.difficulty = "简单";
    } else if (content.includes("★")) {
      doc.metadata.difficulty = "非常简单";
    } else {
      doc.metadata.difficulty = "未知";
    }
  }

  /**
   * Markdown 结构感知分块。
   *
   * 普通固定长度分块可能把“食材”和“步骤”切散；按标题分块更符合菜谱结构。
   * 每个 child chunk 都会继承 parent 的菜品名、分类、难度等元数据。
   */
  function chunkDocuments(): ChunkDocument[] {
    log.info("正在进行 Markdown 结构感知分块...");

    if (state.documents.length === 0) {
      throw new Error("请先加载文档");
    }

    const allChunks: ChunkDocument[] = [];

    for (const doc of state.documents) {
      try {
        const mdChunks = markdownHeaderSplit(doc);
        const parentId = doc.metadata.parent_id;

        mdChunks.forEach((chunk, i) => {
          const childId = uuid();
          chunk.metadata = {
            ...doc.metadata,
            ...chunk.metadata,
            chunk_id: childId,
            parent_id: parentId,
            doc_type: "child",
            chunk_index: i,
            batch_index: allChunks.length,
            chunk_size: chunk.pageContent.length,
          };
          state.parentChildMap[childId] = parentId;
        });

        allChunks.push(...mdChunks);
      } catch (e) {
        log.warn(
          `文档 ${doc.metadata.dish_name} Markdown 分割失败:`,
          e
        );
        allChunks.push(doc);
      }
    }

    state.chunks = allChunks;
    log.info(
      `Markdown 分块完成，共生成 ${allChunks.length} 个 chunk`
    );
    return allChunks;
  }

  /**
   * Markdown 标题分割器（对应 Python MarkdownHeaderTextSplitter）。
   *
   * 只按 #/##/### 分割，strip_headers=false（保留标题）。
   * 保留标题能让 Embedding 和 LLM 同时看到当前片段所在章节，提高语义完整性。
   */
  function markdownHeaderSplit(doc: ChunkDocument): ChunkDocument[] {
    const content = doc.pageContent;
    const lines = content.split("\n");
    const headerRegex = /^(#{1,3})\s+(.+)$/;
    const headerStack: Array<{ level: number; text: string }> = [];
    const chunks: ChunkDocument[] = [];

    let currentLines: string[] = [];
    let hasContent = false;

    const flushChunk = () => {
      if (currentLines.length === 0 || !hasContent) {
        currentLines = [];
        hasContent = false;
        return;
      }

      const pageContent = currentLines.join("\n").trim();
      if (pageContent) {
        const headerPath = headerStack.map((h) => h.text).join(" > ");
        const metadata: ChunkMetadata = {
          ...doc.metadata,
          header_path: headerPath || undefined,
        };
        chunks.push({ pageContent, metadata });
      }

      currentLines = [];
      hasContent = false;
    };

    for (const line of lines) {
      const match = line.match(headerRegex);

      if (match) {
        flushChunk();

        const level = match[1].length;
        const text = match[2].trim();
        while (
          headerStack.length > 0 &&
          headerStack[headerStack.length - 1].level >= level
        ) {
          headerStack.pop();
        }
        headerStack.push({ level, text });

        currentLines.push(line);
        hasContent = true;
      } else {
        currentLines.push(line);
        if (line.trim()) {
          hasContent = true;
        }
      }
    }

    flushChunk();

    if (chunks.length === 0) {
      const metadata: ChunkMetadata = { ...doc.metadata };
      chunks.push({ pageContent: content, metadata });
    }

    return chunks;
  }

  /**
   * 根据子块获取对应的父文档。
   *
   * 检索命中的是 child chunk，但生成回答通常需要完整菜谱，所以这里回溯 parent 文档。
   * 同一个父文档被多个子块命中，说明整篇菜谱与问题更相关，会排在更前面。
   */
  function getParentDocuments(childChunks: ChunkDocument[]): ChunkDocument[] {
    const parentRelevance: Record<string, number> = {};
    const parentDocsMap: Record<string, ChunkDocument> = {};

    for (const chunk of childChunks) {
      const parentId = chunk.metadata.parent_id;
      if (!parentId) continue;

      parentRelevance[parentId] = (parentRelevance[parentId] || 0) + 1;
      if (!parentDocsMap[parentId]) {
        const parent = state.documents.find(
          (doc) => doc.metadata.parent_id === parentId
        );
        if (parent) {
          parentDocsMap[parentId] = parent;
        }
      }
    }

    return Object.entries(parentRelevance)
      .sort(([, a], [, b]) => b - a)
      .map(([parentId]) => parentDocsMap[parentId])
      .filter(Boolean);
  }

  /**
   * 获取数据统计信息。
   *
   * 统计信息主要用于知识库管理接口，帮助判断数据是否加载完整、分块是否合理。
   */
  function getStatistics(): KnowledgeBaseStats {
    if (state.documents.length === 0) {
      return {
        total_documents: 0,
        total_chunks: 0,
        categories: {},
        difficulties: {},
        avg_chunk_size: 0,
      };
    }

    const categories: Record<string, number> = {};
    const difficulties: Record<string, number> = {};

    for (const doc of state.documents) {
      const cat = doc.metadata.category || "未知";
      categories[cat] = (categories[cat] || 0) + 1;

      const diff = doc.metadata.difficulty || "未知";
      difficulties[diff] = (difficulties[diff] || 0) + 1;
    }

    const avgChunkSize =
      state.chunks.length > 0
        ? state.chunks.reduce(
            (sum, chunk) => sum + (chunk.metadata.chunk_size || 0),
            0
          ) / state.chunks.length
        : 0;

    return {
      total_documents: state.documents.length,
      total_chunks: state.chunks.length,
      categories,
      difficulties,
      avg_chunk_size: Math.round(avgChunkSize),
    };
  }

  return {
    loadDocuments,
    chunkDocuments,
    getParentDocuments,
    getStatistics,
    /** 暴露只读状态，方便主编排模块在必要时查看 documents/chunks。 */
    get state() {
      return state;
    },
  };
}

/** 获取系统支持的分类标签，供查询过滤逻辑使用。 */
export function getSupportedCategories(): string[] {
  return CATEGORY_LABELS;
}

/** 获取系统支持的难度标签，返回副本避免外部修改常量。 */
export function getSupportedDifficulties(): string[] {
  return [...DIFFICULTY_LABELS];
}
