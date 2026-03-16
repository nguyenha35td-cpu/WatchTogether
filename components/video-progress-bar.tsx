"use client";

import { useRef, useState, useCallback, useEffect, memo } from "react";

interface VideoProgressBarProps {
  currentTime: number;
  duration: number;
  videoSrc: string;
  onSeek: (time: number) => void;
  formatTime: (time: number) => string;
}

export const VideoProgressBar = memo(function VideoProgressBar({
  currentTime,
  duration,
  videoSrc,
  onSeek,
  formatTime,
}: VideoProgressBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const hoverFillRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timeLabelRef = useRef<HTMLSpanElement>(null);
  const previewImgRef = useRef<HTMLImageElement>(null);
  const previewBoxRef = useRef<HTMLDivElement>(null);

  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastPreviewTimeRef = useRef<number>(-1);
  const pendingSeekTimeRef = useRef<number | null>(null);
  const isSeekingRef = useRef(false);

  // Use refs for drag/hover state to avoid React re-render latency
  const isDraggingRef = useRef(false);
  const isHoveringRef = useRef(false);
  const hoverTimeRef = useRef(0);

  // Only use state for things that need to trigger re-renders
  const [previewReady, setPreviewReady] = useState(false);

  // --- Direct DOM updates (no React re-render) ---

  const updateTooltipPosition = useCallback((x: number, time: number) => {
    const track = trackRef.current;
    const tooltip = tooltipRef.current;
    const timeLabel = timeLabelRef.current;
    if (!track || !tooltip || !timeLabel) return;

    const rect = track.getBoundingClientRect();
    const previewImg = previewImgRef.current;
    const hasPreview = previewImg && previewImg.src && previewImg.naturalWidth > 0;
    const tooltipWidth = hasPreview ? 200 : 64;
    const halfTooltip = tooltipWidth / 2;
    const clampedX = Math.max(halfTooltip, Math.min(x, rect.width - halfTooltip));

    tooltip.style.left = `${clampedX}px`;
    tooltip.style.display = "block";
    timeLabel.textContent = formatTime(time);
  }, [formatTime]);

  const hideTooltip = useCallback(() => {
    const tooltip = tooltipRef.current;
    if (tooltip) tooltip.style.display = "none";
  }, []);

  const updateProgress = useCallback((percent: number) => {
    const fill = fillRef.current;
    const thumb = thumbRef.current;
    if (fill) fill.style.width = `${percent}%`;
    if (thumb) thumb.style.left = `${percent}%`;
  }, []);

  const updateHoverFill = useCallback((percent: number, show: boolean) => {
    const hoverFill = hoverFillRef.current;
    if (!hoverFill) return;
    if (show) {
      hoverFill.style.width = `${percent}%`;
      hoverFill.style.display = "block";
    } else {
      hoverFill.style.display = "none";
    }
  }, []);

  const showThumb = useCallback((active: boolean) => {
    const thumb = thumbRef.current;
    if (!thumb) return;
    const dot = thumb.firstElementChild as HTMLDivElement | null;
    if (!dot) return;
    if (active) {
      dot.classList.add("scale-100", "w-4", "h-4");
      dot.classList.remove("scale-0", "w-3", "h-3");
    } else {
      dot.classList.remove("w-4", "h-4");
      dot.classList.add("w-3", "h-3");
      // Don't remove scale-100 — let group-hover handle it
    }
  }, []);

  // --- Update progress bar from currentTime (when not dragging) ---
  useEffect(() => {
    if (isDraggingRef.current) return;
    const percent = duration > 0 ? (currentTime / duration) * 100 : 0;
    updateProgress(percent);
  }, [currentTime, duration, updateProgress]);

  // Capture a frame from the preview video and show it
  const captureFrame = useCallback(() => {
    const video = previewVideoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    try {
      const ctx = canvas.getContext("2d");
      if (ctx && previewImgRef.current && previewBoxRef.current) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const url = canvas.toDataURL("image/jpeg", 0.6);
        previewImgRef.current.src = url;
        previewBoxRef.current.style.display = "block";
      }
    } catch {
      // Cross-origin or other canvas errors — silently ignore
    }
  }, []);

  // Process the next pending seek if any
  const processPendingSeek = useCallback(() => {
    const video = previewVideoRef.current;
    if (!video || pendingSeekTimeRef.current === null) {
      isSeekingRef.current = false;
      return;
    }
    const nextTime = pendingSeekTimeRef.current;
    pendingSeekTimeRef.current = null;
    lastPreviewTimeRef.current = nextTime;
    video.currentTime = Math.max(0, Math.min(nextTime, (duration || 1) - 0.1));
  }, [duration]);

  // --- Preview video setup ---
  useEffect(() => {
    if (!videoSrc) return;

    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.autoplay = false;

    const canvas = document.createElement("canvas");
    canvas.width = 192;
    canvas.height = 108;

    video.addEventListener("loadeddata", () => {
      setPreviewReady(true);
    });

    // When seek completes: capture frame, then process any pending seek
    video.addEventListener("seeked", () => {
      captureFrame();
      // If there's a newer seek queued, process it; otherwise mark as idle
      if (pendingSeekTimeRef.current !== null) {
        processPendingSeek();
      } else {
        isSeekingRef.current = false;
      }
    });

    // Handle seek stalling: if seeking takes too long, force process next
    video.addEventListener("stalled", () => {
      if (pendingSeekTimeRef.current !== null) {
        processPendingSeek();
      }
    });

    const isHls = videoSrc.endsWith(".m3u8") || videoSrc.includes(".m3u8");

    if (isHls) {
      import("hls.js").then(({ default: Hls }) => {
        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: false,
            lowLatencyMode: false,
            maxBufferLength: 10,
            maxMaxBufferLength: 30,
          });
          hls.loadSource(videoSrc);
          hls.attachMedia(video);
          (video as HTMLVideoElement & { _hls?: InstanceType<typeof Hls> })._hls = hls;
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = videoSrc;
        }
      });
    } else {
      video.src = videoSrc;
    }

    previewVideoRef.current = video;
    canvasRef.current = canvas;

    return () => {
      const hlsInstance = (video as HTMLVideoElement & { _hls?: { destroy: () => void } })._hls;
      if (hlsInstance) hlsInstance.destroy();
      video.removeAttribute("src");
      video.load();
      previewVideoRef.current = null;
      canvasRef.current = null;
      setPreviewReady(false);
      lastPreviewTimeRef.current = -1;
      pendingSeekTimeRef.current = null;
      isSeekingRef.current = false;
    };
  }, [videoSrc, captureFrame, processPendingSeek]);

  // Generate preview thumbnail — uses a seek queue to never drop requests
  const generatePreview = useCallback(
    (time: number) => {
      const video = previewVideoRef.current;
      if (!video || !previewReady || !duration) return;

      // Small threshold to avoid redundant seeks for nearly identical positions
      if (Math.abs(time - lastPreviewTimeRef.current) < 0.15) return;

      if (isSeekingRef.current) {
        // Already seeking — queue the latest requested time (overwrites previous pending)
        pendingSeekTimeRef.current = time;
      } else {
        // Not seeking — start a new seek immediately
        isSeekingRef.current = true;
        lastPreviewTimeRef.current = time;
        pendingSeekTimeRef.current = null;
        video.currentTime = Math.max(0, Math.min(time, duration - 0.1));
      }
    },
    [previewReady, duration]
  );

  // Calculate time from clientX
  const getTimeFromX = useCallback(
    (clientX: number): { time: number; x: number } => {
      const track = trackRef.current;
      if (!track || !duration) return { time: 0, x: 0 };
      const rect = track.getBoundingClientRect();
      const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
      const ratio = x / rect.width;
      return { time: ratio * duration, x };
    },
    [duration]
  );

  // --- Event handlers (direct DOM, no setState for position) ---

  const handleMouseEnter = useCallback(() => {
    isHoveringRef.current = true;
    showThumb(true);
  }, [showThumb]);

  const handleMouseLeave = useCallback(() => {
    if (isDraggingRef.current) return;
    isHoveringRef.current = false;
    hideTooltip();
    updateHoverFill(0, false);
    showThumb(false);
    if (previewBoxRef.current) previewBoxRef.current.style.display = "none";
    lastPreviewTimeRef.current = -1;
    pendingSeekTimeRef.current = null;
    isSeekingRef.current = false;
  }, [hideTooltip, updateHoverFill, showThumb]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const { time, x } = getTimeFromX(e.clientX);
      hoverTimeRef.current = time;
      updateTooltipPosition(x, time);
      updateHoverFill(duration > 0 ? (time / duration) * 100 : 0, true);
      generatePreview(time);
    },
    [getTimeFromX, updateTooltipPosition, updateHoverFill, duration, generatePreview]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);

      isDraggingRef.current = true;
      isHoveringRef.current = true;

      const { time, x } = getTimeFromX(e.clientX);
      hoverTimeRef.current = time;

      // Immediately update progress bar position (direct DOM)
      const percent = duration > 0 ? (time / duration) * 100 : 0;
      updateProgress(percent);
      updateTooltipPosition(x, time);
      updateHoverFill(percent, true);
      showThumb(true);
      generatePreview(time);
    },
    [getTimeFromX, duration, updateProgress, updateTooltipPosition, updateHoverFill, showThumb, generatePreview]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const { time, x } = getTimeFromX(e.clientX);
      hoverTimeRef.current = time;

      updateTooltipPosition(x, time);
      const percent = duration > 0 ? (time / duration) * 100 : 0;
      updateHoverFill(percent, true);
      generatePreview(time);

      // If dragging, also move the progress fill + thumb in real time
      if (isDraggingRef.current) {
        updateProgress(percent);
      }
    },
    [getTimeFromX, duration, updateTooltipPosition, updateHoverFill, generatePreview, updateProgress]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!isDraggingRef.current) return;

      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      isDraggingRef.current = false;

      const { time } = getTimeFromX(e.clientX);
      onSeek(time);

      // Check if pointer is still over the track
      const track = trackRef.current;
      if (track) {
        const rect = track.getBoundingClientRect();
        const isOver =
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top - 20 &&
          e.clientY <= rect.bottom + 20;
        if (!isOver) {
          isHoveringRef.current = false;
          hideTooltip();
          updateHoverFill(0, false);
          showThumb(false);
          if (previewBoxRef.current) previewBoxRef.current.style.display = "none";
          lastPreviewTimeRef.current = -1;
          pendingSeekTimeRef.current = null;
          isSeekingRef.current = false;
        }
      }
    },
    [getTimeFromX, onSeek, hideTooltip, updateHoverFill, showThumb]
  );

  return (
    <div className="mb-4 relative group/progress">
      {/* Preview tooltip — always mounted, visibility controlled by JS */}
      <div
        ref={tooltipRef}
        className="absolute bottom-full mb-3 pointer-events-none z-50"
        style={{ display: "none", transform: "translateX(-50%)", left: 0 }}
      >
        <div className="flex flex-col items-center gap-1.5">
          {/* Video preview thumbnail */}
          <div
            ref={previewBoxRef}
            className="w-48 h-[108px] rounded-lg overflow-hidden border-2 border-primary/40 shadow-lg shadow-black/50 bg-black"
            style={{ display: "none" }}
          >
            <img
              ref={previewImgRef}
              alt="Preview"
              className="w-full h-full object-cover"
              draggable={false}
            />
          </div>
          {/* Time label */}
          <div className="px-2.5 py-1 rounded-md bg-black/90 backdrop-blur-sm border border-white/15 shadow-lg">
            <span
              ref={timeLabelRef}
              className="text-xs font-mono font-semibold text-white tabular-nums"
            >
              0:00
            </span>
          </div>
        </div>
      </div>

      {/* Track area */}
      <div
        ref={trackRef}
        className="relative h-5 flex items-center cursor-pointer touch-none"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onMouseMove={handleMouseMove}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {/* Track background */}
        <div className="absolute inset-x-0 h-1 rounded-full bg-white/20 group-hover/progress:h-1.5" style={{ transition: "height 0.15s" }}>
          {/* Hover indicator (behind progress) */}
          <div
            ref={hoverFillRef}
            className="absolute inset-y-0 left-0 rounded-full bg-white/30"
            style={{ display: "none", width: "0%" }}
          />
          {/* Progress fill — NO CSS transition for instant response */}
          <div
            ref={fillRef}
            className="absolute inset-y-0 left-0 rounded-full bg-primary"
            style={{ width: "0%" }}
          />
        </div>

        {/* Thumb — NO CSS transition for instant response */}
        <div
          ref={thumbRef}
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2"
          style={{ left: "0%" }}
        >
          <div className="rounded-full bg-primary shadow-md shadow-black/30 border-2 border-white w-3 h-3 scale-0 group-hover/progress:scale-100" style={{ transition: "transform 0.15s, width 0.15s, height 0.15s" }} />
        </div>
      </div>
    </div>
  );
});
