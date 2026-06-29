"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Menu, ChefHat } from "lucide-react";
import type {
  ChatSession,
  ChatMessage,
  SourceDoc,
  SSEEvent,
} from "@/lib/rag/types";
import {
  loadSessions,
  saveSessions,
  getCurrentSessionId,
  setCurrentSessionId,
  createSession,
  createMessage,
  generateTitle,
  clearAllSessions,
} from "@/lib/store/chat-store";
import { uuid } from "@/lib/utils";
import { ChatSidebar } from "@/components/chat/chat-sidebar";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ChatInput } from "@/components/chat/chat-input";

export default function Home() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingMessage, setStreamingMessage] = useState<ChatMessage | null>(
    null
  );
  const [isThinking, setIsThinking] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [kbStatus, setKbStatus] = useState<{
    ready: boolean;
    loading: boolean;
  }>({ ready: false, loading: true });

  const abortControllerRef = useRef<AbortController | null>(null);

  // 初始化：加载历史会话
  useEffect(() => {
    const loaded = loadSessions();
    setSessions(loaded);
    const currentId = getCurrentSessionId();
    if (currentId && loaded.find((s) => s.id === currentId)) {
      setCurrentSession(currentId);
      setMessages(
        loaded.find((s) => s.id === currentId)?.messages || []
      );
    }
  }, []);

  // 检查知识库状态
  useEffect(() => {
    checkKnowledgeBase();
  }, []);

  const checkKnowledgeBase = async () => {
    try {
      const res = await fetch("/api/knowledge-base");
      const data = await res.json();
      setKbStatus({ ready: data.ready, loading: false });
    } catch {
      setKbStatus({ ready: false, loading: false });
    }
  };

  // 获取当前会话
  const getCurrentSession = useCallback((): ChatSession | null => {
    if (!currentSessionId) return null;
    return sessions.find((s) => s.id === currentSessionId) || null;
  }, [currentSessionId, sessions]);

  // 更新会话
  const updateSession = useCallback(
    (sessionId: string, updater: (s: ChatSession) => ChatSession) => {
      setSessions((prev) => {
        const updated = prev.map((s) =>
          s.id === sessionId ? updater(s) : s
        );
        saveSessions(updated);
        return updated;
      });
    },
    []
  );

  // 新建对话
  const handleNewChat = () => {
    // 如果有正在流式输出的，先停止
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setStreamingMessage(null);
    setIsStreaming(false);
    setIsThinking(false);
    setMessages([]);
    setCurrentSession(null);
    setCurrentSessionId("");
    setSidebarOpen(false);
  };

  // 选择会话
  const handleSelectSession = (id: string) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setStreamingMessage(null);
    setIsStreaming(false);
    setIsThinking(false);
    setCurrentSession(id);
    setCurrentSessionId(id);
    const session = sessions.find((s) => s.id === id);
    setMessages(session?.messages || []);
    setSidebarOpen(false);
  };

  // 删除会话
  const handleDeleteSession = (id: string) => {
    setSessions((prev) => {
      const updated = prev.filter((s) => s.id !== id);
      saveSessions(updated);
      return updated;
    });
    if (currentSessionId === id) {
      setMessages([]);
      setCurrentSession(null);
      setCurrentSessionId("");
    }
  };

  // 清空全部
  const handleClearAll = () => {
    if (!confirm("确定要清空所有对话吗？")) return;
    clearAllSessions();
    setSessions([]);
    setMessages([]);
    setCurrentSession(null);
    setCurrentSessionId("");
  };

  // 发送消息（核心流式逻辑）
  const handleSend = async (text: string) => {
    if (isStreaming) return;

    // 确保有当前会话
    let sessionId: string = currentSessionId || "";
    let session = sessionId ? getCurrentSession() : null;

    if (!session) {
      session = createSession(generateTitle(text));
      sessionId = session.id;
      setCurrentSession(session.id);
      setCurrentSessionId(session.id);
      setSessions((prev) => {
        const updated = [session!, ...prev];
        saveSessions(updated);
        return updated;
      });
    }

    // 添加用户消息
    const userMsg = createMessage("user", text);
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);

    // 更新会话标题（如果是第一条消息）
    if (session.messages.length === 0) {
      updateSession(sessionId, (s) => ({
        ...s,
        title: generateTitle(text),
      }));
    }

    // 构建历史（最近 6 轮）
    const history = messages.slice(-6).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    setIsThinking(true);
    setIsStreaming(true);

    // 创建流式消息
    const streamMsg: ChatMessage = {
      id: uuid(),
      role: "assistant",
      content: "",
      sources: [],
      createdAt: Date.now(),
    };
    setStreamingMessage(streamMsg);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: text, history }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      setIsThinking(false);

      const reader = res.body?.getReader();
      if (!reader) throw new Error("无法读取响应流");

      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";
      const collectedSources: SourceDoc[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // 解析 SSE 事件（按 \n\n 分隔）
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const event: SSEEvent = JSON.parse(jsonStr);

            switch (event.type) {
              case "sources":
                collectedSources.push(...event.data);
                setStreamingMessage((prev) =>
                  prev ? { ...prev, sources: event.data } : prev
                );
                break;

              case "token":
                fullContent += event.data;
                setStreamingMessage((prev) =>
                  prev ? { ...prev, content: fullContent } : prev
                );
                break;

              case "error":
                fullContent += `\n\n⚠️ 错误: ${event.data}`;
                setStreamingMessage((prev) =>
                  prev ? { ...prev, content: fullContent } : prev
                );
                break;

              case "done":
                break;
            }
          } catch (e) {
            console.error("[SSE] 解析失败:", e);
          }
        }
      }

      // 流式完成，将消息存入会话
      const finalMessage: ChatMessage = {
        ...streamMsg,
        content: fullContent,
        sources: collectedSources,
      };

      const updatedMessages = [...newMessages, finalMessage];
      setMessages(updatedMessages);
      setStreamingMessage(null);

      // 更新会话存储
      updateSession(sessionId, (s) => ({
        ...s,
        messages: updatedMessages,
        updatedAt: Date.now(),
      }));
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        // 用户主动停止
        if (streamingMessage && streamingMessage.content) {
          const finalMessage = { ...streamingMessage };
          setMessages((prev) => [...prev, finalMessage]);
          updateSession(sessionId, (s) => ({
            ...s,
            messages: [...messages, userMsg, finalMessage],
            updatedAt: Date.now(),
          }));
        }
      } else {
        console.error("[Chat] 发送失败:", e);
        const errorMsg: ChatMessage = {
          ...streamMsg,
          content: `⚠️ 发送失败: ${e instanceof Error ? e.message : "未知错误"}`,
        };
        setMessages((prev) => [...prev, errorMsg]);
        updateSession(sessionId, (s) => ({
          ...s,
          messages: [...messages, userMsg, errorMsg],
          updatedAt: Date.now(),
        }));
      }
      setStreamingMessage(null);
    } finally {
      setIsThinking(false);
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  };

  // 停止生成
  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* 侧边栏 */}
      <ChatSidebar
        sessions={sessions}
        currentSessionId={currentSessionId}
        onNewChat={handleNewChat}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onClearAll={handleClearAll}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {/* 主区域 */}
      <div className="flex flex-1 flex-col">
        {/* 顶部栏（移动端显示菜单按钮） */}
        <header className="flex items-center justify-between border-b border-white/30 bg-white/30 px-4 py-3 backdrop-blur-md md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="cursor-pointer rounded-lg p-2 text-slate-600 transition-colors hover:bg-white/40"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2">
            <ChefHat className="h-5 w-5 text-indigo-500" />
            <span className="text-sm font-medium text-slate-700">
              食谱 RAG
            </span>
          </div>
          <div className="w-9" />
        </header>

        {/* 知识库状态提示 */}
        {kbStatus.loading && (
          <div className="border-b border-amber-200/50 bg-amber-50/80 px-4 py-2 text-center text-xs text-amber-700 backdrop-blur-md">
            正在加载知识库...
          </div>
        )}
        {!kbStatus.loading && !kbStatus.ready && (
          <div className="border-b border-amber-200/50 bg-amber-50/80 px-4 py-2 text-center text-xs text-amber-700 backdrop-blur-md">
            知识库未就绪，请配置 AIHUBMIX_API_KEY 后重启服务
          </div>
        )}

        {/* 消息列表 */}
        <div className="flex-1 overflow-hidden">
          <ChatMessages
            messages={messages}
            streamingMessage={streamingMessage}
            isThinking={isThinking}
          />
        </div>

        {/* 输入框 */}
        <ChatInput
          onSend={handleSend}
          onStop={handleStop}
          isStreaming={isStreaming}
          disabled={kbStatus.loading || !kbStatus.ready}
        />
      </div>
    </div>
  );
}
