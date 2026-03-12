"use client";

import { Menu, X, MonitorPlay } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RoomStatus, Participant } from "@/components/room-status";

interface HeaderProps {
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  roomId: string;
  participants: Participant[];
  isConnected: boolean;
  isSynced: boolean;
  onSync: () => void;
  onLeaveRoom?: () => void;
  clientId?: string;
}

export function Header({
  isSidebarOpen,
  onToggleSidebar,
  roomId,
  participants,
  isConnected,
  isSynced,
  onSync,
  onLeaveRoom,
  clientId,
}: HeaderProps) {
  return (
    <header className="h-16 bg-card/80 backdrop-blur-xl border-b border-border flex items-center justify-between px-4 sticky top-0 z-50">
      {/* Left Section */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleSidebar}
          className="md:hidden"
        >
          {isSidebarOpen ? (
            <X className="w-5 h-5" />
          ) : (
            <Menu className="w-5 h-5" />
          )}
        </Button>

        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center shadow-lg shadow-primary/20">
            <MonitorPlay className="w-5 h-5 text-primary-foreground" />
          </div>
          <div className="hidden sm:block">
            <h1 className="text-lg font-bold text-foreground tracking-tight">
              WatchTogether
            </h1>
            <p className="text-xs text-muted-foreground -mt-0.5">
              同步观看体验
            </p>
          </div>
        </div>
      </div>

      {/* Right Section */}
      <div className="flex items-center gap-2">
        <RoomStatus
          roomId={roomId}
          participants={participants}
          isConnected={isConnected}
          isSynced={isSynced}
          onSync={onSync}
          onLeaveRoom={onLeaveRoom}
          clientId={clientId}
        />
      </div>
    </header>
  );
}
