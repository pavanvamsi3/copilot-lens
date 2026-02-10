// State
let sessions = [];
let analytics = null;
let charts = {};

// Directory color coding — sophisticated muted palette
const DIR_COLORS = [
  { border: "#6e7681", bg: "#161b2208" },  // slate
  { border: "#58a6ff", bg: "#58a6ff08" },  // blue
  { border: "#3fb950", bg: "#3fb95008" },  // green
  { border: "#d29922", bg: "#d2992208" },  // amber
  { border: "#bc8cff", bg: "#bc8cff08" },  // purple
  { border: "#f0883e", bg: "#f0883e08" },  // orange
  { border: "#56d4dd", bg: "#56d4dd08" },  // teal
  { border: "#db61a2", bg: "#db61a208" },  // rose
];
const dirColorMap = {};
let nextColorIdx = 0;

function getDirColor(dir) {
  if (!dir) return DIR_COLORS[0];
  // Normalize to project root
  const key = dir.replace(/\\/g, "/").split("/").slice(0, -1).join("/") || dir;
  if (!dirColorMap[key]) {
    dirColorMap[key] = DIR_COLORS[nextColorIdx % DIR_COLORS.length];
    nextColorIdx++;
  }
  return dirColorMap[key];
}

// DOM refs
const sessionList = document.getElementById("sessionList");
const sessionCount = document.getElementById("sessionCount");
const searchInput = document.getElementById("searchInput");
const timeFilter = document.getElementById("timeFilter");
const statusFilter = document.getElementById("statusFilter");
const dirFilter = document.getElementById("dirFilter");
const detailModal = document.getElementById("detailModal");
const detailContent = document.getElementById("detailContent");
const modalClose = document.getElementById("modalClose");
const refreshBtn = document.getElementById("refreshBtn");

// Navigation
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.page + "Page").classList.add("active");
    if (btn.dataset.page === "analytics") loadAnalytics();
  });
});

// Modal
modalClose.addEventListener("click", () => detailModal.classList.add("hidden"));
detailModal.addEventListener("click", (e) => {
  if (e.target === detailModal) detailModal.classList.add("hidden");
});

// Format helpers
function formatDuration(ms) {
  if (ms < 1000) return "< 1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
  if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function shortId(id) {
  return id.slice(0, 8);
}

function shortDir(dir) {
  if (!dir) return "—";
  const parts = dir.replace(/\\/g, "/").split("/");
  return parts.slice(-2).join("/");
}

// Filter sessions
function getFilteredSessions() {
  let filtered = [...sessions];
  const query = searchInput.value.toLowerCase();
  if (query) {
    filtered = filtered.filter(
      (s) =>
        s.id.toLowerCase().includes(query) ||
        (s.cwd || "").toLowerCase().includes(query) ||
        (s.branch || "").toLowerCase().includes(query)
    );
  }

  const time = timeFilter.value;
  if (time !== "all") {
    const now = new Date();
    filtered = filtered.filter((s) => {
      const created = new Date(s.createdAt);
      if (time === "today") return now - created < 86400000;
      if (time === "week") return now - created < 604800000;
      if (time === "month") return now - created < 2592000000;
      return true;
    });
  }

  const status = statusFilter.value;
  if (status !== "all") {
    filtered = filtered.filter((s) => s.status === status);
  }

  const dir = dirFilter.value;
  if (dir !== "all") {
    filtered = filtered.filter((s) => (s.cwd || "") === dir);
  }

  return filtered;
}

// Render session list
function renderSessions() {
  const filtered = getFilteredSessions();
  sessionCount.textContent = `${filtered.length} session${filtered.length !== 1 ? "s" : ""} found`;

  sessionList.innerHTML = filtered
    .map(
      (s) => {
        const c = getDirColor(s.cwd);
        return `
    <div class="session-card" data-id="${s.id}" style="border-left: 3px solid ${c.border}">
      <div class="top-row">
        <span class="session-id">${shortId(s.id)}</span>
        <span class="badge badge-${s.status}">${s.status === "running" ? "● Running" : s.status === "error" ? "✕ Error" : "✓ Completed"}</span>
      </div>
      <div class="session-dir">${s.cwd || "—"}</div>
      <div class="session-meta">
        ${s.branch ? `<span class="badge badge-branch">⎇ ${s.branch}</span>` : ""}
        <span>${formatTime(s.createdAt)}</span>
      </div>
    </div>
  `;
      }
    )
    .join("");

  // Click handlers
  sessionList.querySelectorAll(".session-card").forEach((card) => {
    card.addEventListener("click", () => openDetail(card.dataset.id));
  });
}

// Open session detail
async function openDetail(id) {
  detailContent.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-dim)">Loading...</div>';
  detailModal.classList.remove("hidden");

  try {
    const res = await fetch(`/api/sessions/${id}`);
    const session = await res.json();
    renderDetail(session);
  } catch (err) {
    detailContent.innerHTML = `<div style="color:var(--danger)">Failed to load session: ${err.message}</div>`;
  }
}

