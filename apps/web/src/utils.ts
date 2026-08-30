import type { Settings } from "./types";

export function el<T extends HTMLElement>(sel: string): T {
  const e = document.querySelector(sel);
  if (!e) throw new Error(`Element not found: ${sel}`);
  return e as T;
}

export function apiBase(s: Settings): string {
  return (s.serverUrl || location.origin).replace(/\/$/, "");
}

export function wsBase(s: Settings): string {
  const base = apiBase(s);
  return base.replace(/^http/, "ws");
}

export async function apiFetch(
  settings: Settings,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const base = apiBase(settings);
  const url = `${base}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> || {}),
  };
  if (settings.token) headers["Authorization"] = `Bearer ${settings.token}`;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  
  try {
    const res = await fetch(url, { ...init, headers, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function show(el: HTMLElement): void {
  el.classList.remove("hidden");
}

export function hide(el: HTMLElement): void {
  el.classList.add("hidden");
}

export function text(el: HTMLElement, msg: string): void {
  el.textContent = msg;
}

export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
