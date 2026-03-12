"use client";

import { useState } from "react";
import {
  Users,
  Copy,
  Check,
  RefreshCw,
  Wifi,
  WifiOff,
  LogOut,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export interface Participant {
  id: string;
  name: string;
  isHost: boolean;
  isConnected: boolean;
}

interface RoomStatusProps {
  roomId: string;
  participants: Participant[];
  isConnected: boolean;
  isSynced: boolean;
  onSync: () => void;
  onLeaveRoom?: () => void;
  clientId?: string;
}

export function RoomStatus({
  roomId,
  participants,
  isConnected,
  isSynced,
  onSync,
  onLeaveRoom,
  clientId,
}: RoomStatusProps) {
  const [copied, setCopied] = useState(false);

  const copyRoomId = async () => {
    try {
      // Modern Clipboard API (requires secure context / HTTPS)
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(roomId);
      } else {
        // Fallback for HTTP / older browsers
        const textArea = document.createElement("textarea");
        textArea.value = roomId;
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        textArea.style.top = "-9999px";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("复制失败:", err);
      // Last resort: prompt user to manually copy
      window.prompt("请手动复制房间号:", roomId);
    }
  };

  const connectedCount = participants.filter((p) => p.isConnected).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="h-auto px-3 py-2 gap-2 hover:bg-secondary"
        >
          {/* Connection Status Dot */}
          <div className="relative flex items-center gap-2">
            <div
              className={cn(
                "w-2.5 h-2.5 rounded-full transition-colors",
                isConnected ? "bg-primary" : "bg-destructive"
              )}
            >
              {isConnected && (
                <div className="absolute inset-0 rounded-full bg-primary animate-ping opacity-75" />
              )}
            </div>
            <span className="text-sm font-medium text-foreground">
              {isConnected ? "已连接" : "未连接"}
            </span>
          </div>

          {/* Participant Count */}
          <div className="flex items-center gap-1 text-muted-foreground">
            <Users className="w-4 h-4" />
            <span className="text-sm">{connectedCount}</span>
          </div>
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-72 p-0" align="end">
        {/* Room Header */}
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-foreground">房间信息</h3>
            {isSynced ? (
              <span className="text-xs px-2 py-1 rounded-full bg-primary/20 text-primary flex items-center gap-1">
                <Wifi className="w-3 h-3" />
                已同步
              </span>
            ) : (
              <span className="text-xs px-2 py-1 rounded-full bg-muted text-muted-foreground flex items-center gap-1">
                <WifiOff className="w-3 h-3" />
                同步中
              </span>
            )}
          </div>

          {/* Room ID */}
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-muted px-2 py-1.5 rounded font-mono text-muted-foreground truncate">
              {roomId}
            </code>
            <button
              type="button"
              className="inline-flex items-center justify-center h-8 w-8 flex-shrink-0 rounded-md hover:bg-accent hover:text-accent-foreground transition-colors"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                copyRoomId();
              }}
            >
              {copied ? (
                <Check className="w-4 h-4 text-primary" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        {/* Participants */}
        <div className="p-4">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
            在线参与者 ({connectedCount})
          </h4>
          <div className="space-y-2">
            {participants.map((participant) => (
              <div
                key={participant.id}
                className="flex items-center gap-3 p-2 rounded-lg bg-muted/50"
              >
                {/* Avatar */}
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/80 to-primary flex items-center justify-center">
                  <span className="text-xs font-medium text-primary-foreground">
                    {participant.name.charAt(0).toUpperCase()}
                  </span>
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground truncate">
                      {participant.name}
                      {participant.id === clientId ? " (你)" : ""}
                    </span>
                    {participant.isHost && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-primary/20 text-primary">
                        房主
                      </span>
                    )}
                  </div>
                </div>

                {/* Status */}
                <div
                  className={cn(
                    "w-2 h-2 rounded-full flex-shrink-0",
                    participant.isConnected
                      ? "bg-primary"
                      : "bg-muted-foreground"
                  )}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="p-4 pt-0 space-y-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-2"
            onClick={onSync}
          >
            <RefreshCw className="w-4 h-4" />
            重新同步
          </Button>
          {onLeaveRoom && (
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-2 text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/20"
              onClick={onLeaveRoom}
            >
              <LogOut className="w-4 h-4" />
              离开房间
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
