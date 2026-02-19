# Copilot Lens — Architecture Diagrams

## System Overview

```mermaid
graph TB
    subgraph Browser["Browser (SPA — public/)"]
        HTML["index.html\nSPA shell"]
        JS["app.js\nVanilla JS"]
        CSS["style.css\nDark/light theme"]

        subgraph Pages["Pages"]
            SP["Sessions Page\nFull-text search\nFilter dropdowns\nSession cards"]
            AP["Analytics Page\n8 Chart.js charts\nStat cards"]
            IP["Insights Page\nEffectiveness score\nPer-repo + VS Code"]
        end

        subgraph Modal["Detail Modal"]
            DM["Session detail\nConversation view\nTools / Errors / Plan tabs"]
        end
    end

    subgraph Server["Express Server (src/server.ts)"]
        API["API Routes"]
    end

    subgraph Backend["Backend Modules (src/)"]
        SES["sessions.ts\nCLI sessions\nAnalytics\nScoring engine"]
        VSC["vscode-sessions.ts\nVS Code sessions\nSQLite reader\nTool normaliser"]
        SCH["search.ts\nSearchIndex\nTokenise + rank\nHighlight extraction"]
        CAC["cache.ts\nTTL cache\n30s expiry"]
    end

    subgraph Storage["Filesystem / Database"]
        FS["~/.copilot/session-state/\nworkspace.yaml\nevents.jsonl\nplan.md"]
        DB["VS Code globalStorage/\nstate.vscdb (SQLite)\n{sessionId}.json"]
        MCP["mcp.json configs\n.vscode/mcp.json\nCode/User/mcp.json"]
    end

    JS --> API
    API --> SES
    API --> SCH
    SES --> VSC
    SES --> CAC
    VSC --> CAC
    SES --> FS
    VSC --> DB
    SES --> MCP
    VSC --> MCP
    SCH --> SES
```

---

## API Endpoints

```mermaid
graph LR
    Client(["Browser"])

    subgraph Routes["GET /api/..."]
        R1["GET /api/search\n?q= &source= &limit="]
        R2["GET /api/sessions"]
        R3["GET /api/sessions/:id"]
        R4["GET /api/analytics"]
        R5["GET /api/insights/repos"]
        R6["GET /api/insights/score\n?repo="]
        R7["POST /api/cache/clear"]
    end

    Client -- "search query" --> R1
    Client -- "list" --> R2
    Client -- "detail" --> R3
    Client -- "charts" --> R4
    Client -- "scores" --> R5
    Client -- "repo score" --> R6
    Client -- "refresh" --> R7

    R1 --> SI["SearchIndex\n.buildIndex()\n.search()"]
    R2 --> LS["listSessions()"]
    R3 --> GS["getSession(id)"]
    R4 --> GA["getAnalytics()"]
    R5 --> LR["listReposWithScores()"]
    R6 --> RS["getRepoScore()\nor getVSCodeScore()"]
    R7 --> CC["clearCache()\n+ searchIndex.clear()"]
```

---

## Session Data Flow — CLI Sessions

```mermaid
sequenceDiagram
    participant B as Browser
    participant S as server.ts
    participant Ses as sessions.ts
    participant C as cache.ts
    participant FS as Filesystem

    B->>S: GET /api/sessions
    S->>Ses: listSessions()
    Ses->>C: cachedCall("listSessions", 30s)
    alt cache miss
        C->>Ses: invoke fn
        Ses->>FS: readdir ~/.copilot/session-state/
        FS-->>Ses: [sessionDir, ...]
        loop each session dir
            Ses->>FS: readFile workspace.yaml
            FS-->>Ses: id, cwd, branch, timestamps
            Ses->>FS: read last 2KB events.jsonl
            FS-->>Ses: latest event timestamp
            Ses->>FS: stat session.db (running check)
        end
        Ses->>Ses: listVSCodeSessions()
        Note over Ses: merge CLI + VS Code, sort by createdAt
        C-->>Ses: store result
    end
    S-->>B: JSON [SessionMeta, ...]

    B->>S: GET /api/sessions/:id
    S->>Ses: getSession(id)
    alt VS Code session
        Ses->>FS: readFile {id}.json (strip images, truncate text)
        FS-->>Ses: raw JSON
        Ses->>Ses: requestsToEvents() → SessionEvent[]
    else CLI session
        Ses->>FS: readFile events.jsonl
        Ses->>FS: readFile workspace.yaml
        Ses->>FS: readFile plan.md (if exists)
    end
    S-->>B: JSON SessionDetail
```

---

## Full-Text Search Flow

