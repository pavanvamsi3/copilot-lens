// State
let sessions = [];
let analytics = null;
let charts = {};
let searchDebounce = null;
let isSearchActive = false;
let analyticsSource = "all";

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
const searchClear = document.getElementById("searchClear");
const searchKbd = document.querySelector(".search-kbd");
const timeFilter = document.getElementById("timeFilter");
const statusFilter = document.getElementById("statusFilter");
const dirFilter = document.getElementById("dirFilter");
const detailPane = document.getElementById("detailPane");
const detailContent = document.getElementById("detailContent");
const paneClose = document.getElementById("paneClose");
const refreshBtn = document.getElementById("refreshBtn");
const statsCards = document.getElementById("statsCards");

// Navigation
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.page + "Page").classList.add("active");
    if (btn.dataset.page === "analytics") loadAnalytics();
    if (btn.dataset.page === "tokens") loadTokens();
    if (btn.dataset.page === "insights") loadInsights();
  });
});

// Side pane close
paneClose.addEventListener("click", () => {
  detailPane.classList.remove("open");
});

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && detailPane.classList.contains("open")) {
    detailPane.classList.remove("open");
  }
  if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
    e.preventDefault();
    searchInput.focus();
  }
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
        (s.branch || "").toLowerCase().includes(query) ||
        (s.title || "").toLowerCase().includes(query)
    );
  }

  const time = timeFilter.value;
  if (time !== "all") {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);

    filtered = filtered.filter((s) => {
      const created = new Date(s.createdAt);
      if (time === "today") return created >= midnight;
      if (time === "week") {
        const weekStart = new Date(midnight);
        const day = weekStart.getDay(); // 0=Sun … 6=Sat
        weekStart.setDate(weekStart.getDate() - (day === 0 ? 6 : day - 1)); // back to Monday
        return created >= weekStart;
      }
      if (time === "month") {
        const monthStart = new Date(midnight);
        monthStart.setDate(1);
        return created >= monthStart;
      }
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
  if (isSearchActive) return;
  const filtered = getFilteredSessions();
  sessionCount.textContent = `${filtered.length} session${filtered.length !== 1 ? "s" : ""} found`;

  if (filtered.length === 0) {
    sessionList.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">🔍</span>
        <p>No sessions match your filters</p>
      </div>`;
    return;
  }

  sessionList.innerHTML = filtered
    .map(
      (s) => {
        const c = getDirColor(s.cwd);
        const sourceClass = s.source === "vscode" ? "badge-vscode" : s.source === "claude-code" ? "badge-claude" : "badge-cli";
        const sourceLabel = s.source === "vscode" ? "VS Code" : s.source === "claude-code" ? "Claude Code" : "Copilot CLI";
        const displayName = s.title || shortId(s.id);
        const metaItems = [];
        if (s.branch) metaItems.push(`<span class="badge badge-branch">⎇ ${escapeHtml(s.branch)}</span>`);
        metaItems.push(`<span>${formatTime(s.createdAt)}</span>`);
        return `
    <div class="session-card" data-id="${s.id}" data-source="${s.source || "cli"}" style="border-left: 4px solid ${c.border}">
      <div class="top-row">
        <span class="session-id">${escapeHtml(displayName)}</span>
        <span class="top-badges">
          <span class="badge ${sourceClass}">${sourceLabel}</span>
          <span class="badge badge-${s.status}">${s.status === "running" ? "● Running" : s.status === "error" ? "✕ Error" : "✓ Completed"}</span>
        </span>
      </div>
      <div class="session-dir">${escapeHtml(s.cwd || "—")}</div>
      <div class="session-meta">
        ${metaItems.join('<span class="meta-sep">·</span>')}
      </div>
    </div>
  `;
      }
    )
    .join("");

  // Stagger animation + click handlers
  sessionList.querySelectorAll(".session-card").forEach((card, i) => {
    const delay = Math.min(i * 30, 300);
    card.style.animationDelay = `${delay}ms`;
    card.classList.add("card-animate");
    card.addEventListener("animationend", () => card.classList.remove("card-animate"), { once: true });
    card.addEventListener("click", () => openDetail(card.dataset.id, card.dataset.source));
  });
}

// Open session detail — side panel
async function openDetail(id, source) {
  detailContent.innerHTML = `
    <div class="skeleton-card">
      <div class="skeleton-line" style="width:60%;height:16px;margin-bottom:12px"></div>
      <div class="skeleton-line" style="width:40%"></div>
      <div class="skeleton-line" style="width:55%"></div>
      <div class="skeleton-line" style="width:35%"></div>
    </div>
    <div class="skeleton-card" style="margin-top:16px">
      <div class="skeleton-line" style="width:80%"></div>
      <div class="skeleton-line" style="width:65%"></div>
      <div class="skeleton-line" style="width:70%"></div>
      <div class="skeleton-line" style="width:50%"></div>
    </div>`;
  detailPane.classList.add("open");

  try {
    const res = await fetch(`/api/sessions/${id}`);
    const session = await res.json();
    renderDetail(session);
  } catch (err) {
    detailContent.innerHTML = `<div style="color:var(--danger)">Failed to load session: ${escapeHtml(err.message)}</div>`;
  }
}

function renderDetail(s) {
  const userMessages = s.events.filter((e) => e.type === "user.message");
  const assistantMessages = s.events.filter((e) => e.type === "assistant.message");
  const toolCalls = s.events.filter((e) => e.type === "tool.execution_start");
  const errors = s.events.filter((e) => e.type === "session.error");

  // Track model changes for conversation display
  let currentModel = "";
  const startEvent = s.events.find((e) => e.type === "session.start");
  if (startEvent?.data?.model) currentModel = startEvent.data.model;

  // Build a map of model at each event index
  const modelAtIndex = {};
  for (let i = 0; i < s.events.length; i++) {
    const e = s.events[i];
    if (e.type === "session.model_change" && e.data?.newModel) {
      currentModel = e.data.newModel;
    }
    if (e.type === "session.info" && e.data?.infoType === "model") {
      const match = (e.data.message || "").match(/Model changed to:\s*([^\s.]+(?:[-.][^\s.]+)*)/i);
      if (match) currentModel = match[1];
    }
    modelAtIndex[i] = currentModel;
  }

  // Interleave conversation messages in order
  const conversation = s.events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => (e.type === "user.message" || e.type === "assistant.message" || e.type === "assistant.thinking") && (e.data?.content || "").trim())
    .map(({ e, i }) => {
      const content = e.data?.content || "";
      if (e.type === "assistant.thinking") {
        return `<details class="message message-thinking">
          <summary class="thinking-toggle">💭 View thinking</summary>
          <div class="thinking-body">${escapeHtml(content)}</div>
        </details>`;
      }
      const isUser = e.type === "user.message";
      const display = content.length > 800 ? content.slice(0, 800) + "\n...(truncated)" : content;
      const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      const model = !isUser && modelAtIndex[i] ? `<span class="message-model">${escapeHtml(modelAtIndex[i])}</span>` : "";
      return `<div class="message ${isUser ? "message-user" : "message-assistant"}">
        <div class="message-label">${isUser ? "👤 You" : s.source === "claude-code" ? "🤖 Claude" : s.source === "vscode" ? "🤖 Copilot" : "🤖 Copilot"}${model}${time ? `<span class="message-time">${time}</span>` : ""}</div>
        <div class="message-body">${escapeHtml(display)}</div>
      </div>`;
    })
    .join("");

  const toolsHtml = toolCalls.length
    ? toolCalls
        .map((e) => {
          const name = e.data?.tool || e.data?.toolName || "unknown";
          return `<div class="tool-card"><span class="tool-card-icon">⚙️</span><span class="tool-card-name">${escapeHtml(name)}</span></div>`;
        })
        .join("")
    : '<div style="color:var(--text-dim)">No tool calls</div>';

  detailContent.innerHTML = `
    <div class="detail-header">
      <h2>${s.title ? escapeHtml(s.title) : "Session " + escapeHtml(String(s.id))}</h2>
      <div class="detail-meta">
        <div><span>Source:</span> <strong class="badge ${s.source === "vscode" ? "badge-vscode" : s.source === "claude-code" ? "badge-claude" : "badge-cli"}">${s.source === "vscode" ? "VS Code" : s.source === "claude-code" ? "Claude Code" : "Copilot CLI"}</strong></div>
        <div><span>Directory:</span> <strong>${escapeHtml(s.cwd || "—")}</strong></div>
        <div><span>Branch:</span> <strong>${escapeHtml(s.branch || "—")}</strong></div>
        <div><span>Created:</span> <strong>${new Date(s.createdAt).toLocaleString()}</strong></div>
        <div><span>Duration:</span> <strong>${formatDuration(s.duration)}</strong></div>
        ${s.source !== "vscode" ? `<div><span>Version:</span> <strong>${escapeHtml(s.copilotVersion || "—")}</strong></div>` : ""}
        <div><span>Status:</span> <strong class="badge badge-${s.status}">${s.status === "running" ? "● Running" : s.status === "error" ? "✕ Error" : "✓ Completed"}</strong></div>
      </div>
    </div>

    <div class="event-counts" style="margin-bottom:16px">
      ${Object.entries(s.eventCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `<span class="event-count-badge">${escapeHtml(type)}: ${count}</span>`)
        .join("")}
    </div>

    <div class="detail-tabs">
      <button class="detail-tab active" data-tab="conversation">Conversation (${userMessages.length + assistantMessages.length})</button>
      <button class="detail-tab" data-tab="tools">Tools (${toolCalls.length})</button>
      <button class="detail-tab" data-tab="errors">Errors (${errors.length})</button>
      ${s.planContent ? '<button class="detail-tab" data-tab="plan">Plan</button>' : ""}
    </div>

    <div class="detail-panel active" id="panel-conversation">
      <div class="conversation-list">
      ${conversation || '<div style="color:var(--text-dim)">No messages in this session</div>'}
      </div>
    </div>

    <div class="detail-panel" id="panel-tools">
      ${toolsHtml}
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
    const res = await fetch(`/api/analytics?source=${analyticsSource}`);
    analytics = await res.json();
    renderAnalytics();
  } catch (err) {
    statsCards.innerHTML = `<div style="color:var(--danger)">Failed to load analytics</div>`;
  }
}

function animateStatCounters() {
  statsCards.querySelectorAll(".stat-value").forEach((el) => {
    const raw = el.textContent.trim();
    if (!/^\d+$/.test(raw)) return;
    const target = parseInt(raw, 10);
    if (target <= 0) return;
    let start = null;
    const duration = 600;
    const step = (ts) => {
      if (!start) start = ts;
      const progress = Math.min((ts - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.floor(eased * target);
      if (progress < 1) requestAnimationFrame(step);
      else el.textContent = raw;
    };
    requestAnimationFrame(step);
  });
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

  animateStatCounters();
  renderCharts();
}

function setChartEmpty(canvasId, message) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  canvas.style.display = "none";
  let msg = canvas.parentElement.querySelector(".chart-empty-msg");
  if (!msg) {
    msg = document.createElement("div");
    msg.className = "chart-empty-msg";
    msg.style.cssText = "color:var(--text-dim);padding:40px;text-align:center";
    canvas.parentElement.appendChild(msg);
  }
  msg.textContent = "📭 " + message;
  msg.style.display = "";
}

function resetChartCanvases() {
  document.querySelectorAll(".chart-empty-msg").forEach((el) => (el.style.display = "none"));
  document.querySelectorAll(".charts-grid canvas").forEach((el) => (el.style.display = ""));
}

function renderCharts() {
  // Destroy existing charts
  Object.values(charts).forEach((c) => c.destroy());
  charts = {};

  // Restore any canvases that were hidden by empty-state handlers
  resetChartCanvases();

  const chartColors = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#bc8cff", "#f0883e", "#56d4dd", "#db61a2"];
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  const tickColor = isLight ? "#656d76" : "#8b949e";
  const legendColor = isLight ? "#1f2328" : "#e6edf3";

  // Sessions per day
  const days = Object.keys(analytics.sessionsPerDay).sort();
  charts.perDay = new Chart(document.getElementById("sessionsPerDayChart"), {
    type: "bar",
    data: {
      labels: days.map((d) => d.slice(5)), // MM-DD
      datasets: [{ label: "Sessions", data: days.map((d) => analytics.sessionsPerDay[d]), backgroundColor: "#58a6ff88", borderColor: "#58a6ff", borderWidth: 1 }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { color: tickColor } }, x: { ticks: { color: tickColor } } } },
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
      options: { responsive: true, plugins: { legend: { position: "bottom", labels: { color: legendColor, font: { size: 13 }, padding: 14, boxWidth: 14 } } } },
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
      options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { color: tickColor } }, y: { ticks: { color: tickColor, font: { size: 12 } } } } },
    });
  }

  // Branch time (top 8)
  const branches = Object.entries(analytics.branchTime || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (branches.length) {
    charts.branches = new Chart(document.getElementById("branchChart"), {
      type: "bar",
      data: {
        labels: branches.map((b) => b[0]),
        datasets: [{ label: "Time", data: branches.map((b) => Math.round(b[1] / 60000)), backgroundColor: "#d2992288", borderColor: "#d29922", borderWidth: 1 }],
      },
      options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => formatDuration(ctx.raw * 60000) } } }, scales: { x: { beginAtZero: true, title: { display: true, text: "minutes", color: tickColor }, ticks: { color: tickColor } }, y: { ticks: { color: tickColor, font: { size: 12 } } } } },
    });
  }

  // Time per repo (top 8)
  const repos = Object.entries(analytics.repoTime || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (repos.length) {
    charts.repoTime = new Chart(document.getElementById("repoTimeChart"), {
      type: "bar",
      data: {
        labels: repos.map((r) => shortDir(r[0])),
        datasets: [{ label: "Time", data: repos.map((r) => Math.round(r[1] / 60000)), backgroundColor: "#3fb95088", borderColor: "#3fb950", borderWidth: 1 }],
      },
      options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => formatDuration(ctx.raw * 60000) } } }, scales: { x: { beginAtZero: true, title: { display: true, text: "minutes", color: tickColor }, ticks: { color: tickColor } }, y: { ticks: { color: tickColor, font: { size: 12 } } } } },
    });
  }

  // MCP Servers
  const mcpEntries = Object.entries(analytics.mcpServers || {}).sort((a, b) => b[1] - a[1]);
  if (mcpEntries.length) {
    charts.mcp = new Chart(document.getElementById("mcpChart"), {
      type: "doughnut",
      data: {
        labels: mcpEntries.map((m) => m[0]),
        datasets: [{ data: mcpEntries.map((m) => m[1]), backgroundColor: chartColors }],
      },
      options: { responsive: true, plugins: { legend: { position: "bottom", labels: { color: legendColor, font: { size: 13 }, padding: 14, boxWidth: 14 } } } },
    });
  } else {
    setChartEmpty("mcpChart", "No MCP servers detected");
  }

  // Model Usage
  const models = Object.entries(analytics.modelUsage || {}).sort((a, b) => b[1] - a[1]);
  if (models.length) {
    charts.model = new Chart(document.getElementById("modelChart"), {
      type: "doughnut",
      data: {
        labels: models.map((m) => m[0]),
        datasets: [{ data: models.map((m) => m[1]), backgroundColor: chartColors }],
      },
      options: { responsive: true, plugins: { legend: { position: "bottom", labels: { color: legendColor, font: { size: 13 }, padding: 14, boxWidth: 14 } } } },
    });
  } else {
    setChartEmpty("modelChart", "No model data detected");
  }

  // Activity by Hour of Day
  const hours = analytics.hourOfDay || {};
  const allHours = Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, "0") + ":00");
  charts.hour = new Chart(document.getElementById("hourChart"), {
    type: "bar",
    data: {
      labels: allHours.map((h) => h.slice(0, 2)),
      datasets: [{ label: "Sessions", data: allHours.map((h) => hours[h] || 0), backgroundColor: "#56d4dd88", borderColor: "#56d4dd", borderWidth: 1 }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { color: tickColor } }, x: { ticks: { color: tickColor } } } },
  });
}

