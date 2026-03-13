"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Header } from "@/components/header";
import { PlaylistSidebar, VideoItem, SubtitleTrack } from "@/components/playlist-sidebar";
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
  const [activeSubtitleUrl, setActiveSubtitleUrl] = useState<string | null>(null);
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
      // When creating a room, keep our local playlist
    },

    onRoomJoined: (joinedRoomId, newClientId, room) => {
      setRoomId(joinedRoomId);
      setClientId(newClientId);
      setParticipants(room.participants);
      setVideos((prev) =>
        room.playlist.length > 0
          ? room.playlist.map((v) => {
              const existing = prev.find((p) => p.id === v.id);
              return {
                id: v.id,
                title: v.title,
                thumbnail: v.thumbnail,
                duration: v.duration,
                src: v.src,
                ...(existing?.subtitleTracks ? { subtitleTracks: existing.subtitleTracks } : {}),
              };
            })
          : []
      );
      // Set current video if room has one
      if (room.currentVideoId) {
        const video = room.playlist.find((v) => v.id === room.currentVideoId);
        if (video) {
          setCurrentVideo((prev) => ({
            id: video.id,
            title: video.title,
            thumbnail: video.thumbnail,
            duration: video.duration,
            src: video.src,
            ...(prev?.subtitleTracks ? { subtitleTracks: prev.subtitleTracks } : {}),
          }));
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
      // Merge server playlist while preserving local uploading entries AND subtitleTracks
      setVideos((prev) => {
        const uploadingVideos = prev.filter(
          (v) => v.uploadProgress !== undefined
        );
        const serverVideos = playlist.map((v) => {
          // Preserve locally-probed subtitleTracks if server doesn't carry them
          const existing = prev.find((p) => p.id === v.id);
          return {
            id: v.id,
            title: v.title,
            thumbnail: v.thumbnail,
            duration: v.duration,
            src: v.src,
            ...(existing?.subtitleTracks ? { subtitleTracks: existing.subtitleTracks } : {}),
          };
        });
        // Append uploading entries that aren't yet in the server list
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
            setCurrentVideo({
              id: video.id,
              title: video.title,
              thumbnail: video.thumbnail,
              duration: video.duration,
              src: video.src,
            });
          }
        }
      }
    },

    onVideoChanged: (videoId) => {
      const video = videos.find((v) => v.id === videoId);
      if (video) {
        setCurrentVideo(video);
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
        setVideos((prev) =>
          state.playlist.map((v) => {
            const existing = prev.find((p) => p.id === v.id);
            return {
              id: v.id,
              title: v.title,
              thumbnail: v.thumbnail,
              duration: v.duration,
              src: v.src,
              ...(existing?.subtitleTracks ? { subtitleTracks: existing.subtitleTracks } : {}),
            };
          })
        );
      }
      if (state.currentVideoId) {
        const video = state.playlist.find(
          (v) => v.id === state.currentVideoId
        );
        if (video) {
          setCurrentVideo((prev) => ({
            id: video.id,
            title: video.title,
            thumbnail: video.thumbnail,
            duration: video.duration,
            src: video.src,
            ...(prev?.subtitleTracks ? { subtitleTracks: prev.subtitleTracks } : {}),
          }));
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

  // ==================== Subtitle Helpers (moved before handleSelectVideo) ====================
  const backendUrl =
    process.env.NEXT_PUBLIC_API_URL ||
    "https://watchtogether-production-b75c.up.railway.app";

  // Extract filename from video URL like "https://...railway.app/uploads/1234-5678.mkv"
  const extractFilenameFromUrl = useCallback((videoSrc: string): string | null => {
    const match = videoSrc.match(/\/uploads\/([^/?#]+)/);
    return match ? match[1] : null;
  }, []);

  // Probe subtitle tracks for a video file via backend API
  const probeSubtitleTracks = useCallback(async (videoSrc: string): Promise<SubtitleTrack[]> => {
    const filename = extractFilenameFromUrl(videoSrc);
    if (!filename) return [];

    try {
      const res = await fetch(`${backendUrl}/api/subtitles/${encodeURIComponent(filename)}`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.tracks || [];
    } catch (err) {
      console.error("Failed to probe subtitles:", err);
      return [];
    }
  }, [backendUrl, extractFilenameFromUrl]);

  // ==================== Video Actions ====================
  const handleSelectVideo = useCallback(
    (video: VideoItem) => {
      setCurrentVideo(video);
      setActiveSubtitleUrl(null); // Reset subtitle when changing video
      setIsSynced(false);
      ws.selectVideo(video.id);
      // Optimistically restore sync status
      setTimeout(() => setIsSynced(true), 500);

      // Auto-probe subtitles if not yet probed and is an uploaded file
      if (!video.subtitleTracks && video.src.includes("/uploads/")) {
        probeSubtitleTracks(video.src).then((tracks) => {
          if (tracks.length > 0) {
            setVideos((prev) =>
              prev.map((v) =>
                v.id === video.id ? { ...v, subtitleTracks: tracks } : v
              )
            );
            setCurrentVideo((prev) =>
              prev && prev.id === video.id ? { ...prev, subtitleTracks: tracks } : prev
            );
          }
        });
      }
    },
    [ws, probeSubtitleTracks]
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

  // ==================== Sync currentVideo with videos array ====================
  // When videos array is updated (e.g. subtitleTracks added), sync currentVideo
  useEffect(() => {
    if (!currentVideo) return;
    const updated = videos.find((v) => v.id === currentVideo.id);
    if (!updated) return;
    // Only update if subtitleTracks changed (avoid infinite loops)
    if (
      updated.subtitleTracks &&
      updated.subtitleTracks !== currentVideo.subtitleTracks
    ) {
      setCurrentVideo((prev) =>
        prev ? { ...prev, subtitleTracks: updated.subtitleTracks } : prev
      );
    }
  }, [videos, currentVideo]);

  // ==================== Subtitle Extraction ====================

  // Extract a specific subtitle track VTT
  const extractSubtitleVTT = useCallback(async (videoSrc: string, streamIndex: number): Promise<string | null> => {
    const filename = extractFilenameFromUrl(videoSrc);
    if (!filename) return null;

    try {
      const res = await fetch(`${backendUrl}/api/subtitles/${encodeURIComponent(filename)}/${streamIndex}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.url ? `${backendUrl}${data.url}` : null;
    } catch (err) {
      console.error("Failed to extract subtitle:", err);
      return null;
    }
  }, [backendUrl, extractFilenameFromUrl]);

  // Handle subtitle track selection
  const handleSelectSubtitle = useCallback(async (track: SubtitleTrack | null) => {
    if (!track) {
      setActiveSubtitleUrl(null);
      return;
    }

    // If VTT URL already cached, use it directly
    if (track.vttUrl) {
      setActiveSubtitleUrl(track.vttUrl);
      return;
    }

    // Extract the VTT on demand
    if (!currentVideo?.src) return;
    const vttUrl = await extractSubtitleVTT(currentVideo.src, track.streamIndex);
    if (vttUrl) {
      // Update the track's vttUrl in state
      setVideos(prev => prev.map(v => {
        if (v.id !== currentVideo.id) return v;
        return {
          ...v,
          subtitleTracks: v.subtitleTracks?.map(t =>
            t.streamIndex === track.streamIndex ? { ...t, vttUrl } : t
          ),
        };
      }));
      setActiveSubtitleUrl(vttUrl);
    }
  }, [currentVideo, extractSubtitleVTT]);

  // ==================== Video Upload ====================

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

      const formData = new FormData();
      formData.append("video", file);

      // Use XMLHttpRequest to track upload progress
      const xhr = new XMLHttpRequest();

      const uploadPromise = new Promise<{ url: string }>((resolve, reject) => {
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            setVideos((prev) =>
              prev.map((v) =>
                v.id === tempId ? { ...v, uploadProgress: pct } : v
              )
            );
          }
        });

        xhr.addEventListener("load", () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch {
              reject(new Error("服务器返回格式错误"));
            }
          } else {
            try {
              const errData = JSON.parse(xhr.responseText);
              reject(new Error(errData.error || `上传失败 (HTTP ${xhr.status})`));
            } catch {
              reject(new Error(`上传失败 (HTTP ${xhr.status})`));
            }
          }
        });

        xhr.addEventListener("error", () => reject(new Error("网络错误，上传失败")));
        xhr.addEventListener("abort", () => reject(new Error("上传已取消")));

        xhr.open("POST", `${backendUrl}/api/upload`);
        xhr.send(formData);
      });

      try {
        const data = await uploadPromise;
        const videoUrl = `${backendUrl}${data.url}`;

        // Probe video duration using a temporary video element
        const durationStr = await new Promise<string>((resolve) => {
          const probe = document.createElement("video");
          probe.preload = "metadata";
          probe.onloadedmetadata = () => {
            const dur = probe.duration;
            if (dur && isFinite(dur)) {
              const m = Math.floor(dur / 60);
              const s = Math.floor(dur % 60);
              resolve(`${m}:${s.toString().padStart(2, "0")}`);
            } else {
              resolve("--:--");
            }
            probe.src = ""; // release
          };
          probe.onerror = () => resolve("--:--");
          probe.src = videoUrl;
        });

        const newVideo: VideoItem = {
          id: tempId,
          title: file.name.replace(/\.[^/.]+$/, ""),
          thumbnail: "",
          duration: durationStr,
          src: videoUrl,
        };

        // First update the video entry with the finalized info
        setVideos((prev) =>
          prev.map((v) => (v.id === tempId ? newVideo : v))
        );
        ws.addToPlaylist(newVideo);

        // Probe subtitle tracks AFTER the video entry is finalized
        // Use merge update to avoid overwriting
        probeSubtitleTracks(videoUrl).then((tracks) => {
          if (tracks.length > 0) {
            setVideos((prev) =>
              prev.map((v) =>
                v.id === tempId ? { ...v, subtitleTracks: tracks } : v
              )
            );
          }
        });
      } catch (err) {
        console.error("Upload failed:", err);
        // Remove the temp entry on failure
        setVideos((prev) => prev.filter((v) => v.id !== tempId));
        alert(`${file.name}: ${err instanceof Error ? err.message : "上传失败，请重试"}`);
      }
    },
    [ws, probeSubtitleTracks]
  );

  const handleUploadVideos = useCallback(
    (files: File[]) => {
      // Upload each file independently in parallel
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
                  subtitleTracks={currentVideo.subtitleTracks || []}
                  activeSubtitleUrl={activeSubtitleUrl}
                  onSelectSubtitle={handleSelectSubtitle}
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
                        title: "多种格式",
                        desc: "支持常见视频格式",
                      },
                      {
                        icon: Users,
                        title: "实时同步",
                        desc: "与好友同步播放",
                      },
                      {
                        icon: Zap,
                        title: "流畅体验",
                        desc: "低延迟高质量",
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
