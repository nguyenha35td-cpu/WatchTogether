"use client";

import { useRef, useState, useCallback, useEffect } from "react";

// Message types sent from client to server
export type ClientMessageType =
  | "create_room"
  | "join_room"
  | "leave_room"
  | "playlist_add"
  | "playlist_remove"
  | "select_video"
  | "play"
  | "pause"
  | "seek"
  | "request_sync";

// Message types received from server
export type ServerMessageType =
  | "room_created"
  | "room_joined"
  | "error"
  | "participant_joined"
  | "participant_left"
  | "playlist_updated"
  | "video_changed"
  | "sync_play"
  | "sync_pause"
  | "sync_seek"
  | "sync_state";

export interface WSMessage {
  type: string;
  payload: Record<string, unknown>;
}

export interface Participant {
  id: string;
  name: string;
  isHost: boolean;
  isConnected: boolean;
}

export interface PlaybackState {
  isPlaying: boolean;
  currentTime: number;
  lastUpdate: number;
}

export interface RoomInfo {
  id: string;
  hostId: string;
  participants: Participant[];
  playlist: Array<{
    id: string;
    title: string;
    thumbnail: string;
    duration: string;
    src: string;
  }>;
  currentVideoId: string | null;
  playbackState: PlaybackState;
}

interface UseWebSocketOptions {
  onRoomCreated?: (roomId: string, clientId: string, room: RoomInfo) => void;
  onRoomJoined?: (roomId: string, clientId: string, room: RoomInfo) => void;
  onError?: (message: string) => void;
  onParticipantJoined?: (participants: Participant[]) => void;
  onParticipantLeft?: (participants: Participant[], newHostId: string) => void;
  onPlaylistUpdated?: (
    playlist: RoomInfo["playlist"],
    currentVideoId?: string | null
  ) => void;
  onVideoChanged?: (videoId: string) => void;
  onSyncPlay?: (currentTime: number) => void;
  onSyncPause?: (currentTime: number) => void;
  onSyncSeek?: (currentTime: number) => void;
  onSyncState?: (state: {
    currentVideoId: string | null;
    playbackState: PlaybackState;
    playlist: RoomInfo["playlist"];
  }) => void;
  onConnectionChange?: (connected: boolean) => void;
}

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001";

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 5;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const connect = useCallback(() => {
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[WS] Connected");
        setIsConnected(true);
        reconnectAttemptsRef.current = 0;
        optionsRef.current.onConnectionChange?.(true);
      };

      ws.onmessage = (event) => {
        try {
          const message: WSMessage = JSON.parse(event.data);
          handleMessage(message);
        } catch (err) {
          console.error("[WS] Failed to parse message:", err);
        }
      };

      ws.onclose = () => {
        console.log("[WS] Disconnected");
        setIsConnected(false);
        optionsRef.current.onConnectionChange?.(false);

        // Auto-reconnect
        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          const delay = Math.min(
            1000 * Math.pow(2, reconnectAttemptsRef.current),
            10000
          );
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectAttemptsRef.current++;
            connect();
          }, delay);
        }
      };

      ws.onerror = (err) => {
        console.error("[WS] Error:", err);
      };
    } catch (err) {
      console.error("[WS] Connection failed:", err);
    }
  }, []);

  const handleMessage = useCallback((message: WSMessage) => {
    const { type, payload } = message;
    const opts = optionsRef.current;

    switch (type) {
      case "room_created":
        opts.onRoomCreated?.(
          payload.roomId as string,
          payload.clientId as string,
          payload.room as RoomInfo
        );
        break;

      case "room_joined":
        opts.onRoomJoined?.(
          payload.roomId as string,
          payload.clientId as string,
          payload.room as RoomInfo
        );
        break;

      case "error":
        opts.onError?.(payload.message as string);
        break;

      case "participant_joined":
        opts.onParticipantJoined?.(payload.participants as Participant[]);
        break;

      case "participant_left":
        opts.onParticipantLeft?.(
          payload.participants as Participant[],
          payload.newHostId as string
        );
        break;

      case "playlist_updated":
        opts.onPlaylistUpdated?.(
          payload.playlist as RoomInfo["playlist"],
          payload.currentVideoId as string | null | undefined
        );
        break;

      case "video_changed":
        opts.onVideoChanged?.(payload.videoId as string);
        break;

      case "sync_play":
        opts.onSyncPlay?.(payload.currentTime as number);
        break;

      case "sync_pause":
        opts.onSyncPause?.(payload.currentTime as number);
        break;

      case "sync_seek":
        opts.onSyncSeek?.(payload.currentTime as number);
        break;

      case "sync_state":
        opts.onSyncState?.(
          payload as unknown as {
            currentVideoId: string | null;
            playbackState: PlaybackState;
            playlist: RoomInfo["playlist"];
          }
        );
        break;
    }
  }, []);

  const send = useCallback((type: ClientMessageType, payload: Record<string, unknown> = {}) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, payload }));
    } else {
      console.warn("[WS] Not connected, message not sent:", type);
    }
  }, []);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    reconnectAttemptsRef.current = maxReconnectAttempts; // prevent reconnect
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
  }, []);

  // Actions
  const createRoom = useCallback(
    (userName: string, playlist: RoomInfo["playlist"] = []) => {
      send("create_room", { userName, playlist });
    },
    [send]
  );

  const joinRoom = useCallback(
    (roomId: string, userName: string) => {
      send("join_room", { roomId, userName });
    },
    [send]
  );

  const leaveRoom = useCallback(() => {
    send("leave_room", {});
  }, [send]);

  const addToPlaylist = useCallback(
    (video: RoomInfo["playlist"][0]) => {
      send("playlist_add", { video });
    },
    [send]
  );

  const removeFromPlaylist = useCallback(
    (videoId: string) => {
      send("playlist_remove", { videoId });
    },
    [send]
  );

  const selectVideo = useCallback(
    (videoId: string) => {
      send("select_video", { videoId });
    },
    [send]
  );

  const sendPlay = useCallback(
    (currentTime: number) => {
      send("play", { currentTime });
    },
    [send]
  );

  const sendPause = useCallback(
    (currentTime: number) => {
      send("pause", { currentTime });
    },
    [send]
  );

  const sendSeek = useCallback(
    (currentTime: number) => {
      send("seek", { currentTime });
    },
    [send]
  );

  const requestSync = useCallback(() => {
    send("request_sync", {});
  }, [send]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    isConnected,
    connect,
    disconnect,
    createRoom,
    joinRoom,
    leaveRoom,
    addToPlaylist,
    removeFromPlaylist,
    selectVideo,
    sendPlay,
    sendPause,
    sendSeek,
    requestSync,
  };
}
