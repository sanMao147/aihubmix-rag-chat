"use client";

import { useState, useRef, type KeyboardEvent } from "react";
import { Send, Square } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 底部输入区
 * Enter 发送，Shift+Enter 换行
 */
export function ChatInput({
  onSend,
  onStop,
  isStreaming,
  disabled,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setInput("");
    // 重置 textarea 高度
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // 自动调整 textarea 高度
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const textarea = e.target;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
  };

  return (
    <div className="border-t border-white/30 bg-white/40 backdrop-blur-xl">
      <div className="mx-auto max-w-3xl px-4 py-4">
        <div
          className={cn(
            "flex items-end gap-3 rounded-2xl border border-white/50 bg-white/70 p-3 shadow-lg backdrop-blur-xl transition-all",
            "focus-within:border-indigo-300 focus-within:shadow-indigo-100"
          )}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="输入你的问题...（Enter 发送，Shift+Enter 换行）"
            disabled={disabled}
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none disabled:opacity-50"
            style={{ minHeight: "24px", maxHeight: "200px" }}
          />

          {isStreaming ? (
            <button
              onClick={onStop}
              className="flex h-9 w-9 flex-shrink-0 cursor-pointer items-center justify-center rounded-xl bg-red-100 text-red-500 transition-all hover:bg-red-200 active:scale-95"
              title="停止生成"
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim() || disabled}
              className={cn(
                "flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl transition-all active:scale-95",
                input.trim() && !disabled
                  ? "cursor-pointer bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-md hover:from-indigo-600 hover:to-violet-600"
                  : "cursor-not-allowed bg-slate-100 text-slate-300"
              )}
              title="发送"
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
