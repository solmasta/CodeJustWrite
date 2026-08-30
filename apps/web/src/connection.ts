import type { Settings } from "./types";
import { apiBase } from "./utils";

export interface ConnectionManager {
  send: (data: unknown) => void;
  close: () => void;
  onMessage: (handler: (msg: unknown) => void) => void;
  onOpen: (handler: () => void) => void;
  onClose: (handler: () => void) => void;
  isConnected: () => boolean;
  reconnectAttempts: number;
}

export function createConnection(
  sessionId: string,
  settings: Settings,
  onStatusChange: (status: "connecting" | "connected" | "disconnected" | "reconnecting") => void
): ConnectionManager {
  let socket: WebSocket | null = null;
  let messageQueue: string[] = [];
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 10;
  const baseDelay = 1000;
  const maxDelay = 30000;
  
  let messageHandler: ((msg: unknown) => void) | null = null;
  let openHandler: (() => void) | null = null;
  let closeHandler: (() => void) | null = null;
  
  function getDelay(): number {
    const exponential = baseDelay * Math.pow(2, reconnectAttempts);
    const jitter = Math.random() * 1000;
    return Math.min(exponential + jitter, maxDelay);
  }
  
  function connect(): void {
    if (socket?.readyState === WebSocket.OPEN) return;
    
    onStatusChange(reconnectAttempts > 0 ? "reconnecting" : "connecting");
    
    const wsUrl = `${apiBase(settings).replace(/^http/, "ws")}/ws?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(settings.token)}`;
    socket = new WebSocket(wsUrl);
    
    socket.onopen = () => {
      reconnectAttempts = 0;
      onStatusChange("connected");
      openHandler?.();
      
      while (messageQueue.length) {
        const msg = messageQueue.shift();
        if (msg) socket?.send(msg);
      }
    };
    
    socket.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data));
        messageHandler?.(data);
      } catch {
        messageHandler?.(ev.data);
      }
    };
    
    socket.onclose = () => {
      socket = null;
      onStatusChange("disconnected");
      closeHandler?.();
      
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        reconnectTimer = setTimeout(connect, getDelay());
      }
    };
    
    socket.onerror = () => {
      // Let onclose handle reconnection
    };
  }
  
  connect();
  
  return {
    send: (data: unknown) => {
      const json = JSON.stringify(data);
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(json);
      } else {
        messageQueue.push(json);
      }
    },
    close: () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close();
      socket = null;
    },
    onMessage: (handler) => { messageHandler = handler; },
    onOpen: (handler) => { openHandler = handler; },
    onClose: (handler) => { closeHandler = handler; },
    isConnected: () => socket?.readyState === WebSocket.OPEN,
    get reconnectAttempts() { return reconnectAttempts; },
  };
}
