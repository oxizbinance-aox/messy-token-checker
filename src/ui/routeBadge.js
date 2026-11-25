/**
 * Route badge + Nano status chip + download progress bar.
 *
 * The route badge is rendered on every AI result and tells the user which
 * route actually ran: Gemini Nano on-device, or Gemini in the cloud.
 * When the SDK could not report the route with certainty, the badge says
 * so honestly ("likely …") instead of claiming certainty we don't have.
 */

import { ROUTE_ON_DEVICE, ROUTE_IN_CLOUD } from "../ai/hybrid.js";

/** Escape user/AI-controlled text before injecting it into HTML. */
export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render the AI route badge into `container`.
 *
 * @param {HTMLElement} container
 * @param {string|null} route — "ON_DEVICE" | "IN_CLOUD" |
 *   "likely on-device" | "likely cloud" | null (unknown)
 * @param {boolean} routeCertain — false when the route was inferred
 */
export function renderRouteBadge(container, route, routeCertain) {
  if (!container) return;
  const onDevice =
    route === ROUTE_ON_DEVICE || route === "likely on-device";
  const label = onDevice
    ? "On-device · Gemini Nano"
    : "In the cloud · Gemini 3.8 Flash";
  const cls = onDevice ? "route-on-device" : "route-in-cloud";
  const certainNote =
    routeCertain === false
      ? `<span class="route-certain">(inferred — SDK did not report the route)</span>`
      : "";
  const unknownNote =
    !route
      ? `<span class="route-certain">(route unknown)</span>`
      : "";
  container.innerHTML =
    `<span class="route-badge ${cls}" title="Which Gemini route explained this verdict">` +
    `<span class="route-dot" aria-hidden="true"></span>${esc(label)}${certainNote}${unknownNote}</span>`;
}

/**
 * Render the Nano availability chip (shown above the input, always visible).
 *
 * @param {HTMLElement} container
 * @param {{ status: string, detail: string }} nano — from checkNanoAvailability()
 */
export function renderNanoChip(container, nano) {
  if (!container) return;
  const status = nano?.status ?? "unavailable";
  const textByStatus = {
    available:
      "On-device AI ready — Gemini Nano is on this device",
    downloading:
      "On-device AI downloading — checks will use the cloud meanwhile",
    downloadable:
      "On-device AI available to download — checks will use the cloud meanwhile",
    unavailable:
      "On-device AI unavailable in this browser — checks will use the cloud",
    unsupported:
      "On-device AI unsupported in this browser — checks will use the cloud",
  };
  const text = textByStatus[status] ?? textByStatus.unavailable;
  container.classList.remove(
    "is-available",
    "is-downloading",
    "is-downloadable",
    "is-unavailable",
  );
  container.classList.add(`is-${status}`);
  const dot = container.querySelector(".nano-dot");
  const label = container.querySelector(".nano-text");
  if (label) label.textContent = text;
  if (dot) dot.setAttribute("title", nano?.detail ?? "");
  container.title = nano?.detail ?? "";
}

/** Show the Nano download progress bar (first-run download). */
export function showDownloadProgress() {
  const bar = document.getElementById("download-bar");
  const fill = document.getElementById("download-fill");
  const pct = document.getElementById("download-pct");
  if (!bar) return;
  bar.hidden = false;
  if (fill) fill.style.width = "0%";
  if (pct) pct.textContent = "0%";
}

/** Update the Nano download progress bar (progress 0..1). */
export function setDownloadProgress(progress) {
  const fill = document.getElementById("download-fill");
  const pct = document.getElementById("download-pct");
  const p = Math.round(Math.min(1, Math.max(0, progress ?? 0)) * 100);
  if (fill) fill.style.width = `${p}%`;
  if (pct) pct.textContent = `${p}%`;
}

/** Hide the Nano download progress bar (download done or failed). */
export function hideDownloadProgress() {
  const bar = document.getElementById("download-bar");
  if (bar) bar.hidden = true;
}
