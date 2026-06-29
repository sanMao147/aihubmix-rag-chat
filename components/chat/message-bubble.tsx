"use client";

import { ChefHat, User } from "lucide-react";
import type { ChatMessage } from "@/lib/rag/types";
import { MarkdownRenderer } from "./markdown-renderer";
import { SourceCitation } from "./source-citation";
import { LoadingDots } from "@/components/ui/loading-dots";

/**
 * 单条消息气泡
 * 用户消息：右侧浅色气泡
 * AI 消息：左侧带头像无背景（OpenAI 风格）
 */
export function MessageBubble({
  message,
  isStreaming = false,
}: {
  message: ChatMessage;
  isStreaming?: boolean;
}) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end animate-fade-in-up">
        <div className="flex max-w-[80%] items-start gap-3">
          <div className="rounded-2xl rounded-tr-sm bg-indigo-500 px-4 py-3 text-white shadow-md">
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {message.content}
            </p>
          </div>
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100">
            <User className="h-5 w-5 text-indigo-600" />
          </div>
        </div>
      </div>
    );
  }

  // AI 消息
  return (
    <div className="flex justify-start animate-fade-in-up">
      <div className="flex max-w-[85%] items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 shadow-md">
          <ChefHat className="h-5 w-5 text-white" />
        </div>
        <div className="flex-1">
          {message.content === "" && isStreaming ? (
            <div className="py-2">
              <LoadingDots />
            </div>
          ) : (
            <div className={isStreaming ? "cursor-blink" : ""}>
              <MarkdownRenderer content={message.content} />
            </div>
          )}
          {!isStreaming && message.sources && message.sources.length > 0 && (
            <SourceCitation sources={message.sources} />
          )}
        </div>
      </div>
    </div>
  );
}
