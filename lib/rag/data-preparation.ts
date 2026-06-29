import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep, parse } from "path";
import type { Document } from "@langchain/core/documents";
import type { ChunkMetadata, ChunkDocument, KnowledgeBaseStats } from "./types";
import { CATEGORY_MAPPING, CATEGORY_LABELS, DIFFICULTY_LABELS } from "./config";
import { md5, uuid, getProjectRoot } from "../utils";

/**
 * 数据准备模块（对应原 Python data_preparation.py）
 * 负责：数据加载、元数据增强、Markdown 结构感知分块、父子文档映射
 */
export class DataPreparationModule {
  /** 父文档（完整食谱） */
  documents: ChunkDocument[] = [];
  /** 子文档（按标题分割的小块） */
  chunks: ChunkDocument[] = [];
  /** 子块 ID → 父文档 ID 映射 */
  parentChildMap: Record<string, string> = {};

  constructor(private dataPath: string) {}

  /**
   * 加载所有 Markdown 文档
   */
  loadDocuments(): ChunkDocument[] {
    console.log(`[DataPreparation] 正在从 ${this.dataPath} 加载文档...`);

    const fullPath = join(getProjectRoot(), this.dataPath);
    const documents: ChunkDocument[] = [];

    const mdFiles = this.findMarkdownFiles(fullPath);

    for (const mdFile of mdFiles) {
      try {
        const content = readFileSync(mdFile, "utf-8");

        // 生成确定性 parent_id（基于数据根目录的相对路径）
        const dataRoot = fullPath;
        let relativePath: string;
        try {
          relativePath = relative(dataRoot, mdFile).split(sep).join("/");
        } catch {
          relativePath = mdFile.split(sep).join("/");
        }
        const parentId = md5(relativePath);

        const doc: ChunkDocument = {
          pageContent: content,
          metadata: {
            source: mdFile,
            parent_id: parentId,
            doc_type: "parent",
            category: "其他",
            dish_name: "",
            difficulty: "未知",
          },
        };

        documents.push(doc);
      } catch (e) {
        console.warn(`[DataPreparation] 读取文件 ${mdFile} 失败:`, e);
      }
    }

    // 增强元数据
    for (const doc of documents) {
      this.enhanceMetadata(doc);
    }

    this.documents = documents;
    console.log(`[DataPreparation] 成功加载 ${documents.length} 个文档`);
    return documents;
  }

