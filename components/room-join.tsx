"use client";

import { useState } from "react";
import { LogIn, Plus, Loader2, MonitorPlay } from "lucide-react";
import { Button } from "@/components/ui/button";

interface RoomJoinProps {
  onCreateRoom: (userName: string) => void;
  onJoinRoom: (roomId: string, userName: string) => void;
  isConnecting: boolean;
  error: string | null;
}

export function RoomJoin({
  onCreateRoom,
  onJoinRoom,
  isConnecting,
  error,
}: RoomJoinProps) {
  const [mode, setMode] = useState<"idle" | "create" | "join">("idle");
  const [userName, setUserName] = useState("");
  const [roomCode, setRoomCode] = useState("");

  const handleCreate = () => {
    if (!userName.trim()) return;
    onCreateRoom(userName.trim());
  };

  const handleJoin = () => {
    if (!userName.trim() || !roomCode.trim()) return;
    onJoinRoom(roomCode.trim().toUpperCase(), userName.trim());
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center shadow-lg shadow-primary/20">
            <MonitorPlay className="w-8 h-8 text-primary-foreground" />
          </div>
          <h1 className="text-3xl font-bold text-foreground tracking-tight">
            WatchTogether
          </h1>
          <p className="text-muted-foreground mt-1">与朋友一起同步观看视频</p>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm text-center">
            {error}
          </div>
        )}

        {mode === "idle" ? (
          /* Mode Selection */
          <div className="space-y-3">
            <button
              onClick={() => setMode("create")}
              className="w-full p-5 rounded-xl bg-card border border-border hover:border-primary/50 hover:bg-card/80 transition-all group text-left"
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                  <Plus className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-foreground">
                    创建房间
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    创建一个新房间，邀请朋友加入
                  </p>
                </div>
              </div>
            </button>

            <button
              onClick={() => setMode("join")}
              className="w-full p-5 rounded-xl bg-card border border-border hover:border-primary/50 hover:bg-card/80 transition-all group text-left"
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                  <LogIn className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-foreground">
                    加入房间
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    输入房间码加入已有房间
                  </p>
                </div>
              </div>
            </button>
          </div>
        ) : (
          /* Form */
          <div className="p-6 rounded-xl bg-card border border-border">
            <h2 className="text-xl font-semibold text-foreground mb-6">
              {mode === "create" ? "创建房间" : "加入房间"}
            </h2>

            <div className="space-y-4">
              {/* Username */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  你的昵称
                </label>
                <input
                  type="text"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  placeholder="输入你的昵称"
                  className="w-full px-4 py-2.5 rounded-lg bg-background border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all"
                  maxLength={20}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      if (mode === "create") handleCreate();
                      else if (roomCode.trim()) handleJoin();
                    }
                  }}
                />
              </div>

              {/* Room Code (Join mode) */}
              {mode === "join" && (
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">
                    房间码
                  </label>
                  <input
                    type="text"
                    value={roomCode}
                    onChange={(e) =>
                      setRoomCode(e.target.value.toUpperCase())
                    }
                    placeholder="例如：WT-XF28FA"
                    className="w-full px-4 py-2.5 rounded-lg bg-background border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all font-mono tracking-wider"
                    maxLength={10}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleJoin();
                    }}
                  />
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-3 pt-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setMode("idle");
                    setUserName("");
                    setRoomCode("");
                  }}
                  disabled={isConnecting}
                >
                  返回
                </Button>
                <Button
                  className="flex-1 gap-2"
                  onClick={mode === "create" ? handleCreate : handleJoin}
                  disabled={
                    isConnecting ||
                    !userName.trim() ||
                    (mode === "join" && !roomCode.trim())
                  }
                >
                  {isConnecting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      连接中...
                    </>
                  ) : mode === "create" ? (
                    <>
                      <Plus className="w-4 h-4" />
                      创建
                    </>
                  ) : (
                    <>
                      <LogIn className="w-4 h-4" />
                      加入
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
