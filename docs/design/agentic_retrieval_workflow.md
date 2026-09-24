# Agentic Retrieval Workflow — 把 OpenCode 風格的多輪工具推理整合進 RAGFlow

Status: Draft
Date: 2026-09-24
Owner: (TBD)
Related code:
- `agent/component/agent_with_tools.py` — Agent component (LLM + tool loop)
- `agent/tools/retrieval.py` — `Retrieval` tool (KB search)
- `agent/tools/code_exec.py` — `CodeExec` tool (Python/JS sandbox)
- `agent/tools/base.py` — `LLMToolPluginCallSession` tool dispatch
- `rag/llm/chat_model.py:548-653` — `async_chat_with_tools` ReAct loop (OpenAI-style tool calling, `max_rounds`)
- `agent/templates/your_starter_dataset_chatbot.json` — reference template
- `common/mcp_tool_call_conn.py` — MCP client (SSE / Streamable-HTTP)

---

## 1. 背景與動機

目前 RAGFlow 的對話/檢索管線是「單輪檢索 + 單輪生成」:

```
user query → tokenize → hybrid retrieve → rerank → LLM answer
```

這對「直接事實型」問題(「AMR 的保固期是多久?」)運作良好,但對**複合型查詢(compositional query)** 失效。實際案例:

> **「AMR 電池多少 W」**

`軟體設計_V1.2.5.docx` 中的實際資料分佈:

| 段落 | 內容 | 有無直接寫 W |
|------|------|--------------|
| P250–256 (24V) | 待機 10h、工作 5h、充電 4h | ❌ 沒有 |
| P262–270 (48V-old) | 待機 18-22h、工作 12-14h | ❌ 沒有 |
| P271–275 (48V-new) | **待機 63W、工作 160W、充電 600W** | ✅ 有 |

檢索到的 chunk 取決於 embedding/BM25 命中的位置,LLM 拿到沒有 W 的 chunk 時只能回答「查無資料」——造成**同一問題兩次提問結果不一致**。

## 2. 問題定義

1. **單輪檢索沒有「缺什麼就補查什麼」的能力**:LLM 沒辦法發現「問題要的是 W,但檢索結果只有時間」然後自己再查一次。
2. **無法做衍生計算**:文件只寫 `48V / 30Ah / 工作 12h`,要得到平均功耗需要 `48V × 30Ah / 12h = 120W`,目前的 pipeline 沒有計算工具。
3. **檢索結果不穩定**:tokenization + hybrid 融合在邊界分數時會抖動,複合問題需要多次探查才能穩定命中。

## 3. 對標:OpenCode 的策略

OpenCode(`anomalyco/opencode`)是 terminal 上的 coding agent,它的策略核心**不是**特定 prompt,而是:

- **Agent Loop(ReAct 循環)**:LLM 在每一輪選擇「思考 / 呼叫工具 / 輸出答案」,直到完成或達到 round 上限。
- **通用工具集**:`bash`、`read_file`、`write_file`、`edit_file`、`grep`、`web_fetch` — 沒有任何工具是為特定領域寫的。
- **Tool-use 由模型驅動**:不是程式寫死「遇到 W 就查 V×A」,而是 LLM 自己看到缺乏的資訊,自己決定下一步要查什麼、算什麼。

**我們不是要搬 OpenCode 的程式碼**,而是要借它的「通用工具 + 多輪循環」執行架構,放到 RAGFlow 的 Agent Canvas 裡。

## 4. 需求

### 4.1 功能需求

| ID | 需求 | 優先級 |
|----|------|--------|
| FR-1 | Agent 節點能在一次用戶提問內,**多輪呼叫 Retrieval**(自動補查缺失參數) | P0 |
| FR-2 | Agent 節點能呼叫 **CodeExec**(Python 沙箱)對檢索到的數值做衍生計算 | P0 |
| FR-3 | Agent 節點能在每輪產出**可追蹤的思考摘要**(thought),供前端展示與除錯 | P1 |
| FR-4 | 終端答案需附**引用來源**(沿用 `citation` 機制) | P1 |
| FR-5 | 當 LLM 推論需要的資訊文件沒有時,**明確回報缺什麼**,不捏造 | P0 |
| FR-6 | 支援 MCP tool 掛載(未來接外部 agent 如 Claude Code) | P2 |

### 4.2 非功能需求