function renderDetail(s) {
  const userMessages = s.events.filter((e) => e.type === "user.message");
  const assistantMessages = s.events.filter((e) => e.type === "assistant.message");
  const toolCalls = s.events.filter((e) => e.type === "tool.execution_start");
  const errors = s.events.filter((e) => e.type === "session.error");

  // Interleave conversation messages in order
  const conversation = s.events
    .filter((e) => e.type === "user.message" || e.type === "assistant.message")
    .map((e) => {
      const isUser = e.type === "user.message";
      const content = e.data?.content || "";
      // Truncate long messages
      const display = content.length > 2000 ? content.slice(0, 2000) + "\n...(truncated)" : content;
      return `<div class="message ${isUser ? "message-user" : "message-assistant"}">
        <div class="message-label">${isUser ? "👤 You" : "🤖 Copilot"}</div>
        ${escapeHtml(display)}
      </div>`;
    })
    .join("");

  detailContent.innerHTML = `
    <div class="detail-header">
      <h2>Session ${s.id}</h2>
      <div class="detail-meta">
        <div><span>Directory:</span> <strong>${s.cwd || "—"}</strong></div>
        <div><span>Branch:</span> <strong>${s.branch || "—"}</strong></div>
        <div><span>Created:</span> <strong>${new Date(s.createdAt).toLocaleString()}</strong></div>
        <div><span>Duration:</span> <strong>${formatDuration(s.duration)}</strong></div>
        <div><span>Version:</span> <strong>${s.copilotVersion || "—"}</strong></div>
        <div><span>Status:</span> <strong class="badge badge-${s.status}">${s.status === "running" ? "● Running" : s.status === "error" ? "✕ Error" : "✓ Completed"}</strong></div>
      </div>
    </div>

    <div class="event-counts" style="margin-bottom:16px">
      ${Object.entries(s.eventCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `<span class="event-count-badge">${type}: ${count}</span>`)
        .join("")}
    </div>

    <div class="detail-tabs">
      <button class="detail-tab active" data-tab="conversation">Conversation (${userMessages.length + assistantMessages.length})</button>
      <button class="detail-tab" data-tab="tools">Tools (${toolCalls.length})</button>
      <button class="detail-tab" data-tab="errors">Errors (${errors.length})</button>
      ${s.planContent ? '<button class="detail-tab" data-tab="plan">Plan</button>' : ""}
    </div>

    <div class="detail-panel active" id="panel-conversation">
      ${conversation || '<div style="color:var(--text-dim)">No messages in this session</div>'}
    </div>

    <div class="detail-panel" id="panel-tools">
      ${
        toolCalls.length
          ? toolCalls
              .map((e) => `<div class="tool-item">${e.data?.tool || e.data?.toolName || "unknown"}</div>`)
              .join("")
          : '<div style="color:var(--text-dim)">No tool calls</div>'
      }
    </div>

    <div class="detail-panel" id="panel-errors">
      ${
        errors.length
          ? errors
              .map(
                (e) =>
                  `<div class="message" style="border-left:3px solid var(--danger)"><div class="message-label" style="color:var(--danger)">Error</div>${escapeHtml(e.data?.message || "Unknown error")}</div>`
              )
              .join("")
          : '<div style="color:var(--text-dim)">No errors 🎉</div>'
      }
    </div>

    ${s.planContent ? `<div class="detail-panel" id="panel-plan"><div class="plan-content">${escapeHtml(s.planContent)}</div></div>` : ""}
  `;

  // Tab switching
  detailContent.querySelectorAll(".detail-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      detailContent.querySelectorAll(".detail-tab").forEach((t) => t.classList.remove("active"));
      detailContent.querySelectorAll(".detail-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("panel-" + tab.dataset.tab).classList.add("active");
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Analytics
async function loadAnalytics() {
  try {
    const res = await fetch("/api/analytics");
    analytics = await res.json();
    renderAnalytics();
  } catch (err) {
    statsCards.innerHTML = `<div style="color:var(--danger)">Failed to load analytics</div>`;
  }
}

function renderAnalytics() {
  if (!analytics) return;

  // Stats cards
  statsCards.innerHTML = `
    <div class="stat-card"><div class="stat-value">${analytics.totalSessions}</div><div class="stat-label">Total Sessions</div></div>
    <div class="stat-card"><div class="stat-value">${formatDuration(analytics.avgDuration)}</div><div class="stat-label">Avg Duration</div></div>
    <div class="stat-card"><div class="stat-value">${formatDuration(analytics.maxDuration)}</div><div class="stat-label">Longest Session</div></div>
    <div class="stat-card"><div class="stat-value">${formatDuration(analytics.totalDuration)}</div><div class="stat-label">Total Time</div></div>
  `;

  renderCharts();
}

function renderCharts() {
  // Destroy existing charts
  Object.values(charts).forEach((c) => c.destroy());
  charts = {};

  const chartColors = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#bc8cff", "#f0883e", "#56d4dd", "#db61a2"];

  // Sessions per day
  const days = Object.keys(analytics.sessionsPerDay).sort();
  charts.perDay = new Chart(document.getElementById("sessionsPerDayChart"), {
    type: "bar",
    data: {
      labels: days.map((d) => d.slice(5)), // MM-DD
      datasets: [{ label: "Sessions", data: days.map((d) => analytics.sessionsPerDay[d]), backgroundColor: "#58a6ff88", borderColor: "#58a6ff", borderWidth: 1 }],
    },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { color: "#8b949e" } }, x: { ticks: { color: "#8b949e" } } } },
  });

  // Tool usage (top 10)
  const tools = Object.entries(analytics.toolUsage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (tools.length) {
    charts.tools = new Chart(document.getElementById("toolUsageChart"), {
      type: "doughnut",
      data: {
        labels: tools.map((t) => t[0]),
        datasets: [{ data: tools.map((t) => t[1]), backgroundColor: chartColors }],
      },
      options: { responsive: true, plugins: { legend: { position: "right", labels: { color: "#e6edf3", font: { size: 11 } } } } },
    });
  }

  // Top directories (top 8)
  const dirs = Object.entries(analytics.topDirectories)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (dirs.length) {
    charts.dirs = new Chart(document.getElementById("topDirsChart"), {
      type: "bar",
      data: {
        labels: dirs.map((d) => shortDir(d[0])),
        datasets: [{ label: "Sessions", data: dirs.map((d) => d[1]), backgroundColor: "#3fb95088", borderColor: "#3fb950", borderWidth: 1 }],
      },
      options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { color: "#8b949e" } }, y: { ticks: { color: "#8b949e", font: { size: 11 } } } } },
    });
  }

  // Branch activity (top 8)
  const branches = Object.entries(analytics.branchActivity)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (branches.length) {
    charts.branches = new Chart(document.getElementById("branchChart"), {
      type: "bar",
      data: {
        labels: branches.map((b) => b[0]),
        datasets: [{ label: "Sessions", data: branches.map((b) => b[1]), backgroundColor: "#d2992288", borderColor: "#d29922", borderWidth: 1 }],
      },
      options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { color: "#8b949e" } }, y: { ticks: { color: "#8b949e", font: { size: 11 } } } } },
    });
  }
}

