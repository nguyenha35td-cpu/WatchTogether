"use client";

import { useState, useRef } from "react";
import { Plus, Trash2, Play, Film, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

export interface VideoItem {
  id: string;
  title: string;
  thumbnail: string;
  duration: string;
  src: string;
  /** Upload progress 0-100, undefined means not uploading */
  uploadProgress?: number;
}

// Accepted video file extensions
const VIDEO_ACCEPT = "video/*,.mkv,.avi,.wmv,.flv,.m4v,.ts,.mts,.3gp,.rmvb,.rm,.mov";

interface PlaylistSidebarProps {
  videos: VideoItem[];
  currentVideoId: string | null;
  onSelectVideo: (video: VideoItem) => void;
  onDeleteVideo: (id: string) => void;
  onUploadVideo: (file: File) => void;
  isOpen: boolean;
}

export function PlaylistSidebar({
  videos,
  currentVideoId,
  onSelectVideo,
  onDeleteVideo,
  onUploadVideo,
  isOpen,
}: PlaylistSidebarProps) {
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    // Check for video file by MIME or extension
    const videoExts = /\.(mp4|webm|ogg|ogv|mov|mkv|avi|wmv|flv|m4v|ts|mts|3gp|rmvb|rm)$/i;
    const videoFile = files.find(
      (file) => file.type.startsWith("video/") || videoExts.test(file.name)
    );
    if (videoFile) {
      onUploadVideo(videoFile);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUploadVideo(file);
    }
    // Reset so same file can be re-selected
    if (e.target) e.target.value = "";
  };

  return (
    <aside
      className={cn(
        "h-full bg-sidebar border-r border-sidebar-border flex flex-col transition-all duration-300 ease-out flex-shrink-0",
        isOpen ? "w-80" : "w-0 overflow-hidden"
      )}
    >
      {/* Header */}
      <div className="p-4 border-b border-sidebar-border">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-sidebar-foreground">播放列表</h2>
          <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded-full">
            {videos.length} 个视频
          </span>
        </div>

        {/* Upload Area */}
        <div
          className={cn(
            "relative border-2 border-dashed rounded-lg p-4 transition-colors cursor-pointer",
            dragOver
              ? "border-primary bg-primary/10"
              : "border-sidebar-border hover:border-muted-foreground/50"
          )}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={VIDEO_ACCEPT}
            className="hidden"
            onChange={handleFileSelect}
          />
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <div className="w-10 h-10 rounded-full bg-sidebar-accent flex items-center justify-center">
              <Upload className="w-5 h-5" />
            </div>
            <span className="text-sm">拖放或点击上传</span>
            <span className="text-xs opacity-60">MP4 / MKV / AVI / MOV 等</span>
          </div>
        </div>
      </div>

      {/* Video List */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {videos.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Film className="w-12 h-12 mb-3 opacity-50" />
              <p className="text-sm">暂无视频</p>
              <p className="text-xs mt-1">上传视频开始观看</p>
            </div>
          ) : (
            videos.map((video, index) => (
              <div
                key={video.id}
                className={cn(
                  "group relative flex gap-3 p-2 rounded-lg transition-all duration-200",
                  video.uploadProgress !== undefined
                    ? "opacity-80"
                    : "cursor-pointer",
                  currentVideoId === video.id
                    ? "bg-sidebar-accent"
                    : "hover:bg-sidebar-accent/50"
                )}
                onClick={() => {
                  if (video.uploadProgress === undefined) onSelectVideo(video);
                }}
              >
                {/* Thumbnail */}
                <div className="relative w-24 h-14 rounded-md overflow-hidden bg-muted flex-shrink-0">
                  {video.thumbnail ? (
                    <img
                      src={video.thumbnail}
                      alt={video.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Film className="w-6 h-6 text-muted-foreground/50" />
                    </div>
                  )}
                  {/* Play overlay */}
                  {currentVideoId === video.id && video.uploadProgress === undefined && (
                    <div className="absolute inset-0 bg-primary/30 flex items-center justify-center">
                      <Play className="w-5 h-5 text-primary-foreground" fill="currentColor" />
                    </div>
                  )}
                  {/* Upload progress overlay on thumbnail */}
                  {video.uploadProgress !== undefined && (
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                      <span className="text-xs text-white font-semibold">
                        {video.uploadProgress}%
                      </span>
                    </div>
                  )}
                  {/* Duration badge */}
                  {video.uploadProgress === undefined && (
                    <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-xs text-foreground font-mono">
                      {video.duration}
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0 flex flex-col justify-center">
                  <span className="text-xs text-muted-foreground mb-0.5">
                    #{index + 1}
                  </span>
                  <h3 className="text-sm font-medium text-sidebar-foreground truncate">
                    {video.title}
                  </h3>
                  {/* Upload progress bar */}
                  {video.uploadProgress !== undefined && (
                    <div className="mt-1.5 w-full">
                      <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all duration-300 ease-out"
                          style={{ width: `${video.uploadProgress}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground mt-0.5">
                        上传中 {video.uploadProgress}%
                      </span>
                    </div>
                  )}
                </div>

                {/* Delete Button */}
                {video.uploadProgress === undefined && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteVideo(video.id);
                    }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