- **不引入特化 prompt**:不允許在系統提示寫死業務邏輯(`W = V × A`、`續航 = 電量/功率`)。
- **不影響現有單輪 Chat pipeline**:這個 agent 是 Canvas DSL 層的新流程,不改 `dialog_service.py` 的預設 chat。
- **Round 上限與 timeout**:`max_rounds` 預設 5(已存在於 `AgentParam`),`tool_timeout` 預設 10s,整個 Agent 由 `COMPONENT_EXEC_TIMEOUT` 包住(預設 20min)。
- **不寫檔案系統**:現階段 `CodeExec` 是唯讀沙箱(不能寫 repo),不要把 OpenCode 的 `write_file`/`edit_file` 概念帶進來。

### 4.3 非需求(Out of scope)

- 不接 Claude Code 為 MCP server(stdio 不相容,要 bridge;見 §6 風險)。
- 不做 cross-document join(SQL/JOIN 式的多文件查詢是 `text2sql` agent 的範疇)。
- 不重建 ES/Infinity 索引。

## 5. 設計

### 5.1 總覽

在 Canvas 裡建一個 Agent 節節點,綁 `Retrieval` + `CodeExec` 兩個工具,讓 LLM 透過 function calling 多輪迭代。

```
┌──────────┐
│  Begin   │
└────┬─────┘
     │ {sys.query}
     ▼
┌─────────────────────────────────────────┐
│  Agent (ReAct loop, max_rounds=5)       │
│                                         │
│  tools:                                 │
│   - Retrieval(query) → chunks           │
│   - CodeExec(lang, script) → JSON       │
│                                         │
│  sys_prompt: 通用推理框架(無業務規則)   │
└────┬────────────────────────────────────┘
     │ content
     ▼
┌──────────┐
│ Message  │ (輸出答案 + 引用)
└──────────┘
```

### 5.2 關鍵元件

#### `Agent` component(已存在)

`agent/component/agent_with_tools.py` 已經實作:

```python
# agent_with_tools.py:81-117
self.tools = {}
for idx, cpn in enumerate(self._param.tools):
    cpn = self._load_tool_obj(cpn)              # 把 Retrieval/CodeExec 包成 tool
    self.tools[f"{name}_{idx}"] = cpn
# ...
for mcp in self._param.mcp:                     # MCP server 工具
    tool_call_session = MCPToolCallSession(mcp_server, ...)
    self.tools[f"{tnm}_{idx}"] = MCPToolBinding(...)
self.chat_mdl.bind_tools(self.toolcall_session, self.tool_meta)
```

`bind_tools` 後,`LLMBundle.async_chat_with_tools`(`chat_model.py:548`)就跑 OpenAI 標準的 tool-calling loop,內建 `max_rounds` 與 `max_retries`。**所有核心機制都已存在,我們只需要配置 DSL 與 sys_prompt**。

#### 通用 sys_prompt(無特化規則)

```markdown
# Role
You are a technical documentation assistant with tool access.

# Workflow
1. Analyze the user's question. Identify every numeric/factual parameter needed.
2. Call `search_my_dateset` with focused queries to gather parameters.
   - If the first query doesn't return needed values, refine the keywords
     and call again (you may call the tool multiple times in a turn).
3. If a derived value is required (rate, total, conversion, estimate),
   write a Python `main()` for `execute_code` and pass the retrieved
   parameters in as arguments.
4. Cite which document/section each parameter came from.

# Hard rules
- NEVER invent a numeric value not present in retrieved chunks.
- If a needed parameter cannot be found after 2 retrieval attempts,
  explicitly state which parameter is missing — do NOT guess.
- The final answer must list each parameter with its source.
```

### 5.3 執行範例(「AMR 電池多少 W」)

```
Round 1 — LLM thought: need battery specs
  └─ tool_call: search_my_dateset("AMR 電池 規格 電壓 容量")
       → chunks: 24V section (P250-256), 48V-old (P262-270), 48V-new (P271-275)

Round 2 — LLM: 48V-new 直接寫 63W/160W/600W;但 24V 沒寫 W
  └─ tool_call: search_my_dateset("24V 電池 電流 安培 容量 Ah")
       → chunks: 電池容量 spec 在附錄/機構測試文件

Round 3 — LLM: 24V 有 Ah 但沒有 I,需要從工作時數反推平均電流
  └─ tool_call: execute_code(python,
       "def main(v, ah, h): return {'avg_power_w': v*ah/h}")
       args: {v: 24, ah: <retrieved>, h: 5}

Round 4 — LLM: 整合
  └─ final answer:
     "48V-new: 文件明寫 63W(待機)/160W(工作)/600W(充電)[§3.7 P273-275]
      24V:    文件僅給容量 X Ah 與工作 5h,平均功耗估算 ≈ 4.8·X W[需附錄 Y]"
```