// Data loading
async function loadSessions() {
  try {
    const res = await fetch("/api/sessions");
    sessions = await res.json();
    updateDirFilter();
    renderSessions();
  } catch (err) {
    sessionList.innerHTML = `<div style="color:var(--danger);padding:20px">Failed to load sessions: ${err.message}</div>`;
  }
}

// Event listeners
searchInput.addEventListener("input", renderSessions);
timeFilter.addEventListener("change", renderSessions);
statusFilter.addEventListener("change", renderSessions);
dirFilter.addEventListener("change", renderSessions);

// Populate directory filter from session data
function updateDirFilter() {
  const dirs = [...new Set(sessions.map((s) => s.cwd || "").filter(Boolean))].sort();
  const current = dirFilter.value;
  dirFilter.innerHTML = '<option value="all">All Directories</option>' +
    dirs.map((d) => `<option value="${d}">${shortDir(d)}</option>`).join("");
  dirFilter.value = current;
}

// Refresh button
refreshBtn.addEventListener("click", () => {
  refreshBtn.classList.add("spinning");
  loadSessions();
  if (document.getElementById("analyticsPage").classList.contains("active")) {
    loadAnalytics();
  }
  setTimeout(() => refreshBtn.classList.remove("spinning"), 600);
});

// Init
loadSessions();
