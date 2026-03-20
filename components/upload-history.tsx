"use client";

import { useState, useEffect, useCallback } from "react";
import { History, Trash2, Film, Calendar, X, Globe, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { UploadHistoryRecord } from "@/hooks/use-websocket";

// ==================== API helpers ====================

function getApiBase() {
  if (typeof window === "undefined") return "http://localhost:3001";
  return `${window.location.protocol}//${window.location.hostname}:3001`;
}

async function fetchUploadHistory(): Promise<UploadHistoryRecord[]> {
  try {
    const res = await fetch(`${getApiBase()}/api/upload-history`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.records || [];
  } catch {
    return [];
  }
}

export async function addUploadRecord(record: { title: string; vodFileId: string; uploadedBy: string }): Promise<UploadHistoryRecord | null> {
  try {
    const res = await fetch(`${getApiBase()}/api/upload-history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.record || null;
  } catch {
    return null;
  }
}

async function deleteUploadRecord(id: string): Promise<boolean> {
  try {
    const res = await fetch(`${getApiBase()}/api/upload-history/${id}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

async function clearAllUploadHistory(): Promise<boolean> {
  try {
    const res = await fetch(`${getApiBase()}/api/upload-history`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

// ==================== Date formatting ====================

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  const time = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

  if (isToday) return `今天 ${time}`;
  if (isYesterday) return `昨天 ${time}`;

  const month = d.getMonth() + 1;
  const day = d.getDate();
  const year = d.getFullYear();
  if (year === now.getFullYear()) {
    return `${month}月${day}日 ${time}`;
  }
  return `${year}年${month}月${day}日 ${time}`;
}

function groupByDate(records: UploadHistoryRecord[]): { label: string; records: UploadHistoryRecord[] }[] {
  const groups: Map<string, UploadHistoryRecord[]> = new Map();

  for (const r of records) {
    const d = new Date(r.uploadedAt);
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    let key: string;
    if (d.toDateString() === now.toDateString()) {
      key = "今天";
    } else if (d.toDateString() === yesterday.toDateString()) {
      key = "昨天";
    } else if (d.getFullYear() === now.getFullYear()) {
      key = `${d.getMonth() + 1}月${d.getDate()}日`;
    } else {
      key = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    }

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  return Array.from(groups.entries()).map(([label, records]) => ({ label, records }));
}

// ==================== Component ====================

interface UploadHistoryProps {
  open: boolean;
  onClose: () => void;
}

export function UploadHistory({ open, onClose }: UploadHistoryProps) {
  const [history, setHistory] = useState<UploadHistoryRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    const records = await fetchUploadHistory();
    setHistory(records);
    setLoading(false);
  }, []);

  // Load history when panel opens
  useEffect(() => {
    if (open) {
      loadHistory();
    }
  }, [open, loadHistory]);

  const handleDelete = useCallback(async (id: string) => {
    // Optimistic update
    setHistory((prev) => prev.filter((r) => r.id !== id));
    const ok = await deleteUploadRecord(id);
    if (!ok) {
      // Revert on failure
      loadHistory();
    }
  }, [loadHistory]);

  const handleClear = useCallback(async () => {
    setHistory([]);
    const ok = await clearAllUploadHistory();
    if (!ok) {
      loadHistory();
    }
  }, [loadHistory]);

  const groups = groupByDate(history);

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 bg-black/40 backdrop-blur-sm z-50 transition-opacity duration-300",
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onClick={onClose}
      />

      {/* Slide-in Panel */}
      <div
        className={cn(
          "fixed top-0 right-0 h-full w-80 sm:w-96 bg-card border-l border-border z-50 shadow-2xl transition-transform duration-300 ease-out flex flex-col",
          open ? "translate-x-0" : "translate-x-full"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <History className="w-5 h-5 text-primary" />
            <h2 className="text-base font-semibold text-foreground">上传历史</h2>
            {history.length > 0 && (
              <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
                {history.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={loadHistory}
              className="h-8 w-8"
              title="刷新"
              disabled={loading}
            >
              <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
            </Button>
            {history.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClear}
                className="text-xs text-muted-foreground hover:text-destructive h-8 px-2"
              >
                <Trash2 className="w-3.5 h-3.5 mr-1" />
                清空
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Global indicator */}
        <div className="px-4 py-2 bg-primary/5 border-b border-border flex items-center gap-2 flex-shrink-0">
          <Globe className="w-3.5 h-3.5 text-primary" />
          <span className="text-xs text-muted-foreground">全局上传记录，所有人共享，跨房间持久保存</span>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading && history.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <RefreshCw className="w-6 h-6 text-muted-foreground animate-spin" />
            </div>
          ) : history.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-8">
              <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
                <Film className="w-8 h-8 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground mb-1">暂无上传记录</p>
              <p className="text-xs text-muted-foreground">上传视频后会自动记录在这里，所有人都能看到</p>
            </div>
          ) : (
            <div className="py-2">
              {groups.map((group) => (
                <div key={group.label}>
                  {/* Date Header */}
                  <div className="sticky top-0 bg-card/95 backdrop-blur-sm px-4 py-2 flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground">{group.label}</span>
                  </div>

                  {/* Records */}
                  {group.records.map((record) => (
                    <div
                      key={record.id}
                      className="group px-4 py-2.5 hover:bg-accent/50 transition-colors flex items-start gap-3"
                    >
                      {/* Icon */}
                      <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <Film className="w-4 h-4 text-primary" />
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate" title={record.title}>
                          {record.title}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <p className="text-xs text-muted-foreground">
                            {formatDate(record.uploadedAt)}
                          </p>
                          {record.uploadedBy && (
                            <span className="text-xs text-muted-foreground/70 flex items-center gap-0.5">
                              · {record.uploadedBy}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Delete button */}
                      <button
                        onClick={() => handleDelete(record.id)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-destructive/10 hover:text-destructive flex-shrink-0"
                        title="删除记录"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