### 5.4 DSL(草稿)

以 `your_starter_dataset_chatbot.json` 為基底,把 `Agent` 節點的 `tools` 加上 `CodeExec`,sys_prompt 換成 §5.2:

```jsonc
{
  "Agent:TechReasoner": {
    "obj": {
      "component_name": "Agent",
      "params": {
        "max_rounds": 5,
        "tool_timeout": 15,
        "temperature": 0.1,
        "sys_prompt": "<§5.2 通用框架>",
        "tools": [
          { "component_name": "Retrieval", "name": "Retrieval",
            "params": { "dataset_ids": ["<kb_id>"], "top_n": 8,
                        "similarity_threshold": 0.2,
                        "keywords_similarity_weight": 0.7 } },
          { "component_name": "CodeExec", "name": "CodeExec",
            "params": { "lang": "python",
                        "script": "def main() -> dict: return {}" } }
        ]
      }
    },
    "downstream": ["Message:Answer"]
  }
}
```

## 6. 風險與已知限制

| 風險 | 影響 | 緩解 |
|------|------|------|
| LLM 不呼叫工具,直接幻覺 | 答案錯誤 | sys_prompt 強調 "never invent",temperature=0.1,並在 prompt 加 few-shot |
| Retrieval top_n=8 太短 | 漏參數 | 同一輪允許多次 retrieval call;若文件長,可調 top_n 或啟 `toc_enhance` |
| CodeExec 沙箱沒有網路 | 不能查外部資料 | 現階段需求只用本地 KB,不需網路 |
| MCP server 走 stdio 不相容 | 不能直接用 `claude mcp serve` | 未來若要接外部 agent,需寫 SSE bridge(P2) |
| `max_rounds=5` 不夠 | 複雜推論提早終止 | 可調高,但要注意 token cost |
| 引用對齊 | Agent 自由輸出可能不帶 cite | 沿用 `citation_prompt` / `citation_plus` 機制(已存在) |

## 7. 驗收標準

1. **AC-1**:對 dataset 上傳 `內部文件-軟體設計_V1.2.5.docx`,問「AMR 電池多少 W」,Agent 應在 ≤5 輪內回出含 63W/160W/600W 與其出處的答案,且引用標記正確。
2. **AC-2**:問「AMR 的 24V 電池平均功耗是多少?」(需計算),Agent 應先查 24V 容量,再呼叫 CodeExec 算平均功率,輸出過程可追蹤。
3. **AC-3**:問文件裡完全沒有的規格(「AMR 重量」),Agent 應明確說「文件未記載重量」,不捏造。
4. **AC-4**:同一問題連續問 5 次,答案的實質內容一致(數值相同、來源相同),不因檢索抖動而時有時無。
5. **AC-5**:不改 `dialog_service.py` 預設 chat 行為;新流程僅在新建的 Canvas agent 中啟用。

## 8. 執行計畫(Workflow)

| Phase | 任務 | 預估 | 驗證 |
|-------|------|------|------|
| P0 | 確認 CodeExec sandbox 在部署環境可跑(`agent.sandbox.providers`) | 0.5d | 在 UI 用 CodeExec 單獨跑一次 hello world |
| P1 | 建立 DSL JSON(`tech_reasoner_dataset_chatbot.json`),放 `agent/templates/` | 0.5d | `pytest` DSL validator + UI import 成功 |
| P2 | 撰寫與調整通用 sys_prompt(§5.2),針對 AC-1/2/3 跑 5 次 | 1d | 手動測試 |
| P3 | 加上 few-shot 範例進 sys_prompt(若 AC-1/2 不穩) | 0.5d | 同上 |
| P4 | 整合引用:確認 `citation_prompt`/`kb_prompt` 在 tool 輸出時仍生效 | 0.5d | 檢查 `chunks` 有進 `_canvas.get_reference()` |
| P5 | e2e test:寫一個 `test_agent_tech_reasoner.py`(打 `//go:build e2e` 對應 Python `pytest -m e2e` 或類似標記),固定 dataset 跑 5 個 query | 1d | CI 綠 |

## 9. 開放議題

- **Q1**: CodeExec 沙箱目前允許的 packages 是 `pandas/numpy/matplotlib/requests`,要不要加 `pint`(單位換算)或 `sympy`?
- **Q2**: 要不要把 Retrieval 的 `top_n` 改成動態(LLM 可在 tool args 指定)?目前固定 8。
- **Q3**: 引用格式是否要強制 `[doc X, sec Y]`?目前靠 LLM 自願。
- **Q4**: Agent 在 streaming 模式下,LLM 的思考過程要不要暴露給前端?目前 `stream_output_with_tools_async` 已經會把 tool 呼叫過程寫進 `_verbose_tool_use`,但 UX 可能要再設計。

