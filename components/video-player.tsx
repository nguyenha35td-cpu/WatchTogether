"use client";

import { useRef, useState, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  SkipBack,
  SkipForward,
  Subtitles,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";
import type { SubtitleTrack } from "@/components/playlist-sidebar";

// Common language code to display name mapping
function getLanguageLabel(langCode: string): string {
  const map: Record<string, string> = {
    chi: "中文", zho: "中文", zh: "中文",
    chs: "简体中文", cht: "繁体中文",
    eng: "English", en: "English",
    jpn: "日本語", ja: "日本語",
    kor: "한국어", ko: "한국어",
    spa: "Español", es: "Español",
    fre: "Français", fra: "Français", fr: "Français",
    ger: "Deutsch", deu: "Deutsch", de: "Deutsch",
    rus: "Русский", ru: "Русский",
    por: "Português", pt: "Português",
    ita: "Italiano", it: "Italiano",
    ara: "العربية", ar: "العربية",
    tha: "ไทย", th: "ไทย",
    vie: "Tiếng Việt", vi: "Tiếng Việt",
    und: "未知语言",
  };
  return map[langCode.toLowerCase()] || langCode;
}

export interface VideoPlayerHandle {
  play: () => void;
  pause: () => void;
  seekTo: (time: number) => void;
  getCurrentTime: () => number;
}

interface VideoPlayerProps {
  src: string;
  poster?: string;
  onTimeUpdate?: (time: number) => void;
  onPlay?: () => void;
  onPause?: () => void;
  onSeek?: (time: number) => void;
  isSynced?: boolean;
  subtitleTracks?: SubtitleTrack[];
  activeSubtitleUrl?: string | null;
  onSelectSubtitle?: (track: SubtitleTrack | null) => void;
}

export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  function VideoPlayer(
    {
      src,
      poster,
      onTimeUpdate,
      onPlay,
      onPause,
      onSeek,
      isSynced = false,
      subtitleTracks = [],
      activeSubtitleUrl,
      onSelectSubtitle,
    },
    ref
  ) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(1);
    const [isMuted, setIsMuted] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const [isBuffering, setIsBuffering] = useState(false);
    const [showSubtitleMenu, setShowSubtitleMenu] = useState(false);
    const hideControlsTimeout = useRef<NodeJS.Timeout>();
    // Flag to suppress sync events when a remote command triggers local playback changes
    const isSyncActionRef = useRef(false);

    // Expose imperative handle for remote sync control
    useImperativeHandle(
      ref,
      () => ({
        play: () => {
          if (videoRef.current) {
            isSyncActionRef.current = true;
            videoRef.current.play().finally(() => {
              // Reset after a tick to allow the onPlay event to be suppressed
              setTimeout(() => { isSyncActionRef.current = false; }, 50);
            });
          }
        },
        pause: () => {
          if (videoRef.current) {
            isSyncActionRef.current = true;
            videoRef.current.pause();
            setTimeout(() => { isSyncActionRef.current = false; }, 50);
          }
        },
        seekTo: (time: number) => {
          if (videoRef.current) {
            isSyncActionRef.current = true;
            videoRef.current.currentTime = time;
            setCurrentTime(time);
            setTimeout(() => { isSyncActionRef.current = false; }, 50);
          }
        },
        getCurrentTime: () => {
          return videoRef.current?.currentTime ?? 0;
        },
      }),
      []
    );

    const formatTime = (time: number) => {
      const minutes = Math.floor(time / 60);
      const seconds = Math.floor(time % 60);
      return `${minutes}:${seconds.toString().padStart(2, "0")}`;
    };

    const handlePlayPause = useCallback(() => {
      if (videoRef.current) {
        if (isPlaying) {
          videoRef.current.pause();
        } else {
          videoRef.current.play();
        }
      }
    }, [isPlaying]);

    const handleVideoPlay = useCallback(() => {
      setIsPlaying(true);
      if (!isSyncActionRef.current) {
        onPlay?.();
      }
    }, [onPlay]);

    const handleVideoPause = useCallback(() => {
      setIsPlaying(false);
      setIsBuffering(false); // Clear buffering on pause so we show pause icon, not spinner
      if (!isSyncActionRef.current) {
        onPause?.();
      }
    }, [onPause]);

    const handleTimeUpdate = () => {
      if (videoRef.current) {
        setCurrentTime(videoRef.current.currentTime);
        onTimeUpdate?.(videoRef.current.currentTime);
      }
    };

    const handleSeek = (value: number[]) => {
      if (videoRef.current) {
        videoRef.current.currentTime = value[0];
        setCurrentTime(value[0]);
        onSeek?.(value[0]);
      }
    };

    const handleVolumeChange = (value: number[]) => {
      if (videoRef.current) {
        const newVolume = value[0];
        videoRef.current.volume = newVolume;
        setVolume(newVolume);
        setIsMuted(newVolume === 0);
      }
    };

    const toggleMute = () => {
      if (videoRef.current) {
        videoRef.current.muted = !isMuted;
        setIsMuted(!isMuted);
      }
    };

    const toggleFullscreen = async () => {
      if (!containerRef.current) return;

      if (!isFullscreen) {
        await containerRef.current.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    };

    const skip = (seconds: number) => {
      if (videoRef.current) {
        const newTime = Math.max(
          0,
          Math.min(videoRef.current.currentTime + seconds, duration)
        );
        videoRef.current.currentTime = newTime;
        onSeek?.(newTime);
      }
    };

    const handleMouseMove = () => {
      setShowControls(true);
      if (hideControlsTimeout.current) {
        clearTimeout(hideControlsTimeout.current);
      }
      hideControlsTimeout.current = setTimeout(() => {
        if (isPlaying) {
          setShowControls(false);
        }
      }, 3000);
    };

    useEffect(() => {
      const handleFullscreenChange = () => {
        setIsFullscreen(!!document.fullscreenElement);
      };

      document.addEventListener("fullscreenchange", handleFullscreenChange);
      return () => {
        document.removeEventListener(
          "fullscreenchange",
          handleFullscreenChange
        );
      };
    }, []);

    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        // Don't capture keyboard events when user is typing in an input
        if (
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement
        ) {
          return;
        }
        if (e.code === "Space") {
          e.preventDefault();
          handlePlayPause();
        } else if (e.code === "ArrowLeft") {
          skip(-10);
        } else if (e.code === "ArrowRight") {
          skip(10);
        } else if (e.code === "KeyM") {
          toggleMute();
        } else if (e.code === "KeyF") {
          toggleFullscreen();
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [handlePlayPause, isMuted]);

    // Reset state when src changes
    useEffect(() => {
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      setShowSubtitleMenu(false);
    }, [src]);

    // Activate/deactivate subtitle track when activeSubtitleUrl changes
    useEffect(() => {
      const video = videoRef.current;
      if (!video) return;

      // Need a short delay for the track element to be added to the DOM
      const timer = setTimeout(() => {
        const tracks = video.textTracks;
        for (let i = 0; i < tracks.length; i++) {
          tracks[i].mode = activeSubtitleUrl ? "showing" : "hidden";
        }
      }, 100);

      return () => clearTimeout(timer);
    }, [activeSubtitleUrl]);

    return (
      <div
        ref={containerRef}
        className="relative w-full aspect-video bg-background rounded-xl overflow-hidden group"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => isPlaying && setShowControls(false)}
      >
        {/* Video Element */}
        <video
          ref={videoRef}
          src={src}
          poster={poster}
          crossOrigin="anonymous"
          className="w-full h-full object-contain bg-black"
          onPlay={handleVideoPlay}
          onPause={handleVideoPause}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={() => {
            if (videoRef.current) {
              setDuration(videoRef.current.duration);
            }
          }}
          onWaiting={() => setIsBuffering(true)}
          onPlaying={() => setIsBuffering(false)}
          onClick={handlePlayPause}
        >
          {activeSubtitleUrl && (
            <track
              key={activeSubtitleUrl}
              kind="subtitles"
              src={activeSubtitleUrl}
              default
            />
          )}
        </video>

        {/* Buffering Indicator - only show during playback */}
        {isBuffering && isPlaying && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
            <div className="w-12 h-12 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
          </div>
        )}

        {/* Center Play Button - always show when paused */}
        {!isPlaying && (
          <button
            onClick={handlePlayPause}
            className="absolute inset-0 flex items-center justify-center bg-black/20 transition-opacity"
          >
            <div className="w-20 h-20 rounded-full bg-primary/90 backdrop-blur-sm flex items-center justify-center transition-transform hover:scale-110">
              <Play
                className="w-10 h-10 text-primary-foreground ml-1"
                fill="currentColor"
              />
            </div>
          </button>
        )}

        {/* Sync Badge */}
        {isSynced && (
          <div className="absolute top-4 left-4 px-3 py-1.5 rounded-full bg-primary/20 backdrop-blur-md border border-primary/30 flex items-center gap-2 animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            <span className="text-xs font-medium text-primary">已同步</span>
          </div>
        )}

        {/* Controls Overlay */}
        <div
          className={cn(
            "absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-4 pt-16 transition-opacity duration-300",
            showControls || !isPlaying ? "opacity-100" : "opacity-0"
          )}
        >
          {/* Progress Bar */}
          <div className="mb-4">
            <Slider
              value={[currentTime]}
              max={duration || 100}
              step={0.1}
              onValueChange={handleSeek}
              className="cursor-pointer [&_[data-slot=slider-thumb]]:h-3 [&_[data-slot=slider-thumb]]:w-3 [&_[data-slot=slider-thumb]]:border-2 [&_[data-slot=slider-thumb]]:border-primary [&_[data-slot=slider-thumb]]:bg-primary [&_[data-slot=slider-track]]:h-1 hover:[&_[data-slot=slider-track]]:h-1.5 [&_[data-slot=slider-track]]:transition-all"
            />
          </div>

          {/* Control Buttons */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {/* Play/Pause */}
              <button
                onClick={handlePlayPause}
                className="w-10 h-10 rounded-full bg-foreground/10 hover:bg-foreground/20 flex items-center justify-center transition-colors"
              >
                {isPlaying ? (
                  <Pause
                    className="w-5 h-5 text-foreground"
                    fill="currentColor"
                  />
                ) : (
                  <Play
                    className="w-5 h-5 text-foreground ml-0.5"
                    fill="currentColor"
                  />
                )}
              </button>

              {/* Skip Buttons */}
              <button
                onClick={() => skip(-10)}
                className="w-8 h-8 rounded-full hover:bg-foreground/10 flex items-center justify-center transition-colors"
              >
                <SkipBack className="w-4 h-4 text-foreground/80" />
              </button>
              <button
                onClick={() => skip(10)}
                className="w-8 h-8 rounded-full hover:bg-foreground/10 flex items-center justify-center transition-colors"
              >
                <SkipForward className="w-4 h-4 text-foreground/80" />
              </button>

              {/* Volume */}
              <div className="flex items-center gap-2 group/volume">
                <button
                  onClick={toggleMute}
                  className="w-8 h-8 rounded-full hover:bg-foreground/10 flex items-center justify-center transition-colors"
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="w-4 h-4 text-foreground/80" />
                  ) : (
                    <Volume2 className="w-4 h-4 text-foreground/80" />
                  )}
                </button>
                <div className="w-0 overflow-hidden transition-all duration-300 group-hover/volume:w-20">
                  <Slider
                    value={[isMuted ? 0 : volume]}
                    max={1}
                    step={0.01}
                    onValueChange={handleVolumeChange}
                    className="cursor-pointer"
                  />
                </div>
              </div>

              {/* Time Display */}
              <span className="text-sm text-foreground/70 font-mono">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>

            {/* Right Controls */}
            <div className="flex items-center gap-2">
              {/* Subtitle Selector */}
              {subtitleTracks.length > 0 && (
                <div className="relative">
                  <button
                    onClick={() => setShowSubtitleMenu(!showSubtitleMenu)}
                    className={cn(
                      "w-10 h-10 rounded-full flex items-center justify-center transition-colors",
                      activeSubtitleUrl
                        ? "bg-primary/30 hover:bg-primary/40"
                        : "bg-foreground/10 hover:bg-foreground/20"
                    )}
                    title="字幕"
                  >
                    <Subtitles className={cn(
                      "w-5 h-5",
                      activeSubtitleUrl ? "text-primary" : "text-foreground"
                    )} />
                  </button>

                  {/* Subtitle Menu Popup */}
                  {showSubtitleMenu && (
                    <div className="absolute bottom-12 right-0 min-w-[200px] bg-black/90 backdrop-blur-md rounded-lg border border-white/10 shadow-xl overflow-hidden z-50">
                      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
                        <span className="text-sm font-medium text-white">字幕轨道</span>
                        <button
                          onClick={() => setShowSubtitleMenu(false)}
                          className="w-6 h-6 rounded-full hover:bg-white/10 flex items-center justify-center"
                        >
                          <X className="w-3.5 h-3.5 text-white/60" />
                        </button>
                      </div>
                      <div className="py-1">
                        {/* Off option */}
                        <button
                          onClick={() => {
                            onSelectSubtitle?.(null);
                            setShowSubtitleMenu(false);
                          }}
                          className={cn(
                            "w-full px-3 py-2 text-left text-sm hover:bg-white/10 transition-colors flex items-center gap-2",
                            !activeSubtitleUrl ? "text-primary" : "text-white/80"
                          )}
                        >
                          <div className={cn(
                            "w-2 h-2 rounded-full flex-shrink-0",
                            !activeSubtitleUrl ? "bg-primary" : "bg-transparent"
                          )} />
                          关闭字幕
                        </button>

                        {/* Subtitle tracks */}
                        {subtitleTracks.map((track) => {
                          const label = track.title || getLanguageLabel(track.language) || `字幕轨 ${track.streamIndex + 1}`;
                          const isActive = activeSubtitleUrl === track.vttUrl && !!track.vttUrl;
                          return (
                            <button
                              key={track.streamIndex}
                              onClick={() => {
                                onSelectSubtitle?.(track);
                                setShowSubtitleMenu(false);
                              }}
                              className={cn(
                                "w-full px-3 py-2 text-left text-sm hover:bg-white/10 transition-colors flex items-center gap-2",
                                isActive ? "text-primary" : "text-white/80"
                              )}
                            >
                              <div className={cn(
                                "w-2 h-2 rounded-full flex-shrink-0",
                                isActive ? "bg-primary" : "bg-transparent"
                              )} />
                              <span className="truncate">{label}</span>
                              {track.language && (
                                <span className="text-xs text-white/40 ml-auto flex-shrink-0">
                                  {track.language.toUpperCase()}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <button
                onClick={toggleFullscreen}
                className="w-10 h-10 rounded-full bg-foreground/10 hover:bg-foreground/20 flex items-center justify-center transition-colors"
              >
                {isFullscreen ? (
                  <Minimize className="w-5 h-5 text-foreground" />
                ) : (
                  <Maximize className="w-5 h-5 text-foreground" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
);