// Data loading
async function loadSessions() {
  // Show skeleton while loading
  sessionList.innerHTML = Array.from({ length: 4 }, () => `
    <div class="skeleton-card">
      <div class="skeleton-line" style="width:55%;height:14px;margin-bottom:10px"></div>
      <div class="skeleton-line" style="width:75%"></div>
      <div class="skeleton-line" style="width:40%"></div>
    </div>`).join("");

  try {
    const res = await fetch("/api/sessions");
    sessions = await res.json();
    updateDirFilter();
    renderSessions();
  } catch (err) {
    sessionList.innerHTML = `<div style="color:var(--danger);padding:20px">Failed to load sessions: ${escapeHtml(err.message)}</div>`;
  }
}

// Search kbd visibility
function updateSearchKbd() {
  if (!searchKbd) return;
  const hasFocus = document.activeElement === searchInput;
  const hasText = !!searchInput.value.trim();
  searchKbd.style.display = (hasFocus || hasText) ? "none" : "";
}

// Search input (full-text search with debounce)
searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  searchClear.style.display = q ? "inline" : "none";
  updateSearchKbd();
  searchDebounce = setTimeout(() => {
    if (q) runSearch(q);
    else clearSearch();
  }, 300);
});

searchInput.addEventListener("focus", updateSearchKbd);
searchInput.addEventListener("blur", updateSearchKbd);

