"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

/**
 * Markdown 渲染组件
 * 支持：标题、列表、代码块、表格、链接等 GFM 语法
 */
export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="markdown-body text-slate-700">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // 链接在新标签页打开
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-500 underline underline-offset-2 hover:text-indigo-600"
            >
              {children}
            </a>
          ),
          // 代码块添加语法高亮容器
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-lg bg-slate-800 p-4 text-sm">
              {children}
            </pre>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
