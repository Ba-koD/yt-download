// 메시지, 토스트, 알림 같은 공통 화면 반응.

import { el } from "./state.js";

export function browserLabel(value) {
  const labels = {
    brave: "Brave",
    chrome: "Chrome",
    edge: "Edge",
    firefox: "Firefox",
    safari: "Safari",
    vivaldi: "Vivaldi",
    whale: "Whale",
    default: "기본 브라우저",
  };
  return labels[value] || value;
}

export function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    const result = Notification.requestPermission();
    if (result && typeof result.catch === "function") result.catch(() => {});
  }
}

export function showSystemNotification(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body });
  } catch {
    // Some WebView runtimes do not expose OS notifications.
  }
}

export function showToast(title, body, isError = false) {
  const toast = document.createElement("div");
  toast.className = `toast${isError ? " error" : ""}`;
  const titleNode = document.createElement("div");
  titleNode.className = "toast-title";
  titleNode.textContent = title;
  const bodyNode = document.createElement("div");
  bodyNode.className = "toast-body";
  bodyNode.textContent = body || "";
  toast.append(titleNode, bodyNode);
  el.toastStack.append(toast);
  setTimeout(() => toast.remove(), 7000);
}

export function setBusy(isBusy) {
  el.loadButton.disabled = isBusy;
  el.loadButton.textContent = isBusy ? "불러오는 중" : "불러오기";
  el.loadButton.classList.toggle("loading", isBusy);
}

export function setMessage(text, isError = false) {
  el.message.textContent = text || "";
  el.message.classList.toggle("error", isError);
}