searchClear.addEventListener("click", () => {
  searchInput.value = "";
  searchClear.style.display = "none";
  updateSearchKbd();
  clearSearch();
});

// Filter listeners
timeFilter.addEventListener("change", renderSessions);
statusFilter.addEventListener("change", renderSessions);
dirFilter.addEventListener("change", renderSessions);

// Analytics source filter
document.getElementById("analyticsSourceFilter").addEventListener("click", (e) => {
  const btn = e.target.closest(".source-btn");
  if (!btn) return;
  analyticsSource = btn.dataset.source;
  document.querySelectorAll("#analyticsSourceFilter .source-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  loadAnalytics();
});

// Populate directory filter from session data
function updateDirFilter() {
  const dirs = [...new Set(sessions.map((s) => s.cwd || "").filter(Boolean))].sort();
  const current = dirFilter.value;
  dirFilter.innerHTML = '<option value="all">All Directories</option>' +
    dirs.map((d) => `<option value="${d}">${shortDir(d)}</option>`).join("");
  dirFilter.value = current;
}

// Refresh button
refreshBtn.addEventListener("click", async () => {
  refreshBtn.classList.add("spinning");
  // Clear server-side cache before reloading
  try { await fetch("/api/cache/clear", { method: "POST" }); } catch {}
  loadSessions();
  if (document.getElementById("analyticsPage").classList.contains("active")) {
    loadAnalytics();
  }
  if (document.getElementById("insightsPage").classList.contains("active")) {
    loadInsights();
  }
  if (document.getElementById("tokensPage").classList.contains("active")) {
    loadTokens();
  }
  setTimeout(() => refreshBtn.classList.remove("spinning"), 600);
});

// Theme toggle
const themeToggle = document.getElementById("themeToggle");
const savedTheme = localStorage.getItem("copilot-lens-theme");
if (savedTheme === "light") document.documentElement.setAttribute("data-theme", "light");
themeToggle.textContent = document.documentElement.getAttribute("data-theme") === "light" ? "🌙" : "☀️";

themeToggle.addEventListener("click", () => {
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  if (isLight) {
    document.documentElement.removeAttribute("data-theme");
    localStorage.setItem("copilot-lens-theme", "dark");
    themeToggle.textContent = "☀️";
  } else {
    document.documentElement.setAttribute("data-theme", "light");
    localStorage.setItem("copilot-lens-theme", "light");
    themeToggle.textContent = "🌙";
  }
});

// ============ Insights ============
const repoSelector = document.getElementById("repoSelector");
const insightsContent = document.getElementById("insightsContent");
let insightsRepos = [];

async function loadInsights() {
  try {
    const res = await fetch("/api/insights/repos");
    insightsRepos = await res.json();
    renderRepoSelector();
    if (insightsRepos.length > 0) {
      const selected = insightsRepos.find((r) => r.repo === repoSelector.value) || insightsRepos[0];
      repoSelector.value = selected.repo;
      renderInsightsScore(selected);
    }
  } catch (err) {
    insightsContent.innerHTML = `<div style="color:var(--danger);padding:20px">Failed to load insights: ${escapeHtml(err.message)}</div>`;
  }
}

function renderRepoSelector() {
  if (insightsRepos.length === 0) {
    repoSelector.innerHTML = '<option value="">No repos with enough data (need 3+ sessions)</option>';
    insightsContent.innerHTML = '<div class="not-enough-data"><div class="nod-icon">📊</div><p>Need at least 3 sessions in a repository to generate a score.</p></div>';
    return;
  }
  const current = repoSelector.value;
  repoSelector.innerHTML = insightsRepos
    .map((r) => {
      const label = r.repo === "VS Code" ? "🟣 VS Code (all sessions)" : shortDir(r.repo);
      return `<option value="${r.repo}">${label} — ${r.totalScore}/100</option>`;
    })
    .join("");
  if (current && insightsRepos.find((r) => r.repo === current)) {
    repoSelector.value = current;
  }
}

repoSelector.addEventListener("change", () => {
  const repo = insightsRepos.find((r) => r.repo === repoSelector.value);
  if (repo) renderInsightsScore(repo);
});

function getScoreColor(score, max) {
  const pct = score / max;
  if (pct >= 0.7) return "var(--accent2)";
  if (pct >= 0.4) return "var(--warning)";
  return "var(--danger)";
}

function renderInsightsScore(data) {
  const color = getScoreColor(data.totalScore, 100);
  const circumference = 2 * Math.PI * 65;
  const offset = circumference - (data.totalScore / 100) * circumference;

  const catIcons = {
    promptQuality: "💬",
    toolUtilization: "🔧",
    efficiency: "⚡",
    mcpUtilization: "🔌",
    engagement: "📈",
  };

  const categoryCards = Object.entries(data.categories)
    .map(([key, cat]) => {
      const pct = (cat.score / cat.maxScore) * 100;
      const barColor = getScoreColor(cat.score, cat.maxScore);
      return `
        <div class="category-card">
          <div class="cat-header">
            <span class="cat-label">${catIcons[key] || "📊"} ${escapeHtml(cat.label)}</span>
            <span class="cat-score" style="color:${barColor}">${cat.score}/${cat.maxScore}</span>
          </div>
          <div class="cat-bar"><div class="cat-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
          <div class="cat-detail">${escapeHtml(cat.detail)}</div>
        </div>`;
    })
    .join("");

  const tipItems = data.tips
    .map((tip) => `<div class="tip-item"><span class="tip-icon">💡</span><span>${escapeHtml(tip)}</span></div>`)
    .join("");

  insightsContent.innerHTML = `
    <div class="score-overview">
      <div class="score-circle">
        <svg viewBox="0 0 160 160">
          <circle class="track" cx="80" cy="80" r="65"></circle>
          <circle class="progress" cx="80" cy="80" r="65"
            stroke="${color}"
            stroke-dasharray="${circumference}"
            stroke-dashoffset="${offset}"></circle>
        </svg>
        <div class="score-text">
          <span class="score-number" style="color:${color}">${data.totalScore}</span>
          <span class="score-max">/ 100</span>
        </div>
      </div>
      <div class="score-summary">
        <h2>Copilot Effectiveness Score</h2>
        <div class="repo-name">${data.repo === "VS Code" ? "🟣 VS Code Copilot Chat" : escapeHtml(data.repo)}</div>
        <div class="session-info">${data.sessionCount} sessions analyzed</div>
      </div>
    </div>
    <div class="category-grid">${categoryCards}</div>
    <div class="tips-section">
      <h3>💡 Tips to Improve</h3>
      ${tipItems}
    </div>`;
}

// Full-text search
async function runSearch(q) {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&source=all&limit=20`);
    const results = await res.json();
    isSearchActive = true;
    renderSearchResults(results);
  } catch (err) {
    isSearchActive = true;
    sessionList.innerHTML = `<div style="color:var(--danger);padding:20px">Search failed: ${escapeHtml(err.message)}</div>`;
  }
}

function clearSearch() {
  isSearchActive = false;
  renderSessions();
}

function renderSearchResults(results) {
  if (!results || results.length === 0) {
    sessionCount.textContent = "No results found";
    sessionList.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">🔍</span>
        <p>No results found for your search</p>
      </div>`;
    return;
  }

  sessionCount.textContent = `${results.length} result${results.length !== 1 ? "s" : ""} found`;

  sessionList.innerHTML = results
    .map(({ entry, highlights }) => {
      const s = entry;
      const c = getDirColor(s.cwd);
      const sourceClass = s.source === "vscode" ? "badge-vscode" : s.source === "claude-code" ? "badge-claude" : "badge-cli";
      const sourceLabel = s.source === "vscode" ? "VS Code" : s.source === "claude-code" ? "Claude Code" : "Copilot CLI";
      const displayName = s.title || shortId(s.id);
      const highlightHtml = highlights && highlights.length
        ? `<div class="search-highlights">${highlights.map((h) => `<span class="highlight-snippet">${escapeHtml(h)}</span>`).join("")}</div>`
        : "";
      return `
    <div class="session-card" data-id="${s.id}" data-source="${s.source || "cli"}" style="border-left: 4px solid ${c.border}">
      <div class="top-row">
        <span class="session-id">${escapeHtml(displayName)}</span>
        <span class="top-badges">
          <span class="badge ${sourceClass}">${sourceLabel}</span>
        </span>
      </div>
      <div class="session-dir">${escapeHtml(s.cwd || "—")}</div>
      <div class="session-meta">
        <span>${formatTime(s.date)}</span>
      </div>
      ${highlightHtml}
    </div>
  `;
    })
    .join("");

  sessionList.querySelectorAll(".session-card").forEach((card, i) => {
    const delay = Math.min(i * 30, 300);
    card.style.animationDelay = `${delay}ms`;
    card.classList.add("card-animate");
    card.addEventListener("animationend", () => card.classList.remove("card-animate"), { once: true });
    card.addEventListener("click", () => openDetail(card.dataset.id, card.dataset.source));
  });
}

