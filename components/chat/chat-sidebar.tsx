"use client";

import { Plus, MessageSquare, Trash2, X, ChefHat } from "lucide-react";
import type { ChatSession } from "@/lib/rag/types";
import { formatTime, cn } from "@/lib/utils";

/**
 * 左侧侧边栏
 * 新建对话按钮、历史会话列表、清空全部
 */
export function ChatSidebar({
  sessions,
  currentSessionId,
  onNewChat,
  onSelectSession,
  onDeleteSession,
  onClearAll,
  isOpen,
  onClose,
}: {
  sessions: ChatSession[];
  currentSessionId: string | null;
  onNewChat: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onClearAll: () => void;
  isOpen: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {/* 移动端遮罩 */}
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/20 backdrop-blur-sm md:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={cn(
          "fixed left-0 top-0 z-40 flex h-full w-[280px] flex-col transition-transform duration-300 ease-in-out md:relative md:translate-x-0",
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="glass-strong flex h-full flex-col border-r border-white/40">
          {/* 顶部：Logo + 关闭按钮 */}
          <div className="flex items-center justify-between p-4">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-400 to-violet-500 shadow-md">
                <ChefHat className="h-5 w-5 text-white" />
              </div>
              <span className="text-sm font-semibold text-slate-700">
                食谱 RAG
              </span>
            </div>
            <button
              onClick={onClose}
              className="cursor-pointer rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/40 hover:text-slate-600 md:hidden"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* 新建对话按钮 */}
          <div className="px-3">
            <button
              onClick={onNewChat}
              className="flex w-full cursor-pointer items-center gap-2 rounded-xl border border-indigo-200 bg-white/60 px-4 py-2.5 text-sm font-medium text-indigo-600 transition-all hover:bg-indigo-50 hover:shadow-md active:scale-[0.98]"
            >
              <Plus className="h-4 w-4" />
              新建对话
            </button>
          </div>

          {/* 历史会话列表 */}
          <div className="mt-3 flex-1 overflow-y-auto px-3">
            <div className="mb-2 px-2 text-xs font-medium text-slate-400">
              历史对话
            </div>
            {sessions.length === 0 ? (
              <div className="px-2 py-4 text-center text-xs text-slate-400">
                暂无历史对话
              </div>
            ) : (
              <div className="space-y-1">
                {sessions.map((session) => (
                  <div
                    key={session.id}
                    onClick={() => onSelectSession(session.id)}
                    className={cn(
                      "group flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 transition-all",
                      session.id === currentSessionId
                        ? "bg-indigo-100/80 text-indigo-700"
                        : "text-slate-600 hover:bg-white/50"
                    )}
                  >
                    <MessageSquare className="h-4 w-4 flex-shrink-0 opacity-60" />
                    <div className="flex-1 truncate">
                      <div className="truncate text-sm">
                        {session.title}
                      </div>
                      <div className="text-xs text-slate-400">
                        {formatTime(session.updatedAt)}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSession(session.id);
                      }}
                      className="flex-shrink-0 cursor-pointer rounded p-1 text-slate-300 opacity-0 transition-all hover:bg-red-100 hover:text-red-500 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 底部：清空全部 */}
          {sessions.length > 0 && (
            <div className="border-t border-white/30 p-3">
              <button
                onClick={onClearAll}
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-500 transition-colors hover:bg-red-50 hover:text-red-500"
              >
                <Trash2 className="h-4 w-4" />
                清空全部对话
              </button>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