```mermaid
sequenceDiagram
    participant U as User (browser)
    participant JS as app.js
    participant S as server.ts
    participant SI as SearchIndex
    participant Ses as sessions.ts

    U->>JS: types in #searchInput
    JS->>JS: debounce 300ms
    JS->>S: GET /api/search?q=typescript&source=all&limit=20
    S->>Ses: listSessions() (cached)
    Ses-->>S: [SessionMeta, ...]
    S->>SI: buildIndex(sessions)
    alt entries already populated
        SI-->>S: no-op
    else entries empty
        loop each SessionMeta
            SI->>Ses: getSession(id)
            Ses-->>SI: SessionDetail (events)
            SI->>SI: extract user.message + assistant.message content
            SI->>SI: strip code blocks (``` fences)
            SI->>SI: push SearchEntry
        end
    end
    S->>SI: search("typescript", {limit:20, source:'all'})
    SI->>SI: tokenize → ["typescript"]
    loop each SearchEntry
        SI->>SI: count token occurrences in content
        SI->>SI: score += count / wordCount
        SI->>SI: +0.5 if token in title
        SI->>SI: +0.2 if token in cwd
        SI->>SI: extractHighlights (±60 chars, word-boundary trim)
    end
    SI->>SI: filter score > 0, sort desc, slice to limit
    SI-->>S: [SearchResult, ...]
    S-->>JS: JSON [{entry, score, highlights}, ...]
    JS->>JS: renderSearchResults()
    JS-->>U: session cards with highlight snippets

    U->>JS: clicks ✕ clear button
    JS->>JS: clearSearch() → isSearchActive = false
    JS->>JS: renderSessions() → normal filtered list
```

---

## Cache Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Empty: server start

    Empty --> Populated: first request hits\ncachedCall()

    Populated --> Populated: request within 30s TTL\n(cache hit, ~0ms)

    Populated --> Empty: POST /api/cache/clear\n(user clicks Refresh)\nclearCache() + searchIndex.clear()

    Populated --> Empty: TTL expires (30s)\nnext read triggers recompute

    Empty --> Populated: recompute on next request\n(~7ms sessions, ~1.8s analytics)
```

---

## Scoring System

```mermaid
graph TD
    SD["Session Data\n(events.jsonl / VS Code JSON)"]

    SD --> CD["collectRepoData()\nor collectVSCodeData()"]

    CD --> PQ["Prompt Quality\n0–20 pts\nAvg message length\n- ask_user penalty"]
    CD --> TU["Tool Utilization\n0–20 pts\nDistinct tool count"]
    CD --> EF["Efficiency\n0–20 pts\nTool success rate\n+ concise session bonus"]
    CD --> MU["MCP Utilization\n0–20 pts\nConfigured vs used\nMCP servers ratio"]
    CD --> EN["Engagement\n0–20 pts\nSession duration\n5–30 min sweet spot\n+ consistency bonus"]

    PQ --> TOT["Total Score\n0–100"]
    TU --> TOT
    EF --> TOT
    MU --> TOT
    EN --> TOT

    TOT --> TIPS["generateTips()\nActionable advice\nfor low categories"]
    TOT --> UI["Insights Page\nSVG donut chart\nCategory bars\nTips list"]
```

---

## Frontend State Machine — Sessions Page

```mermaid
stateDiagram-v2
    [*] --> Loading: loadSessions()

    Loading --> NormalView: sessions loaded\nrenderSessions()

    NormalView --> NormalView: filter change\n(time/status/dir)\nrenderSessions()

    NormalView --> Searching: user types in search bar\n(300ms debounce)\nrunSearch(q)

    Searching --> Searching: new keystrokes\ndebounce resets

    Searching --> SearchResults: GET /api/search returns\nrenderSearchResults()

    SearchResults --> SearchResults: user refines query\nrunSearch(q) again

    SearchResults --> NormalView: user clears search (✕)\nclearSearch()\nrenderSessions()

    NormalView --> DetailModal: click session card\nopenDetail(id)
    SearchResults --> DetailModal: click result card\nopenDetail(entry.id)

    DetailModal --> NormalView: close modal\n(✕, ESC, backdrop click)
    DetailModal --> SearchResults: close modal\n(if search was active)
```

---

## VS Code Session Data Conversion

```mermaid
graph LR
    subgraph Raw["VS Code JSON format"]
        REQ["requests[]\n- message.text\n- response[]\n  - toolInvocationSerialized\n  - thinking (excluded)\n  - text parts\n- variableData (images stripped)"]
    end

    subgraph Unified["Unified SessionEvent[] format"]
        E1["assistant.turn_start"]
        E2["user.message\n{content: message.text}"]
        E3["tool.execution_start\n{tool: normalised name}"]
        E4["assistant.message\n{content: concatenated text}"]
    end

    REQ --> E1
    REQ --> E2
    REQ --> E3
    REQ --> E4

    E1 & E2 & E3 & E4 --> SD["SessionDetail\n(same shape as CLI sessions)"]
    SD --> API["GET /api/sessions/:id\nreturns same schema\nfor both CLI and VS Code"]
```