// ============ Token Usage ============
let tokenData = null;
let tokenBucket = "daily";
let tokenIncludeCached = true;

// Estimated underlying API rates (USD per 1M tokens). These are the public
// rates of the upstream Anthropic / OpenAI / Google APIs — NOT what GitHub
// Copilot bills you. Copilot bills on "premium requests" against your plan's
// monthly allowance. This is shown as a rough "if you called the API directly"
// reference. Update the table as providers change pricing.
// Keys are matched by `startsWith` against the normalized model name.
const MODEL_RATES = [
  // Anthropic Claude
  { prefix: "claude-opus",      input: 15.00, output: 75.00, cached: 1.50 },
  { prefix: "claude-sonnet",    input:  3.00, output: 15.00, cached: 0.30 },
  { prefix: "claude-haiku",     input:  1.00, output:  5.00, cached: 0.10 },
  { prefix: "claude-3-5-sonnet",input:  3.00, output: 15.00, cached: 0.30 },
  // OpenAI GPT-5 family
  { prefix: "gpt-5-nano",       input:  0.05, output:  0.40, cached: 0.005 },
  { prefix: "gpt-5-mini",       input:  0.25, output:  2.00, cached: 0.025 },
  { prefix: "gpt-5",            input:  1.25, output: 10.00, cached: 0.125 },
  // OpenAI GPT-4 family
  { prefix: "gpt-4.1-mini",     input:  0.40, output:  1.60, cached: 0.10 },
  { prefix: "gpt-4.1-nano",     input:  0.10, output:  0.40, cached: 0.025 },
  { prefix: "gpt-4.1",          input:  2.00, output:  8.00, cached: 0.50 },
  { prefix: "gpt-4o-mini",      input:  0.15, output:  0.60, cached: 0.075 },
  { prefix: "gpt-4o",           input:  2.50, output: 10.00, cached: 1.25 },
  // OpenAI o-series
  { prefix: "o4-mini",          input:  1.10, output:  4.40, cached: 0.275 },
  { prefix: "o3-mini",          input:  1.10, output:  4.40, cached: 0.55 },
  { prefix: "o3",               input:  2.00, output:  8.00, cached: 0.50 },
  { prefix: "o1-mini",          input:  1.10, output:  4.40, cached: 0.55 },
  { prefix: "o1",               input: 15.00, output: 60.00, cached: 7.50 },
  // Google Gemini
  { prefix: "gemini-2.5-pro",   input:  1.25, output: 10.00, cached: 0.31 },
  { prefix: "gemini-2.5-flash", input:  0.30, output:  2.50, cached: 0.075 },
  { prefix: "gemini",           input:  1.25, output:  5.00, cached: 0.31 },
];

