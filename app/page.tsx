"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Header } from "@/components/header";
import { PlaylistSidebar, VideoItem } from "@/components/playlist-sidebar";
import { VideoPlayer, VideoPlayerHandle } from "@/components/video-player";
import { RoomJoin } from "@/components/room-join";
import { Film, MonitorPlay, Users, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWebSocket, Participant, RoomInfo } from "@/hooks/use-websocket";

// Sample demo videos for pre-filling when creating a room
const DEMO_VIDEOS: VideoItem[] = [
  {
    id: "1",
    title: "Big Buck Bunny",
    thumbnail:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Big_buck_bunny_poster_big.jpg/220px-Big_buck_bunny_poster_big.jpg",
    duration: "9:56",
    src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
  },
];

// ==================== API Base URL ====================
// 前端在 80 端口，后端在 3001 端口，浏览器直接请求后端
function getApiBase() {
  if (typeof window === "undefined") return "http://localhost:3001";
  return `${window.location.protocol}//${window.location.hostname}:3001`;
}

// ==================== VOD Play URL Helper ====================

async function fetchVodPlayUrl(fileId: string): Promise<string | null> {
  try {
    const res = await fetch(`${getApiBase()}/api/video/${fileId}/playurl`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.playUrl || null;
  } catch (err) {
    console.error("[VOD] Failed to fetch play URL for", fileId, err);
    return null;
  }
}

export default function WatchTogetherPage() {
  // ==================== Room State ====================
  const [inRoom, setInRoom] = useState(false);
  const [roomId, setRoomId] = useState("");
  const [clientId, setClientId] = useState("");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);

  // ==================== Video State ====================
  const [videos, setVideos] = useState<VideoItem[]>(DEMO_VIDEOS);
  const [currentVideo, setCurrentVideo] = useState<VideoItem | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isSynced, setIsSynced] = useState(true);
  const playerRef = useRef<VideoPlayerHandle>(null);

  // Track pending room action for when WebSocket connects
  const pendingActionRef = useRef<{
    type: "create" | "join";
    userName: string;
    roomCode?: string;
  } | null>(null);

  // ==================== WebSocket ====================
  const ws = useWebSocket({
    onRoomCreated: (newRoomId, newClientId, room) => {
      setRoomId(newRoomId);
      setClientId(newClientId);
      setParticipants(room.participants);
      setInRoom(true);
      setIsJoining(false);
      setJoinError(null);
    },

    onRoomJoined: (joinedRoomId, newClientId, room) => {
      setRoomId(joinedRoomId);
      setClientId(newClientId);
      setParticipants(room.participants);
      setVideos((prev) =>
        room.playlist.length > 0
          ? room.playlist.map((v) => ({
              id: v.id,
              title: v.title,
              thumbnail: v.thumbnail,
              duration: v.duration,
              src: v.src,
            }))
          : []
      );
      // Set current video if room has one
      if (room.currentVideoId) {
        const video = room.playlist.find((v) => v.id === room.currentVideoId);
        if (video) {
          handleSelectVideoFromSync(video);
        }
      }
      setInRoom(true);
      setIsJoining(false);
      setJoinError(null);
      setIsSynced(true);

      // Sync playback state after a short delay to allow video element to mount
      if (room.currentVideoId && room.playbackState) {
        setTimeout(() => {
          if (playerRef.current) {
            const elapsed = room.playbackState.isPlaying
              ? (Date.now() - room.playbackState.lastUpdate) / 1000
              : 0;
            const syncTime = room.playbackState.currentTime + elapsed;
            playerRef.current.seekTo(syncTime);
            if (room.playbackState.isPlaying) {
              playerRef.current.play();
            }
          }
        }, 500);
      }
    },

    onError: (message) => {
      setJoinError(message);
      setIsJoining(false);
    },

    onParticipantJoined: (newParticipants) => {
      setParticipants(newParticipants);
    },

    onParticipantLeft: (newParticipants) => {
      setParticipants(newParticipants);
    },

    onPlaylistUpdated: (playlist, updatedCurrentVideoId) => {
      setVideos((prev) => {
        const uploadingVideos = prev.filter(
          (v) => v.uploadProgress !== undefined
        );
        const serverVideos = playlist.map((v) => ({
          id: v.id,
          title: v.title,
          thumbnail: v.thumbnail,
          duration: v.duration,
          src: v.src,
        }));
        const uploadingNotInServer = uploadingVideos.filter(
          (u) => !serverVideos.some((s) => s.id === u.id)
        );
        return [...serverVideos, ...uploadingNotInServer];
      });
      if (updatedCurrentVideoId !== undefined) {
        if (updatedCurrentVideoId === null) {
          setCurrentVideo(null);
        } else {
          const video = playlist.find((v) => v.id === updatedCurrentVideoId);
          if (video) {
            handleSelectVideoFromSync(video);
          }
        }
      }
    },

    onVideoChanged: (videoId) => {
      const video = videos.find((v) => v.id === videoId);
      if (video) {
        handleSelectVideoFromSync(video);
        setIsSynced(true);
      }
    },

    onSyncPlay: (currentTime) => {
      setIsSynced(true);
      if (playerRef.current) {
        playerRef.current.seekTo(currentTime);
        playerRef.current.play();
      }
    },

    onSyncPause: (currentTime) => {
      setIsSynced(true);
      if (playerRef.current) {
        playerRef.current.seekTo(currentTime);
        playerRef.current.pause();
      }
    },

    onSyncSeek: (currentTime) => {
      setIsSynced(true);
      if (playerRef.current) {
        playerRef.current.seekTo(currentTime);
      }
    },

    onSyncState: (state) => {
      if (state.playlist.length > 0) {
        setVideos(
          state.playlist.map((v) => ({
            id: v.id,
            title: v.title,
            thumbnail: v.thumbnail,
            duration: v.duration,
            src: v.src,
          }))
        );
      }
      if (state.currentVideoId) {
        const video = state.playlist.find(
          (v) => v.id === state.currentVideoId
        );
        if (video) {
          handleSelectVideoFromSync(video);
        }
      }
      setIsSynced(true);
    },

    onConnectionChange: (connected) => {
      if (connected && pendingActionRef.current) {
        const action = pendingActionRef.current;
        pendingActionRef.current = null;
        if (action.type === "create") {
          ws.createRoom(action.userName, DEMO_VIDEOS);
        } else if (action.type === "join" && action.roomCode) {
          ws.joinRoom(action.roomCode, action.userName);
        }
      }
      if (!connected && inRoom) {
        setIsSynced(false);
      }
    },
  });

  // ==================== Auto-open sidebar on desktop ====================
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 768) {
        setIsSidebarOpen(true);
      }
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // ==================== Room Actions ====================
  const handleCreateRoom = useCallback(
    (userName: string) => {
      setIsJoining(true);
      setJoinError(null);
      pendingActionRef.current = { type: "create", userName };
      ws.connect();
    },
    [ws]
  );

  const handleJoinRoom = useCallback(
    (roomCode: string, userName: string) => {
      setIsJoining(true);
      setJoinError(null);
      pendingActionRef.current = { type: "join", userName, roomCode };
      ws.connect();
    },
    [ws]
  );

  const handleLeaveRoom = useCallback(() => {
    ws.leaveRoom();
    ws.disconnect();
    setInRoom(false);
    setRoomId("");
    setClientId("");
    setParticipants([]);
    setCurrentVideo(null);
    setVideos(DEMO_VIDEOS);
    setIsSynced(true);
  }, [ws]);

  // ==================== VOD Video Selection ====================

  // Helper: when selecting a VOD video (src = "vod://<fileId>"), resolve play URL
  const handleSelectVideoFromSync = useCallback(
    async (video: { id: string; title: string; thumbnail: string; duration: string; src: string }) => {
      if (video.src.startsWith("vod://")) {
        const fileId = video.src.replace("vod://", "");
        const playUrl = await fetchVodPlayUrl(fileId);
        setCurrentVideo({
          id: video.id,
          title: video.title,
          thumbnail: video.thumbnail,
          duration: video.duration,
          src: playUrl || video.src,
          vodFileId: fileId,
        });
      } else {
        setCurrentVideo({
          id: video.id,
          title: video.title,
          thumbnail: video.thumbnail,
          duration: video.duration,
          src: video.src,
        });
      }
    },
    []
  );

  // ==================== Video Actions ====================
  const handleSelectVideo = useCallback(
    async (video: VideoItem) => {
      setIsSynced(false);
      ws.selectVideo(video.id);
      setTimeout(() => setIsSynced(true), 500);

      if (video.src.startsWith("vod://")) {
        const fileId = video.src.replace("vod://", "");
        const playUrl = await fetchVodPlayUrl(fileId);
        setCurrentVideo({
          ...video,
          src: playUrl || video.src,
          vodFileId: fileId,
        });
      } else {
        setCurrentVideo(video);
      }
    },
    [ws]
  );

  const handleDeleteVideo = useCallback(
    (id: string) => {
      setVideos((prev) => prev.filter((v) => v.id !== id));
      if (currentVideo?.id === id) {
        setCurrentVideo(null);
      }
      ws.removeFromPlaylist(id);
    },
    [currentVideo, ws]
  );

  // ==================== VOD Upload ====================

  const uploadSingleVideo = useCallback(
    async (file: File) => {
      // Show a temporary entry with upload progress
      const tempId = Date.now().toString() + Math.random().toString(36).slice(2, 6);
      const tempVideo: VideoItem = {
        id: tempId,
        title: file.name.replace(/\.[^/.]+$/, ""),
        thumbnail: "",
        duration: "--:--",
        src: "",
        uploadProgress: 0,
      };
      setVideos((prev) => [...prev, tempVideo]);

      try {
        // Dynamically import VOD upload SDK
        const TcVod = (await import("vod-js-sdk-v6")).default;

        const tcVod = new TcVod({
          getSignature: async () => {
            const res = await fetch("/api/upload/vod-signature");
            if (!res.ok) throw new Error("获取上传签名失败");
            const data = await res.json();
            return data.signature;
          },
        });

        const uploader = tcVod.upload({ mediaFile: file });

        // Track upload progress
        uploader.on("media_progress", (info: { percent: number }) => {
          const pct = Math.round(info.percent * 100);
          setVideos((prev) =>
            prev.map((v) =>
              v.id === tempId ? { ...v, uploadProgress: pct } : v
            )
          );
        });

        // Wait for upload to complete
        const result = await uploader.done();
        const fileId = result.fileId;

        console.log("[VOD] Upload complete, fileId:", fileId);

        // Trigger transcoding on backend
        try {
          await fetch(`${getApiBase()}/api/upload/vod-complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileId }),
          });
          console.log("[VOD] Transcode triggered for fileId:", fileId);
        } catch (err) {
          console.warn("[VOD] Transcode trigger failed (non-fatal):", err);
        }

        // Use vod:// protocol to store fileId as video source
        // Actual play URL will be resolved when video is selected
        const vodSrc = `vod://${fileId}`;

        const newVideo: VideoItem = {
          id: tempId,
          title: file.name.replace(/\.[^/.]+$/, ""),
          thumbnail: "",
          duration: "--:--",
          src: vodSrc,
          vodFileId: fileId,
        };

        setVideos((prev) =>
          prev.map((v) => (v.id === tempId ? newVideo : v))
        );
        ws.addToPlaylist(newVideo);
      } catch (err) {
        console.error("[VOD] Upload failed:", err);
        setVideos((prev) => prev.filter((v) => v.id !== tempId));
        alert(`${file.name}: ${err instanceof Error ? err.message : "上传失败，请重试"}`);
      }
    },
    [ws]
  );

  const handleUploadVideos = useCallback(
    (files: File[]) => {
      files.forEach((file) => uploadSingleVideo(file));
    },
    [uploadSingleVideo]
  );

  // ==================== Sync Actions ====================
  const handleSync = useCallback(() => {
    setIsSynced(false);
    ws.requestSync();
    setTimeout(() => setIsSynced(true), 1000);
  }, [ws]);

  const handlePlayerPlay = useCallback(() => {
    const time = playerRef.current?.getCurrentTime() ?? 0;
    ws.sendPlay(time);
    setIsSynced(true);
  }, [ws]);

  const handlePlayerPause = useCallback(() => {
    const time = playerRef.current?.getCurrentTime() ?? 0;
    ws.sendPause(time);
    setIsSynced(true);
  }, [ws]);

  const handlePlayerSeek = useCallback(
    (time: number) => {
      ws.sendSeek(time);
      setIsSynced(false);
      setTimeout(() => setIsSynced(true), 300);
    },
    [ws]
  );

  const handleTimeUpdate = useCallback((_time: number) => {
    // Could be used for periodic sync verification in the future
  }, []);

  // ==================== Render ====================

  // If not in a room, show the join/create screen
  if (!inRoom) {
    return (
      <RoomJoin
        onCreateRoom={handleCreateRoom}
        onJoinRoom={handleJoinRoom}
        isConnecting={isJoining}
        error={joinError}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
        roomId={roomId}
        participants={participants}
        isConnected={ws.isConnected}
        isSynced={isSynced}
        onSync={handleSync}
        onLeaveRoom={handleLeaveRoom}
        clientId={clientId}
      />

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar - Hidden on mobile, visible on md+ */}
        <div className="hidden md:block">
          <PlaylistSidebar
            videos={videos}
            currentVideoId={currentVideo?.id ?? null}
            onSelectVideo={handleSelectVideo}
            onDeleteVideo={handleDeleteVideo}
            onUploadVideos={handleUploadVideos}
            isOpen={isSidebarOpen}
          />
        </div>

        {/* Main Content */}
        <main className="flex-1 overflow-auto">
          <div className="p-4 md:p-6 lg:p-8 max-w-6xl mx-auto">
            {currentVideo ? (
              <div className="space-y-4">
                {/* Video Player */}
                <VideoPlayer
                  ref={playerRef}
                  src={currentVideo.src}
                  poster={currentVideo.thumbnail}
                  isSynced={isSynced}
                  onTimeUpdate={handleTimeUpdate}
                  onPlay={handlePlayerPlay}
                  onPause={handlePlayerPause}
                  onSeek={handlePlayerSeek}
                />

                {/* Video Info */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-semibold text-foreground text-balance">
                      {currentVideo.title}
                    </h2>
                    <p className="text-sm text-muted-foreground mt-1">
                      正在与 {participants.length} 人一起观看
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {isSynced && (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-medium">
                        <Zap className="w-4 h-4" />
                        播放已同步
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              /* Empty State */
              <div className="h-full min-h-[60vh] flex items-center justify-center">
                <div className="text-center max-w-md mx-auto px-4">
                  {/* Animated Icon */}
                  <div className="relative w-24 h-24 mx-auto mb-6">
                    <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 animate-pulse" />
                    <div className="absolute inset-2 rounded-xl bg-card flex items-center justify-center">
                      <MonitorPlay className="w-10 h-10 text-primary" />
                    </div>
                  </div>

                  <h2 className="text-2xl font-bold text-foreground mb-2 text-balance">
                    选择视频开始观看
                  </h2>
                  <p className="text-muted-foreground mb-8 text-balance">
                    从左侧播放列表选择视频，或上传您自己的视频文件，与朋友一起同步观看。
                  </p>

                  {/* Features */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-left">
                    {[
                      {
                        icon: Film,
                        title: "云端存储",
                        desc: "视频上传至腾讯云",
                      },
                      {
                        icon: Users,
                        title: "实时同步",
                        desc: "与好友同步播放",
                      },
                      {
                        icon: Zap,
                        title: "自适应码率",
                        desc: "CDN 加速 HLS 流",
                      },
                    ].map((feature, i) => (
                      <div
                        key={i}
                        className="p-4 rounded-xl bg-card border border-border"
                      >
                        <feature.icon className="w-6 h-6 text-primary mb-2" />
                        <h3 className="text-sm font-medium text-foreground">
                          {feature.title}
                        </h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {feature.desc}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Mobile sidebar overlay */}
      <div
        className={cn(
          "fixed inset-0 bg-black/60 backdrop-blur-sm z-30 md:hidden transition-opacity duration-300",
          isSidebarOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onClick={() => setIsSidebarOpen(false)}
      />

      {/* Mobile sidebar */}
      <div
        className={cn(
          "fixed top-16 left-0 bottom-0 z-40 md:hidden transition-transform duration-300 ease-out",
          isSidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <PlaylistSidebar
          videos={videos}
          currentVideoId={currentVideo?.id ?? null}
          onSelectVideo={(video) => {
            handleSelectVideo(video);
            setIsSidebarOpen(false);
          }}
          onDeleteVideo={handleDeleteVideo}
          onUploadVideos={handleUploadVideos}
          isOpen={true}
        />
      </div>
    </div>
  );
}
