"use client";

import { useState, useRef } from "react";
import { Plus, Trash2, Play, Film, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

export interface SubtitleTrack {
  index: number;        // ffprobe stream index
  streamIndex: number;  // subtitle stream order (0, 1, 2...)
  codec: string;        // "ass", "srt", "subrip", etc.
  language: string;     // "chi", "eng", "jpn", etc.
  title: string;        // "简体中文", "English", etc.
  vttUrl?: string;      // extracted VTT URL (filled after user selects)
}

export interface VideoItem {
  id: string;
  title: string;
  thumbnail: string;
  duration: string;
  src: string;
  /** Upload progress 0-100, undefined means not uploading */
  uploadProgress?: number;
  /** Available subtitle tracks from embedded MKV subtitles */
  subtitleTracks?: SubtitleTrack[];
}

// Accepted video file extensions
const VIDEO_ACCEPT = "video/*,.mkv,.avi,.wmv,.flv,.m4v,.ts,.mts,.3gp,.rmvb,.rm,.mov";

const MAX_UPLOAD_FILES = 5;

interface PlaylistSidebarProps {
  videos: VideoItem[];
  currentVideoId: string | null;
  onSelectVideo: (video: VideoItem) => void;
  onDeleteVideo: (id: string) => void;
  onUploadVideos: (files: File[]) => void;
  isOpen: boolean;
}

export function PlaylistSidebar({
  videos,
  currentVideoId,
  onSelectVideo,
  onDeleteVideo,
  onUploadVideos,
  isOpen,
}: PlaylistSidebarProps) {
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const filterVideoFiles = (files: File[]): File[] => {
    const videoExts = /\.(mp4|webm|ogg|ogv|mov|mkv|avi|wmv|flv|m4v|ts|mts|3gp|rmvb|rm)$/i;
    return files
      .filter((file) => file.type.startsWith("video/") || videoExts.test(file.name))
      .slice(0, MAX_UPLOAD_FILES);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const videoFiles = filterVideoFiles(Array.from(e.dataTransfer.files));
    if (videoFiles.length > 0) {
      onUploadVideos(videoFiles);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const videoFiles = filterVideoFiles(Array.from(e.target.files || []));
    if (videoFiles.length > 0) {
      onUploadVideos(videoFiles);
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
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <div className="w-10 h-10 rounded-full bg-sidebar-accent flex items-center justify-center">
              <Upload className="w-5 h-5" />
            </div>
            <span className="text-sm">拖放或点击上传</span>
            <span className="text-xs opacity-60">支持多选，最多 {MAX_UPLOAD_FILES} 个视频</span>
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
                {/* Video Icon */}
                <div className="relative w-10 h-10 rounded-lg bg-sidebar-accent flex-shrink-0 flex items-center justify-center">
                  {video.uploadProgress !== undefined ? (
                    /* Uploading: circular progress indicator */
                    <div className="relative w-8 h-8">
                      <svg className="w-8 h-8 -rotate-90" viewBox="0 0 32 32">
                        <circle
                          cx="16" cy="16" r="13"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          className="text-muted-foreground/20"
                        />
                        <circle
                          cx="16" cy="16" r="13"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeDasharray={`${2 * Math.PI * 13}`}
                          strokeDashoffset={`${2 * Math.PI * 13 * (1 - (video.uploadProgress || 0) / 100)}`}
                          strokeLinecap="round"
                          className="text-primary transition-all duration-300"
                        />
                      </svg>
                      <Upload className="w-3.5 h-3.5 text-primary absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                    </div>
                  ) : currentVideoId === video.id ? (
                    /* Currently playing */
                    <Play className="w-5 h-5 text-primary" fill="currentColor" />
                  ) : (
                    /* Normal video */
                    <Film className="w-5 h-5 text-muted-foreground" />
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0 flex flex-col justify-center">
                  <h3 className="text-sm font-medium text-sidebar-foreground truncate">
                    {video.title}
                  </h3>
                  {video.uploadProgress !== undefined ? (
                    /* Upload progress */
                    <div className="mt-1 w-full">
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
                  ) : (
                    /* Duration & index */
                    <span className="text-xs text-muted-foreground mt-0.5">
                      {video.duration !== "--:--" ? video.duration : ""}{video.duration !== "--:--" ? " · " : ""}#{index + 1}
                    </span>
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