function rateFor(model) {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const r of MODEL_RATES) {
    if (m.startsWith(r.prefix)) return r;
  }
  return null;
}

// USD cost for one model's totals (returns null if model rate unknown)
function costForModel(model, prompt, cached, completion) {
  const r = rateFor(model);
  if (!r) return null;
  const newPrompt = Math.max(0, prompt - cached);
  return (newPrompt * r.input + cached * r.cached + completion * r.output) / 1_000_000;
}

// Total estimated cost across all models. Returns { cost, coverage } where
// coverage is the fraction of total tokens that had a known rate.
function estimateTotalCost() {
  if (!tokenData) return { cost: 0, coverage: 0 };
  let cost = 0;
  let coveredTokens = 0;
  let totalTokens = 0;
  for (const [name, m] of Object.entries(tokenData.byModel)) {
    totalTokens += m.total_tokens;
    const c = costForModel(name, m.prompt_tokens, m.cached_tokens, m.completion_tokens);
    if (c != null) {
      cost += c;
      coveredTokens += m.total_tokens;
    }
  }
  return { cost, coverage: totalTokens > 0 ? coveredTokens / totalTokens : 0 };
}

function formatUSD(n) {
  if (n == null) return "—";
  if (n >= 1000) return "$" + n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (n >= 10) return "$" + n.toFixed(2);
  if (n >= 1) return "$" + n.toFixed(2);
  if (n >= 0.01) return "$" + n.toFixed(3);
  return "$" + n.toFixed(4);
}