  /**
   * 递归查找所有 .md 文件
   */
  private findMarkdownFiles(dir: string): string[] {
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
   * 增强文档元数据：提取分类、菜品名、难度
   */
  private enhanceMetadata(doc: ChunkDocument) {
    const filePath = doc.metadata.source;
    const pathParts = filePath.split(sep);

    // 提取菜品分类
    doc.metadata.category = "其他";
    for (const [key, value] of Object.entries(CATEGORY_MAPPING)) {
      if (pathParts.includes(key)) {
        doc.metadata.category = value;
        break;
      }
    }

    // 提取菜品名称（文件名，不含扩展名）
    doc.metadata.dish_name = parse(filePath).name;

    // 分析难度等级（按 ★ 数量）
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
   * Markdown 结构感知分块（对应原 Python _markdown_header_split）
   * 按 #/##/### 标题分割，保留标题路径到 metadata
   */
  chunkDocuments(): ChunkDocument[] {
    console.log("[DataPreparation] 正在进行 Markdown 结构感知分块...");

    if (this.documents.length === 0) {
      throw new Error("请先加载文档");
    }

    const allChunks: ChunkDocument[] = [];

    for (const doc of this.documents) {
      try {
        const mdChunks = this.markdownHeaderSplit(doc);

        const parentId = doc.metadata.parent_id;

        mdChunks.forEach((chunk, i) => {
          const childId = uuid();

          // 合并原文档元数据
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

          this.parentChildMap[childId] = parentId;
        });

        allChunks.push(...mdChunks);
      } catch (e) {
        console.warn(
          `[DataPreparation] 文档 ${doc.metadata.dish_name} Markdown 分割失败:`,
          e
        );
        allChunks.push(doc);
      }
    }

    this.chunks = allChunks;
    console.log(
      `[DataPreparation] Markdown 分块完成，共生成 ${allChunks.length} 个 chunk`
    );
    return allChunks;
  }

  /**
   * Markdown 标题分割器（自行实现，对应 Python MarkdownHeaderTextSplitter）
   * 按 #/##/### 分割，strip_headers=false（保留标题）
   */
  private markdownHeaderSplit(doc: ChunkDocument): ChunkDocument[] {
    const content = doc.pageContent;
    const lines = content.split("\n");

    // 标题正则：匹配 1-3 级标题
    const headerRegex = /^(#{1,3})\s+(.+)$/;

    // 当前标题路径栈
    const headerStack: Array<{ level: number; text: string }> = [];
    const chunks: ChunkDocument[] = [];

    let currentLines: string[] = [];
    let hasContent = false;

    const flushChunk = () => {
      if (currentLines.length > 0 && hasContent) {
        const pageContent = currentLines.join("\n").trim();
        if (pageContent) {
          const headerPath = headerStack.map((h) => h.text).join(" > ");
          chunks.push({
            pageContent,
            metadata: {
              ...doc.metadata,
              header_path: headerPath || undefined,
            } as ChunkMetadata,
          });
        }
      }
      currentLines = [];
      hasContent = false;
    };

    for (const line of lines) {
      const match = line.match(headerRegex);

      if (match) {
        // 遇到新标题，先保存当前 chunk
        flushChunk();

        const level = match[1].length;
        const text = match[2].trim();

        // 更新标题栈：弹出级别 >= 当前的标题
        while (headerStack.length > 0 && headerStack[headerStack.length - 1].level >= level) {
          headerStack.pop();
        }
        headerStack.push({ level, text });

        // 标题行本身加入新 chunk（strip_headers=false）
        currentLines.push(line);
        hasContent = true;
      } else {
        currentLines.push(line);
        if (line.trim()) {
          hasContent = true;
        }
      }
    }

    // 保存最后一个 chunk
    flushChunk();

    // 如果没有分割成功，将整个文档作为一个 chunk
    if (chunks.length === 0) {
      chunks.push({
        pageContent: content,
        metadata: { ...doc.metadata } as ChunkMetadata,
      });
    }

    return chunks;
  }

  /**
   * 根据子块获取对应的父文档（智能去重，按相关性排序）
   * 对应原 Python get_parent_documents
   */
  getParentDocuments(childChunks: ChunkDocument[]): ChunkDocument[] {
    const parentRelevance: Record<string, number> = {};
    const parentDocsMap: Record<string, ChunkDocument> = {};

    for (const chunk of childChunks) {
      const parentId = chunk.metadata.parent_id;
      if (!parentId) continue;

      parentRelevance[parentId] = (parentRelevance[parentId] || 0) + 1;

      if (!parentDocsMap[parentId]) {
        for (const doc of this.documents) {
          if (doc.metadata.parent_id === parentId) {
            parentDocsMap[parentId] = doc;
            break;
          }
        }
      }
    }

    // 按相关性排序（匹配次数多的排在前面）
    const sortedParentIds = Object.entries(parentRelevance)
      .sort(([, a], [, b]) => b - a)
      .map(([id]) => id);

    const parentDocs: ChunkDocument[] = [];
    for (const parentId of sortedParentIds) {
      if (parentDocsMap[parentId]) {
        parentDocs.push(parentDocsMap[parentId]);
      }
    }

    return parentDocs;
  }

  /**
   * 获取数据统计信息
   */
  getStatistics(): KnowledgeBaseStats {
    if (this.documents.length === 0) {
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

    for (const doc of this.documents) {
      const cat = doc.metadata.category || "未知";
      categories[cat] = (categories[cat] || 0) + 1;

      const diff = doc.metadata.difficulty || "未知";
      difficulties[diff] = (difficulties[diff] || 0) + 1;
    }

    const avgChunkSize =
      this.chunks.length > 0
        ? this.chunks.reduce(
            (sum, c) => sum + (c.metadata.chunk_size || 0),
            0
          ) / this.chunks.length
        : 0;

    return {
      total_documents: this.documents.length,
      total_chunks: this.chunks.length,
      categories,
      difficulties,
      avg_chunk_size: Math.round(avgChunkSize),
    };
  }

  /** 获取支持的分类标签 */
  static getSupportedCategories(): string[] {
    return CATEGORY_LABELS;
  }

  /** 获取支持的难度标签 */
  static getSupportedDifficulties(): string[] {
    return [...DIFFICULTY_LABELS];
  }
}
