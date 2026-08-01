// 시간·숫자 표시 도우미.


export function resolutionLabel(height) {
  const value = Number(height) || 0;
  if (value >= 4320) return "8K";
  if (value >= 2160) return "4K";
  if (value >= 1440) return "1440p";
  if (value >= 1080) return "1080p";
  if (value >= 720) return "720p";
  return `${Math.round(value)}p`;
}

export function parseTime(value) {
  const text = String(value).trim();
  if (!text) return NaN;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

export function formatClockPrecise(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${pad(Math.floor(total / 3600))}:${pad(minutes % 60)}:${secs.toFixed(1).padStart(4, "0")}`;
}

export function formatClock(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
}

export function pad(value) {
  return String(value).padStart(2, "0");
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function extractYouTubeId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtu.be")) return parsed.pathname.split("/").filter(Boolean)[0];
    if (parsed.searchParams.get("v")) return parsed.searchParams.get("v");
    const shorts = parsed.pathname.match(/\/shorts\/([^/?]+)/);
    if (shorts) return shorts[1];
    const live = parsed.pathname.match(/\/live\/([^/?]+)/);
    if (live) return live[1];
  } catch {
    return null;
  }
  return null;
}