function adjPrompt(p, c) {
  return tokenIncludeCached ? p : Math.max(0, p - c);
}
function adjTotal(p, c, comp) {
  return adjPrompt(p, c) + comp;
}

function formatTokens(n) {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 2 : 1) + "K";
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1) + "M";
  return (n / 1_000_000_000).toFixed(2) + "B";
}

async function loadTokens() {
  const cards = document.getElementById("tokenStatsCards");
  cards.innerHTML = `
    ${Array.from({ length: 6 }, () => `<div class="stat-card"><div class="stat-value">…</div><div class="stat-label">Loading</div></div>`).join("")}
  `;
  try {
    const res = await fetch("/api/token-usage");
    tokenData = await res.json();
    renderTokens();
  } catch (err) {
    cards.innerHTML = `<div style="color:var(--danger)">Failed to load token usage: ${escapeHtml(err.message)}</div>`;
  }
}

function renderTokens() {
  if (!tokenData) return;
  const t = tokenData.totals;
  const cards = document.getElementById("tokenStatsCards");
  const cacheRatePct = (t.cache_hit_rate * 100).toFixed(1) + "%";
  const promptShown = adjPrompt(t.prompt_tokens, t.cached_tokens);
  const totalShown = adjTotal(t.prompt_tokens, t.cached_tokens, t.completion_tokens);
  const compRatio = promptShown > 0 ? ((t.completion_tokens / promptShown) * 100).toFixed(1) + "%" : "—";
  const promptLabel = tokenIncludeCached
    ? `Prompt Tokens · ${cacheRatePct} cached`
    : `Prompt Tokens (billed) · ${cacheRatePct} cache hit`;
  const totalLabel = tokenIncludeCached
    ? `Total Tokens · ${t.calls} call${t.calls === 1 ? "" : "s"}`
    : `Total Tokens (billed) · ${t.calls} call${t.calls === 1 ? "" : "s"}`;
  const activeDays = t.active_days || 1;
  const avgPerDayShown = Math.round(totalShown / activeDays);

  const est = estimateTotalCost();
  const coveragePct = (est.coverage * 100).toFixed(0);
  const costPerDay = activeDays > 0 ? est.cost / activeDays : 0;
  const costSubLabel = est.coverage >= 0.99
    ? `lifetime · ≈ ${formatUSD(costPerDay)} / day`
    : `lifetime · ${coveragePct}% priced · ≈ ${formatUSD(costPerDay)} / day`;

  cards.innerHTML = `
    <div class="stat-card"><div class="stat-value">${formatTokens(totalShown)}</div><div class="stat-label">${totalLabel}</div></div>
    <div class="stat-card"><div class="stat-value">${formatTokens(promptShown)}</div><div class="stat-label">${promptLabel}</div></div>
    <div class="stat-card"><div class="stat-value">${formatTokens(t.completion_tokens)}</div><div class="stat-label">Completion Tokens · ${compRatio} of prompt</div></div>
    <div class="stat-card"><div class="stat-value">${formatTokens(avgPerDayShown)}</div><div class="stat-label">Avg / Day · ${t.active_days} active day${t.active_days === 1 ? "" : "s"}</div></div>
    <div class="stat-card"><div class="stat-value" style="font-size:18px">${escapeHtml(t.top_model || "—")}</div><div class="stat-label">Top Model</div></div>
    <div class="stat-card" title="Estimated cost if you called the underlying APIs (Anthropic, OpenAI, Google) directly with these token counts. This is NOT what GitHub Copilot bills you — Copilot uses 'premium requests' against your monthly allowance. Aggregated across all parsed logs."><div class="stat-value">${formatUSD(est.cost)}</div><div class="stat-label">Est. API Cost · ${costSubLabel}</div></div>
  `;

  const meta = document.getElementById("tokensMeta");
  if (t.calls === 0) {
    meta.innerHTML = `<div class="not-enough-data"><div class="nod-icon">📊</div><p>No token usage found in <code>${escapeHtml(tokenData.logsDir)}</code>. Run Copilot CLI to generate logs, then refresh.</p></div>`;
  } else {
    meta.innerHTML = `<div style="color:var(--text-dim);font-size:12px;margin-bottom:8px">Parsed ${tokenData.logsScanned} log file${tokenData.logsScanned === 1 ? "" : "s"} from <code>${escapeHtml(tokenData.logsDir)}</code></div>`;
  }

  renderTokenCharts();
  renderTokenTable();
}

