"use client";

import { useEffect, useRef } from "react";
import type { ChatMessage } from "@/lib/rag/types";
import { MessageBubble } from "./message-bubble";
import { ChefHat } from "lucide-react";

/**
 * 消息列表区域
 */
export function ChatMessages({
  messages,
  streamingMessage,
  isThinking,
}: {
  messages: ChatMessage[];
  /** 正在流式输出的消息 */
  streamingMessage: ChatMessage | null;
  /** 是否正在等待 AI 响应 */
  isThinking: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages, streamingMessage, isThinking]);

  // 空状态
  if (messages.length === 0 && !streamingMessage && !isThinking) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-indigo-400 to-violet-500 shadow-xl">
            <ChefHat className="h-10 w-10 text-white" />
          </div>
          <h1 className="mb-2 text-2xl font-semibold text-slate-700">
            尝尝咸淡 RAG 食谱助手
          </h1>
          <p className="mb-1 text-slate-500">
            解决您的选择困难症，告别"今天吃什么"的世纪难题
          </p>
          <p className="text-sm text-slate-400">
            试试问："推荐几个简单的素菜" 或 "可乐鸡翅怎么做"
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="mx-auto h-full max-w-3xl space-y-6 overflow-y-auto px-4 py-6"
    >
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}

      {isThinking && !streamingMessage && (
        <div className="flex justify-start animate-fade-in-up">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 shadow-md">
              <ChefHat className="h-5 w-5 text-white" />
            </div>
            <div className="flex items-center py-2">
              <div className="flex items-center gap-1.5">
                <span className="loading-dot inline-block h-2 w-2 rounded-full bg-indigo-500" />
                <span className="loading-dot inline-block h-2 w-2 rounded-full bg-violet-500" />
                <span className="loading-dot inline-block h-2 w-2 rounded-full bg-pink-500" />
              </div>
            </div>
          </div>
        </div>
      )}

      {streamingMessage && (
        <MessageBubble message={streamingMessage} isStreaming={true} />
      )}

      <div ref={bottomRef} className="h-1" />
    </div>
  );
}