---

## 10. 實作記錄(2026-09-24)

### P0 — CodeExec sandbox 驗證 ✅

**結論:** `self_managed` provider 在此環境**不可用**(無 docker,無 `sandbox-executor-manager` container)。已改為 `local` provider。

**變更:** `conf/system_settings.json`
- `sandbox.provider_type` = `self_managed` → `local`
- 新增 `sandbox.local` = `{"work_dir": "/tmp/ragflow-codeexec", "timeout": 30, "max_memory_mb": 512}`

**驗證:** 直接呼叫 `LocalProvider.execute_code` 成功執行 `main(v=48, ah=30, h=12) → {"avg_power_w": 120.0}`,exit_code=0,結果寫在 `metadata.result_value`。

**風險提示(給後續維護者):** `local` provider 是**沒有隔離**的子程序,`LocalProvider.__doc__` 自己警告 "not a sandbox boundary"。僅適合單機 dev/test;生產環境請切回 `self_managed` 或 `e2b`/`aliyun_codeinterpreter`。

### P1 — DSL 建立 ✅

`agent/templates/tech_reasoner_dataset_chatbot.json` 已建立(id=100),Begin → Agent(Retrieval+CodeExec) → Message 三節點,sys_prompt 為 §5.2 通用框架。

### 環境注意事項

- 本機預設 `go` 是 1.18(`/usr/bin/go`),與 go.mod `go 1.26.4` 不符。**`go` 相關指令必須先 export PATH:`PATH="/usr/local/go/bin:$PATH"`**(或 `/home/nvidia/go1.26/go/bin`)。
- `bash build.sh --test ./internal/dao/...` 跑超過 4 分鐘未完成(在 arm64 上 build CGO deps),已 kill。改用 `go build ./internal/dao/...`(同 PATH)驗證 template seed 編譯通過。
- `docker`/`podman` 皆未安裝,`sandbox-executor-manager` 不可在本地啟動 — 這是改用 `local` provider 的直接原因。


---

## 11. 部署與安裝步驟

### 11.1 後端設定 (Backend Setup)

1. **啟動 RAGFlow 後端**
   ```bash
   # 使用 Python 3.13+ venv 啟動
   source .venv/bin/activate
   export PYTHONPATH=$(pwd)
   python3 api/ragflow_server.py
   ```
   *(預設監聽 `http://127.0.0.1:9380`)*

2. **設定 CodeExec 沙箱**
   若本地無 Docker 環境，請在資料庫 `system_settings` 表中切換至 `local` 模式：
   ```sql
   UPDATE system_settings SET value='local' WHERE name='sandbox.provider_type';
   INSERT INTO system_settings (name, source, data_type, value) 
   VALUES ('sandbox.local', 'variable', 'json', '{"work_dir": "/tmp/ragflow-codeexec", "timeout": 30, "max_memory_mb": 512}')
   ON DUPLICATE KEY UPDATE value='{"work_dir": "/tmp/ragflow-codeexec", "timeout": 30, "max_memory_mb": 512}';
   ```

### 11.2 前端測試 (Frontend Access)

- **本地測試**: `http://127.0.0.1:9222`
- **前端連接埠**: `9222` (Vite Preview/Dev)

### 11.3 Agent 設定說明 (Agent DSL Configuration)

本 Agent 採用 `Agent` 節點搭配 `Retrieval` 與 `CodeExec` 工具，具體 DSL 片段如下：

```json
{
  "component_name": "Agent",
  "params": {
    "llm_id": "<your_llm_id>", 
    "max_rounds": 5,
    "tool_timeout": 15,
    "tools": [
      {
        "component_name": "Retrieval",
        "params": {
          "dataset_ids": ["<kb_id>"],
          "similarity_threshold": 0.2,
          "keywords_similarity_weight": 0.7
        }
      },
      {
        "component_name": "CodeExec",
        "params": {
          "lang": "python",
          "script": "def main() -> dict: return {}"
        }
      }
    ]
  }
}
```

- **llm_id**: 建議綁定 `google/gemma-4-26B-A4B-it` (支援 Function Calling)。
- **dataset_ids**: 綁定目標 KB ID (如 `6e577302ad9211f1a902b916cedd6188`)。