function renderTokenCharts() {
  // Destroy any prior token charts
  ["tokenStack", "tokenModel", "tokenRatio"].forEach((k) => {
    if (charts[k]) { charts[k].destroy(); delete charts[k]; }
  });
  if (!tokenData || tokenData.totals.calls === 0) return;

  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  const tickColor = isLight ? "#656d76" : "#8b949e";
  const legendColor = isLight ? "#1f2328" : "#e6edf3";
  const chartColors = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#bc8cff", "#f0883e", "#56d4dd", "#db61a2"];

  const buckets = tokenData[tokenBucket] || [];
  const labels = buckets.map((b) => b.period);
  const newPrompt = buckets.map((b) => Math.max(0, b.prompt_tokens - b.cached_tokens));
  const cached = buckets.map((b) => b.cached_tokens);
  const completion = buckets.map((b) => b.completion_tokens);

  const stackDatasets = [
    { label: "Prompt (new)", data: newPrompt, backgroundColor: "#58a6ff", stack: "t" },
  ];
  if (tokenIncludeCached) {
    stackDatasets.push({ label: "Prompt (cached)", data: cached, backgroundColor: "#56d4dd", stack: "t" });
  }
  stackDatasets.push({ label: "Completion", data: completion, backgroundColor: "#bc8cff", stack: "t" });

  charts.tokenStack = new Chart(document.getElementById("tokenStackChart"), {
    type: "bar",
    data: { labels, datasets: stackDatasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: legendColor } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatTokens(ctx.raw)}` } },
      },
      scales: {
        x: { stacked: true, ticks: { color: tickColor } },
        y: { stacked: true, ticks: { color: tickColor, callback: (v) => formatTokens(v) }, beginAtZero: true },
      },
    },
  });

  const models = Object.entries(tokenData.byModel)
    .map(([k, v]) => [k, v, adjTotal(v.prompt_tokens, v.cached_tokens, v.completion_tokens)])
    .sort((a, b) => b[2] - a[2]);
  if (models.length) {
    charts.tokenModel = new Chart(document.getElementById("tokenModelChart"), {
      type: "doughnut",
      data: {
        labels: models.map((m) => m[0]),
        datasets: [{ data: models.map((m) => m[2]), backgroundColor: chartColors }],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: "bottom", labels: { color: legendColor, font: { size: 13 }, padding: 14, boxWidth: 14 } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${formatTokens(ctx.raw)}` } },
        },
      },
    });
  }

  const t = tokenData.totals;
  const ratioLabels = tokenIncludeCached
    ? ["Prompt (new)", "Prompt (cached)", "Completion"]
    : ["Prompt (new)", "Completion"];
  const ratioData = tokenIncludeCached
    ? [Math.max(0, t.prompt_tokens - t.cached_tokens), t.cached_tokens, t.completion_tokens]
    : [Math.max(0, t.prompt_tokens - t.cached_tokens), t.completion_tokens];
  const ratioColors = tokenIncludeCached
    ? ["#58a6ff", "#56d4dd", "#bc8cff"]
    : ["#58a6ff", "#bc8cff"];
  charts.tokenRatio = new Chart(document.getElementById("tokenRatioChart"), {
    type: "doughnut",
    data: {
      labels: ratioLabels,
      datasets: [{ data: ratioData, backgroundColor: ratioColors }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: "bottom", labels: { color: legendColor, font: { size: 13 }, padding: 14, boxWidth: 14 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${formatTokens(ctx.raw)}` } },
      },
    },
  });
}

function bucketCost(b) {
  let cost = 0;
  let known = false;
  for (const [name, m] of Object.entries(b.models || {})) {
    const c = costForModel(name, m.prompt_tokens, m.cached_tokens, m.completion_tokens);
    if (c != null) { cost += c; known = true; }
  }
  return known ? cost : null;
}

function renderTokenTable() {
  const table = document.getElementById("tokenBreakdownTable");
  if (!tokenData) { table.innerHTML = ""; return; }
  const buckets = (tokenData[tokenBucket] || []).slice().reverse();
  if (!buckets.length) { table.innerHTML = '<tbody><tr><td style="color:var(--text-dim);padding:20px">No data</td></tr></tbody>'; return; }
  const headerLabel = tokenBucket === "daily" ? "Day" : tokenBucket === "weekly" ? "Week" : "Month";
  const promptHeader = tokenIncludeCached ? "Prompt" : "Prompt (billed)";
  const cachedHeader = tokenIncludeCached ? "<th>Cached</th>" : "";
  table.innerHTML = `
    <thead><tr>
      <th>${headerLabel}</th>
      <th>Calls</th>
      <th>${promptHeader}</th>
      ${cachedHeader}
      <th>Completion</th>
      <th>Total</th>
      <th>Est. Cost</th>
      <th>Top Model</th>
    </tr></thead>
    <tbody>
      ${buckets.map((b) => {
        const promptShown = adjPrompt(b.prompt_tokens, b.cached_tokens);
        const totalShown = adjTotal(b.prompt_tokens, b.cached_tokens, b.completion_tokens);
        const cachedCell = tokenIncludeCached ? `<td>${formatTokens(b.cached_tokens)}</td>` : "";
        const cost = bucketCost(b);
        return `
        <tr>
          <td>${escapeHtml(b.period)}</td>
          <td>${b.calls}</td>
          <td>${formatTokens(promptShown)}</td>
          ${cachedCell}
          <td>${formatTokens(b.completion_tokens)}</td>
          <td><strong>${formatTokens(totalShown)}</strong></td>
          <td>${cost == null ? '<span style="color:var(--text-dim)">—</span>' : formatUSD(cost)}</td>
          <td>${escapeHtml(b.top_model || "—")}</td>
        </tr>`;
      }).join("")}
    </tbody>
  `;
}

document.getElementById("tokenBucketFilter").addEventListener("click", (e) => {
  const btn = e.target.closest(".source-btn");
  if (!btn) return;
  tokenBucket = btn.dataset.bucket;
  document.querySelectorAll("#tokenBucketFilter .source-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  renderTokenCharts();
  renderTokenTable();
});

document.getElementById("tokenCachedFilter").addEventListener("click", (e) => {
  const btn = e.target.closest(".source-btn");
  if (!btn) return;
  tokenIncludeCached = btn.dataset.cached === "include";
  document.querySelectorAll("#tokenCachedFilter .source-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  renderTokens();
});

// Init
loadSessions();
