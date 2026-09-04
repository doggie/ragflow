# RAGFlow 裸機 (GPU) 安裝 Runbook — 給 AI Agent 照做用

> **目標**:在 **GB10 / Jetson Orin / x86+NVIDIA GPU** 任一機器上,**無 Docker**,
> 把 RAGFlow 0.27.1 + 全部周邊服務 + llama.cpp GPU 模型服務完整裝起來。
> 所有能跑 GPU 的負載(LLM 推論 / embedding / rerank)一律 **GPU 全層 offload**。
>
> 本文件所有版本、路徑、參數都來自一台 **Jetson Orin AGX 64GB (L4T R36.3.0 / CUDA 12.2, aarch64)**
> 上已驗證跑通的部署;並已依 GB10 / x86 平台差異參數化。
>
> **所有模型一律從 https://huggingface.co 抓現成 GGUF(已逐一驗證存在)**;本 repo
> (`doggie/ragflow`,branch `main`)已內建以下修改,照本 runbook 安裝**不用再手動改**:
> - `conf/service_conf.yaml` — minio bucket、es port 9200、移除佔位 `user_default_llm`
> - `pyproject.toml` / `uv.lock` — `graspologic` 依賴 gitee → github
> - `rag/llm/rerank_model.py` — rerank timeout 30 → 600(top_k=1024 需要)
> - `rag/flow/parser/pdf_chunk_metadata.py` — chunk 預覽 crop 修復(見 §7.3)

---

## 0. 架構總覽(先讀)

| 元件 | 服務 | 監聽 | GPU? | 說明 |
|---|---|---|---|---|
| 聊天 LLM | `llama-server` | `:8080` | ✅ 全層 | Qwen3.6-35B-A3B MTP GGUF(多模態,含 mmproj) |
| Embedding | `llama-server` | `:8081` | ✅ 全層 | Qwen3-Embedding-0.6B f16 `--embedding` |
| Reranker | `llama-server` | `:8082` | ✅ 全層 | Qwen3-Reranker-0.6B **Q8_0** `--reranking` |
| RAGFlow API | python | `:9380` | ❌ | `api/ragflow_server.py --init-superuser` |
| Task Executor | python | — | ❌(CPU) | `rag/svr/task_executor.py -i 0 -t common`(chunking/解析) |
| Web UI | node(vite preview) | `:9222` | ❌ | 前端靜態檔 |
| MySQL 8 | `mysql.service` | `3306` | ❌ | 業務 metadata DB |
| Redis 6 | `redis.service` | `6379` | ❌ | 快取/佇列 |
| MinIO | `minio server` | `9000`/`9001` | ❌ | 物件儲存(檔案) |
| Elasticsearch 8 | `elasticsearch` | `9200` | ❌ | **文件檢索 store(docstore)** |

- **docstore = Elasticsearch**(service_conf 用 `es.hosts=http://localhost:9200`);**metadata DB = MySQL**。
- 所有 RAGFlow / llama 服務都是 **system-level systemd unit**(`/etc/systemd/system/`),`User=<runuser>`,`WantedBy=multi-user.target`,enabled。
- **無 Docker**。一切手動裝在 `INSTALL_ROOT`(本例 `/mnt/ssd`)。

### 平台參數(開頭先定死)
```bash
# ===== 依機器選一 =====
# Orin AGX 64GB : ARCH=aarch64  CUDA=12.2   MEM_GB=64    (L4T/JetPack 6)
# GB10 (Thor)   : ARCH=aarch64  CUDA=13.0   MEM_GB=128   (L4T/JetPack 7)
# x86 + NVIDIA  : ARCH=x86_64   CUDA=<12.x> MEM_GB=<視卡> (NVIDIA CUDA Toolkit)
# ------------------------------------
INSTALL_ROOT=/mnt/ssd          # 所有東西放這(SSD)
CODE=$INSTALL_ROOT/code
MODEL_DIR=$INSTALL_ROOT/models
RUNUSER=nvidia                 # 跑服務的非 root 使用者(Orin 預設 nvidia;x86 可自建)
NG=100                         # 全層 offload(27B/35B 聊天機用 100;0.6B 小模型 99/100 皆可)
# 依平台:
export CUDA_PATH=/usr/local/cuda     # Jetson/x86 皆此路徑(NV_CUDA 12 以上)
```
- **Orin/GB10 是「統一記憶體」**(CPU+GPU 共享);`nvidia-smi` 在 Orin 上無 memory 欄位是正常的,GPU 佔用看 `tegrastats` 或 `free`。
- x86 獨立顯存:確認 `nvidia-smi` 的 `Memory-Usage`。35B Q4_M 權重 ~21GB + KV,選 **≥24GB** 卡。
- **磁碟**:`$INSTALL_ROOT` 需 **~70GB 起**(模型 ~24GB + RAGFlow/venv ~8GB + ES/MySQL/MinIO/Node ~8GB + 餘裕);SSD 優於 HDD。

---

## 1. 前置系統套件(所有平台)

```bash
sudo apt-get update
sudo apt-get install -y \
  git curl wget build-essential cmake pkg-config \
  python3 python3-venv python3-pip \
  mysql-server mysql-client \
  redis-server \
  unzip ca-certificates

# uv(RAGFlow 建議用 uv 建 venv)
curl -LsSf https://astral.sh/uv/install.sh | sh
# x86 另需 NVIDIA CUDA Toolkit(依 CUDA_PATH);Jetson 已內建,免裝。
```

**CUDA 確認**(llama.cpp 編譯要找到 `nvcc`):
```bash
ls /usr/local/cuda/bin/nvcc && /usr/local/cuda/bin/nvcc --version
# 若 /usr/local/cuda 不存在: ln -sfn /usr/local/cuda-12.2 /usr/local/cuda  (Orin)
# x86 依你裝的 toolkit 版本
```

### 1b. Node.js 22(前端 build 用,§6.5)
```bash
NODE_VER=v22.13.1
NODE_ARCH=$([ "$ARCH" = "x86_64" ] && echo x64 || echo arm64)   # x86_64→x64, aarch64→arm64
cd $INSTALL_ROOT
curl -L https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-$NODE_ARCH.tar.xz -o node.tar.xz
tar xJf node.tar.xz && mv node-$NODE_VER-linux-$NODE_ARCH node && sudo chown -R $RUNUSER:$RUNUSER node
$INSTALL_ROOT/node/bin/node --version   # 預期 v22.13.1
```
> 或用 `nvm install 22`。web build(§6.5)與 web unit(§8.6)都指 `$INSTALL_ROOT/node/bin/node`。

---

## 2. 建非 root 執行者(Orin 已有 nvidia;新機可自建)

```bash
id nvidia >/dev/null 2>&1 || sudo useradd -m -s /bin/bash nvidia
sudo mkdir -p $INSTALL_ROOT && sudo chown -R nvidia:nvidia $INSTALL_ROOT
```
> 若 `nvidia` 密碼未知且需 sudo:Orin 預設 `nvidia:nvidia`,root 無密碼(可 `sudo -i`)。本 runbook 的 `sudo` 都假設 NOPASSWD 或可輸入。

---

## 3. 編譯 llama.cpp(帶 CUDA FlashAttention)

> 版本鎖定 **0.1.2-dev, commit `8497981`**(本部署用此版,`--reranking`/`--mmproj`/q4 KV 都支援)。
> 關鍵:`GGML_CUDA=ON`、`GGML_CUDA_FA=ON`(FlashAttention)、`GGML_CUDA_GRAPHS=ON`。

```bash
export PATH=$CUDA_PATH/bin:$PATH        # 讓 cmake 找到 nvcc(編譯期)
mkdir -p $CODE && cd $CODE
git clone https://github.com/ggml-org/llama.cpp.git llama.cpp
cd llama.cpp && git checkout 8497981    # 固定版本(可選;想跟最新就去掉這行)

# 一條指令編(CUDA + FlashAttention + CUDA graphs):
cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON -DGGML_CUDA_FA=ON
cmake --build build -j"$(nproc)" --config Release

# 只把 binary 放 PATH;convert_hf_to_gguf.py 留在原處(是 python script,用絕對路徑呼叫):
sudo cp build/bin/llama-server build/bin/llama-cli build/bin/llama-quantize /usr/local/bin/
/usr/local/bin/llama-server --version
# 預期: version: 0.1.2-dev (build 1, commit 8497981) ... CUDA
```

**驗證 GPU offload**(後面每個 llama-server 都看這行):
```bash
# 起一個小 model 時,log 應出現: "CUDA" / "offloaded XX/XX layers to GPU" / "CUDA API version"
```
- x86 若 `nvcc` 不在 PATH,`export PATH=$CUDA_PATH/bin:$PATH` 再編。
- 編譯完 `build/bin/libggml-cuda.so` 要存在(=CUDA 編成功)。

---

## 4. 模型(全部從 HuggingFace 抓現成 — 以下 repo/檔名已對 HF API 逐一驗證)

> CLI:`pip install -U "huggingface_hub[cli]"`,抓法 `hf download <repo> --include "<glob>" --local-dir $MODEL_DIR`。

### 4.1 聊天 LLM(35B MoE,含 MTP 推測權重)+ mmproj
**來源(已驗證):**
- `unsloth/Qwen3.6-35B-A3B-MTP-GGUF` → `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf`(22.6GB,**MTP 版**,含 spec 權重)
- `prism-ml/Ternary-Bonsai-27B-gguf` → `Ternary-Bonsai-27B-mmproj-Q8_0.gguf`(629MB,多模態 vision encoder)
```bash
cd $MODEL_DIR
hf download unsloth/Qwen3.6-35B-A3B-MTP-GGUF \
  --include "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf" --local-dir .
hf download prism-ml/Ternary-Bonsai-27B-gguf \
  --include "Ternary-Bonsai-27B-mmproj-Q8_0.gguf" --local-dir .
# 拿到: Qwen3.6-35B-A3B-UD-Q4_K_M.gguf + Ternary-Bonsai-27B-mmproj-Q8_0.gguf
```
> - **MTP 版**:unit 要加 `--spec-type draft-mtp` 三行(§8.1)。若改用非 MTP 版(如 `unsloth/Qwen3.6-35B-A3B-GGUF` 的 `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf`),**刪掉 spec 三行**。
> - 要更小:可換 `Q4_K_S` / `Q3_K_M` / `IQ4_NL` 等(同 repo 內都有)。
> - 本部署 Orin 上檔案名為 `Qwen3.6-35B-A3B-UD-Q4_K_M-mtp.gguf`(與 HF 檔同內容,僅多 `-mtp` 後綴),systemd unit 的路徑以實際檔名為準。

### 4.2 Embedding(0.6B)— 抓 f16 GGUF(免轉)
**來源(已驗證)** `Qwen/Qwen3-Embedding-0.6B-GGUF` 有 f16 與 Q8_0 兩版(本部署用 f16):
```bash
cd $MODEL_DIR
hf download Qwen/Qwen3-Embedding-0.6B-GGUF --include "Qwen3-Embedding-0.6B-f16.gguf" --local-dir .
# 拿到: Qwen3-Embedding-0.6B-f16.gguf (~1.2 GB)
```
> base repo `Qwen/Qwen3-Embedding-0.6B` 只有 `model.safetensors`;**GGUF 在 `...-GGUF` 這個 repo**。

### 4.3 Reranker(0.6B)— **直接抓現成 Q8_0 GGUF(免轉)**
**來源(已驗證)** `dean2155/Qwen3-Reranker-0.6B-Q8_0-GGUF`(注意:Qwen 官方**沒有** GGUF,只有 safetensors;這個是社群現成 Q8_0):
```bash
cd $MODEL_DIR
hf download dean2155/Qwen3-Reranker-0.6B-Q8_0-GGUF --local-dir .
# 拿到: qwen3-reranker-0.6b-q8_0.gguf (~639 MB)
```
> ⚠️ **務必 Q8_0**:實測 Q4_K_M 版 rerank 分數全≈0(相關/不相關都 0),Q8_0 才正確(相關→0.99+,不相關→0.0000x)。
> 若想自己轉 safetensors:`hf download Qwen/Qwen3-Reranker-0.6B --local-dir Qwen3-Reranker-0.6B`
> 再 `python3 $CODE/llama.cpp/convert_hf_to_gguf.py Qwen3-Reranker-0.6B --outtype f16 --outfile ...-f16.gguf`
> + `llama-quantize ...-f16.gguf ...Q8_0.gguf Q8_0`(轉換需 `pip install gguf transformers sentencepiece`)。

### 4.4 驗證
```bash
ls -la $MODEL_DIR/*.gguf
# 預期: Qwen3.6-35B-A3B-UD-Q4_K_M*.gguf + Ternary-Bonsai-27B-mmproj-Q8_0.gguf
#        + Qwen3-Embedding-0.6B-f16.gguf + qwen3-reranker-0.6b-q8_0.gguf
```

---

## 5. 後端服務(MySQL / Redis / MinIO / Elasticsearch)

### 5.1 MySQL 8(業務 DB)
```bash
sudo systemctl enable --now mysql
sudo mysql -uroot <<'SQL'
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'infini_rag_flow';
CREATE DATABASE IF NOT EXISTS rag_flow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
FLUSH PRIVILEGES;
SQL
mysql -h127.0.0.1 -uroot -pinfini_rag_flow -e "SELECT 1;"   # 預期 1
```

### 5.2 Redis 6
```bash
echo 'requirepass infini_rag_flow' | sudo tee -a /etc/redis/redis.conf >/dev/null
mkdir -p $INSTALL_ROOT/redis && sudo chown redis:redis $INSTALL_ROOT/redis
sudo sed -i "s|^dir .*|dir $INSTALL_ROOT/redis|" /etc/redis/redis.conf

# ⚠️ 致命坑(必做,否則重開機後 RAGFlow 靜默掛掉):
# Ubuntu 預設 redis-server.service 有 `ProtectSystem=true`,把整個 FS 設 read-only,
# 只 whitelist /var/lib/redis、/var/log/redis、/etc/redis。若 dir 放在 $INSTALL_ROOT/redis(不在 whitelist),
# redis 的私有 mount namespace 裡該路徑是 **ro** → 每次 BGSAVE 都 "Read-only file system"
# → `stop-writes-on-bgsave-error` 把**所有寫入**停用 → RAGFlow 的 queue/lock/progress 全掛,
#   API journal 一直出現 `valkey ... MISCONF ... not able to persist on disk`。
# 現象:redis 本身 is-active=active、ping PONG 都正常,但 RAGFlow 無法寫入 → 看似沒壞其實壞了。
# 修:drop-in 把 redis dir 加進可寫路徑(namespace 會 bind 成 rw)。
sudo mkdir -p /etc/systemd/system/redis-server.service.d
printf '[Service]\nReadWritePaths=%s\n[Unit]\nAfter=local-fs.target\n' "$INSTALL_ROOT/redis" \
  | sudo tee /etc/systemd/system/redis-server.service.d/override.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now redis
redis-cli -a infini_rag_flow ping   # 預期 PONG
# 關鍵驗證(必查,不是只看 PONG):
redis-cli -a infini_rag_flow set __t ok                       # 預期 OK(若回 MISCONF 就是上面那個坑)
redis-cli -a infini_rag_flow info persistence | grep rdb_last_bgsave_status   # 預期 :ok
```
> 若 redis 卡在 MISCONF,`systemctl stop redis` 會**卡死**(SIGTERM→優雅 shutdown→save,save 在 ro 失敗→hang)。要 `sudo kill -9 $(pgrep -x redis-server)` 再 `systemctl start redis`。

### 5.3 MinIO(物件儲存)
```bash
# 抓 binary(release 2025-09-07;依平台架構)
curl -L https://dl.min.io/server/minio/release/linux-${ARCH}/minio -o /usr/local/bin/minio
chmod +x /usr/local/bin/minio
mkdir -p $INSTALL_ROOT/minio/data && sudo chown -R $RUNUSER:$RUNUSER $INSTALL_ROOT/minio
# 起(先手動測;systemd 見 §8)
MINIO_ROOT_USER=rag_flow MINIO_ROOT_PASSWORD=infini_rag_flow \
  minio server $INSTALL_ROOT/minio/data --address 127.0.0.1:9000 --console-address 127.0.0.1:9001 &
# 建 bucket
mc alias set local http://127.0.0.1:9000 rag_flow infini_rag_flow 2>/dev/null \
  || curl -L https://dl.min.io/client/mc/release/linux-${ARCH}/mc -o /usr/local/bin/mc && chmod +x /usr/local/bin/mc && mc alias set local http://127.0.0.1:9000 rag_flow infini_rag_flow
mc mb -p local/ragflow && mc anonymous set download local/ragflow
```

### 5.4 Elasticsearch 8(docstore)
```bash
cd $CODE
curl -L https://artifacts.elastic.co/downloads/elasticsearch/elasticsearch-8.13.4-linux-aarch64.tar.gz | tar xz   # x86: -x86_64
mkdir -p $INSTALL_ROOT/elasticsearch && mv elasticsearch-8.13.4 $INSTALL_ROOT/elasticsearch/
cd $INSTALL_ROOT/elasticsearch
# 建 elastic 密碼(infini_rag_flow)
bin/elasticsearch-keystore create-password --stdin <<EOF
infini_rag_flow
EOF
# 記憶體設定(Orin/GB10 統一記憶體,ES 給 ~2G)
echo "es.jvm.argstring.heap.size=2g" > config/jvm.options.d/heap.options
echo "xpack.security.enabled=false"  >> config/elasticsearch.yml
echo "discovery.type=single-node"    >> config/elasticsearch.yml
echo "network.host=127.0.0.1"        >> config/elasticsearch.yml
# 手動測起
bin/elasticsearch -d -p es.pid
sleep 20
curl -s http://127.0.0.1:9200   # 預期回 JSON(cluster name 等)
```
> ES 需 JDK;tarball 內含 `jdk/`,免另裝。**vm.max_map_count 記得設(§8.8 有 sysctl 那行)。**

---

## 6. RAGFlow core(clone + venv + 設定)

### 6.1 Clone(用**本 repo**,已含全部修改)
```bash
cd $CODE
git clone --depth 1 --branch main https://github.com/doggie/ragflow.git ragflow
cd ragflow
# 預期 HEAD = f5196fb(fix(deploy): bare-metal Orin fixes)及其上游歷史,pyproject version = "0.27.1"
```

### 6.2 venv(uv)
```bash
cd $CODE/ragflow
uv venv --python 3.13 .venv
# 本 repo 已把 graspologic 依賴從 gitee 改指 github(pyproject.toml / uv.lock),不會再踩 gitee SSL 坑。
# 若仍要從上游原版 clone,才需要:
#   export GIT_SSL_NO_VERIFY=1 && git config --global http.https://gitee.com/sslVerify false
uv sync            # 會拉 ~691 packages,首跑 5-15 分鐘
unset GIT_SSL_NO_VERIFY
.venv/bin/python -c "import ragflow, uvicorn; print('venv OK')"
```

### 6.3 service_conf.yaml(本 repo 已改好;確認幾項)
確認 `$CODE/ragflow/conf/service_conf.yaml`:
```yaml
mysql:  { name: 'rag_flow', user: 'root', password: 'infini_rag_flow', host: 'localhost', port: 3306 }
redis:  { db: 1, password: 'infini_rag_flow', host: 'localhost:6379' }
minio:  { user: 'rag_flow', password: 'infini_rag_flow', host: 'localhost:9000', bucket: 'ragflow' }
es:     { hosts: 'http://localhost:9200', username: 'elastic', password: 'infini_rag_flow' }
```

### 6.4 NLTK / DeepDoc
```bash
# DeepDoc ONNX 模型已隨 repo 在 rag/res/deepdoc/(det/layout/rec/tsr.onnx)—— 免下載。
# NLTK 語料(chat 用):
.venv/bin/python -m spacy download en_core_web_sm 2>/dev/null || true
.venv/bin/python - <<'PY'
import nltk
for p in ["punkt","punkt_tab","stopwords","wordnet","omw-1.4"]:
    nltk.download(p, halt_on_error=False, quiet=True)
print(nltk.data.path)
PY
```

### 6.5 前端 build
```bash
cd $CODE/ragflow/web
npm ci          # 或 npm install
npm run build   # = vite build --mode production(約 3-4 分鐘,產出 web/dist)
ls dist/index.html   # 預期存在
```
> Node 裝法:`nvm install 22` 或官方 tarball 放 `$INSTALL_ROOT/node`(§1b)。

---

## 7. RAGFlow 端小改動(本 repo **已內建**,僅供對照/上游版使用)

### 7.1 Rerank timeout 30→600(top_k=1024 會一次 rerank 1024 篇)
```bash
# 本 repo 已改(rag/llm/rerank_model.py line ~289: requests.post(..., timeout=600))。
# 從上游原版 clone 才需手動:
#   sed -i '289s/timeout=30/timeout=600/' rag/llm/rerank_model.py
```
> 原因:GPU rerank 1024 篇 ~90s,30s 必超時。

### 7.2 (可選)對話 top_k
> 本部署 top_k=1024 **不改**。若 GPU 吃緊可調小,但 rerank timeout 要同步估。

### 7.3 (本 repo 已修)chunk 預覽 crop 崩潰 — "Coordinate lower is less than upper"
> 上游 `rag/flow/parser/pdf_chunk_metadata.py` 的 `_crop_pdf_preview` 只 clamp 下界不 clamp 上界,
> 版面偵測給出的 top 超出頁面高度時 PIL `crop()` 會炸 → chunking 階段 `Internal server error while chunking`。
> 本 repo 已修:top/bottom 都 clamp 到 `[0, page_h]`,並包 try/except 跳過無效 bbox。
> 從上游原版 clone 才需手動套(可參考本 repo `rag/flow/parser/pdf_chunk_metadata.py` 的 crop loop)。

---

## 8. systemd units(全部放 /etc/systemd/system/)

> 全部 `User=$RUNUSER`,enabled。以下 8 支 unit。依 `RUNUSER`/路徑替換。

### 8.1 llama-server.service(聊天 :8080)
```ini
[Unit]
Description=Llama.cpp Server (chat, GPU)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nvidia
Group=nvidia
Environment=PATH=/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/local/bin/llama-server \
  -m /mnt/ssd/models/Qwen3.6-35B-A3B-UD-Q4_K_M-mtp.gguf \
  --mmproj /mnt/ssd/models/Ternary-Bonsai-27B-mmproj-Q8_0.gguf \
  --host 0.0.0.0 \
  -ngl 100 \
  -c 200000 \
  -n 16384 \
  -np 1 \
  --threads 8 \
  --threads-batch 8 \
  --flash-attn on \
  --kv-unified \
  --cache-type-k q4_0 \
  --cache-type-v q4_0 \
  --cache-ram 12288 \
  --fit on \
  --spec-type draft-mtp \
  --spec-draft-n-max 3 \
  --spec-draft-p-min 0.5 \
  --spec-draft-ngl 100
Restart=on-failure
RestartSec=10
LimitMEMLOCK=infinity
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```
> ⚠️ **關鍵**:`-c 200000` 若用預設 f16 KV 會直接 swap 崩(35B 權重 ~21GB + f16 KV > 記憶體)。
> **必須** `--cache-type-k q4_0 --cache-type-v q4_0 --fit on`(修後 prompt ~250 tok/s)。
> **MTP 版**:保留 `--spec-type draft-mtp` 三行;**非 MTP 版刪掉這三行**。
> 小卡/小模型把 `-c` 調小(如 32768)可省 KV。
> **純文字(不要 VLM)**:刪掉 `--mmproj` 那一行。

### 8.2 llama-embedding.service(:8081)
```ini
[Unit]
Description=llama.cpp Embedding Server (Qwen3-Embedding-0.6B :8081)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nvidia
Group=nvidia
ExecStart=/usr/local/bin/llama-server --model /mnt/ssd/models/Qwen3-Embedding-0.6B-f16.gguf --host 127.0.0.1 --port 8081 -ngl 99 --embedding --ctx-size 8192 --alias qwen3-embedding-0.6b
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### 8.3 ragflow-reranker.service(:8082,GPU)
```ini
[Unit]
Description=RAGFlow Reranker Server (:8082, llama.cpp GPU)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nvidia
Group=nvidia
Environment=PATH=/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/local/bin/llama-server \
  -m /mnt/ssd/models/qwen3-reranker-0.6b-q8_0.gguf \
  --host 127.0.0.1 \
  --port 8082 \
  --reranking \
  -ngl 99 \
  -c 32768 \
  -b 2048 \
  -ub 2048 \
  --threads 8 \
  --threads-batch 8 \
  --alias qwen3-reranker-0.6b
Restart=on-failure
RestartSec=10
LimitMEMLOCK=infinity
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```
> ⚠️ `-b/-ub 2048` **必須 ≥ 單篇 chunk 的 token 數**(預設 256 會 `input too large` 500)。
> ⚠️ **reranker 用 Q8_0**(Q4 分數壞)。

### 8.4 ragflow-api.service(:9380)
```ini
[Unit]
Description=RAGFlow API Server (:9380)
After=network-online.target mysql.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=nvidia
Group=nvidia
WorkingDirectory=/mnt/ssd/code/ragflow
Environment=PYTHONPATH=/mnt/ssd/code/ragflow
Environment=PATH=/mnt/ssd/code/ragflow/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/mnt/ssd/code/ragflow/.venv/bin/python api/ragflow_server.py --init-superuser
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### 8.5 ragflow-task-executor.service
```ini
[Unit]
Description=RAGFlow Task Executor (chunking/embedding)
After=network-online.target mysql.service redis-server.service ragflow-api.service
Wants=network-online.target

[Service]
Type=simple
User=nvidia
Group=nvidia
WorkingDirectory=/mnt/ssd/code/ragflow
Environment=PYTHONPATH=/mnt/ssd/code/ragflow
Environment=PATH=/mnt/ssd/code/ragflow/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/mnt/ssd/code/ragflow/.venv/bin/python rag/svr/task_executor.py -i 0 -t common
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### 8.6 ragflow-web.service(:9222)
```ini
[Unit]
Description=RAGFlow Web UI (vite preview :9222)
After=network-online.target ragflow-api.service
Wants=network-online.target

[Service]
Type=simple
User=nvidia
Group=nvidia
WorkingDirectory=/mnt/ssd/code/ragflow/web
Environment=PATH=/mnt/ssd/node/bin:/mnt/ssd/code/ragflow/web/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/mnt/ssd/node/bin/node /mnt/ssd/code/ragflow/web/node_modules/.bin/vite preview --host --port 9222
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### 8.7 minio.service
```ini
[Unit]
Description=MinIO Object Storage
After=network-online.target local-fs.target
Wants=network-online.target

[Service]
Type=simple
User=nvidia
Group=nvidia
Environment=MINIO_ROOT_USER=rag_flow
Environment=MINIO_ROOT_PASSWORD=infini_rag_flow
ExecStart=/usr/local/bin/minio server /mnt/ssd/minio/data --address 127.0.0.1:9000 --console-address 127.0.0.1:9001
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### 8.8 elasticsearch.service
```ini
[Unit]
Description=Elasticsearch (RAGFlow docstore)
After=network-online.target local-fs.target
Wants=network-online.target

[Service]
Type=simple
User=nvidia
Group=nvidia
WorkingDirectory=/mnt/ssd/elasticsearch/elasticsearch-8.13.4
Environment=ES_JAVA_OPTS=-Xms2g -Xmx2g
Environment=ES_PATH_CONF=/mnt/ssd/elasticsearch/elasticsearch-8.13.4/config
ExecStart=/mnt/ssd/elasticsearch/elasticsearch-8.13.4/bin/elasticsearch
Restart=on-failure
RestartSec=20
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```
> ES 需 `vm.max_map_count=262144`:`echo 'vm.max_map_count=262144' | sudo tee /etc/sysctl.d/99-es.conf && sudo sysctl --system`。
> ⚠️ 用 **foreground**(`Type=simple`,**不要** `-d -p`):`-d` daemonize 會讓 systemd 抓不到 PID、誤判已停/一直重啟。
> 若 §5.4 手動測起時用了 `bin/elasticsearch -d -p es.pid`,**enable 這支 unit 前務必先停掉**(否則 :9200 被佔,unit 起不來)。

### 8.9 部署 & 啟動
```bash
# 把上面 8 支 .service 放 /etc/systemd/system/(用 scp/tar 或 vim 建),然後:
# ⚠️ 若 §5.3/§5.4 手動測起過 MinIO/ES,先清乾淨,否則 :9000/:9200 被佔 → unit 起不來(193 就栽在這):
sudo pkill -9 -f "minio server $INSTALL_ROOT/minio/data" 2>/dev/null
[ -f $INSTALL_ROOT/elasticsearch/es.pid ] && sudo kill "$(cat $INSTALL_ROOT/elasticsearch/es.pid)" 2>/dev/null
sudo fuser -k 9200/tcp 9000/tcp 2>/dev/null   # 保險:按 port 清乾淨
sleep 3
sudo systemctl daemon-reload
for u in elasticsearch minio mysql redis-server llama-server llama-embedding ragflow-reranker ragflow-api ragflow-task-executor ragflow-web; do
  sudo systemctl enable --now $u
done
sleep 30
systemctl is-active elasticsearch minio mysql redis-server llama-server llama-embedding ragflow-reranker ragflow-api ragflow-task-executor ragflow-web
# 預期: 全 active
```
> 啟動順序:先後端(ES/MySQL/Redis/MinIO)→ llama x3 → RAGFlow API → task-executor → web。
> `After=` 已排,但手動首啟建議依序,方便看誰沒起來。

---

## 9. RAGFlow 模型 provider 設定(DB)

> API 起來後,把 3 個 llama endpoint 接進 RAGFlow(可用 API 或前端)。本部署用 DB 直插(前端等價):
> provider `OpenAI-API-Compatible` 下 3 instance:

```bash
# (A) 用 RAGFlow API 加(推薦;或用前端 Models 頁)
# chat  -> http://127.0.0.1:8080/v1
# embd  -> http://127.0.0.1:8081/v1
# rerank-> http://127.0.0.1:8082   (會自動 append /rerank)
#
# (B) 或直接看/改 DB(tenant_model_provider / tenant_model_instance):
mysql -h127.0.0.1 -uroot -pinfini_rag_flow rag_flow -e \
  "SELECT id, instance_name, provider_id, extra FROM tenant_model_instance;"
```
> 每個 instance 的 `extra` 是 `{"base_url": "http://127.0.0.1:PORT/v1"}`。
> **rerank 走 OpenAI-API-Compatible factory → RAGFlow 的 `OpenAI_APIRerank`**,會 POST `.../rerank`,
> payload `{"model","query","documents","top_n"}`,解析 `results[].index`+`relevance_score`(llama.cpp 原生相容)。

### 9.1 登入怪癖(RSA)
> 前端/API 登入的密碼要 **RSA 加密**:`conf/public.pem`(passphrase "Welcome")。
> 流程 = `base64(明文密碼)` → RSA PKCS1v15 加密 → `base64`。明文會回 `"Fail to crypt password"`(正常,不是壞)。
> admin 帳號 `admin@ragflow.io / admin`(首登後建議改)。

---

## 10. 驗證(照單全收才算完)

```bash
# 1) 三隻 llama 健康
curl -s http://127.0.0.1:8080/health   # {"status":"ok"}
curl -s http://127.0.0.1:8081/health   # {"status":"ok"}
curl -s http://127.0.0.1:8082/health   # {"status":"ok"}

# 1b) **確認真跑在 GPU**(必查!llama 沒吃到 GPU 也會「健康」,只是慢 10-100 倍)
journalctl -u llama-server -u llama-embedding -u ragflow-reranker --no-pager 2>/dev/null \
  | grep -iE "offloaded .* layers to GPU|CUDA API version|CUDA0" | tail
# 預期:每支都有 "offloaded <全部層> layers to GPU"。
#   若看到 "offloaded 0/..." 或 "CPU " → GPU 沒吃上 → 查 §3(nvcc 在 PATH?`build/bin/libggml-cuda.so` 存在?)與 unit 的 -ngl。
# 另:x86 用 `nvidia-smi` 看該行程 VRAM 佔用;Jetson 用 `tegrastats` 看 GPU-Util(>0 即在跑)。

# 2) chat 快(量 prompt tok/s,應 >>10)
curl -s -X POST http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"x","messages":[{"role":"user","content":"say hi"}],"max_tokens":5}'

# 3) embedding
curl -s -X POST http://127.0.0.1:8081/embeddings \
  -H "Content-Type: application/json" -d '{"model":"x","input":["hello"]}' | head -c 200

# 4) rerank 分數 sanity(相關應 0.99+,不相關 ~0)
curl -s -X POST http://127.0.0.1:8082/rerank -H "Content-Type: application/json" -d '{
 "model":"x","query":"Jetson Orin GPU memory size",
 "documents":["Jetson Orin AGX has 64GB of unified LPDDR5 memory.",
              "Banana pancakes are a popular breakfast in Seattle."],
 "top_n":2}'
# 預期: doc0≈0.99+, doc1≈0.000x   ← 若兩個都≈0 → reranker GGUF 用錯(要 Q8_0)

# 5) RAGFlow API
curl -s http://127.0.0.1:9380/health   # {"code":0...}
# 6) web
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:9222   # 200
```

---

## 11. 平台差異速查

| 項目 | Orin AGX 64GB (本部署) | GB10 (Thor, 128GB) | x86 + NVIDIA GPU |
|---|---|---|---|
| ARCH | aarch64 | aarch64 | x86_64 |
| CUDA | 12.2(L4T 內建) | 13.0(L4T 內建) | 12.x(NVIDIA toolkit 自裝) |
| 記憶體 | 統一 64GB | 統一 128GB | 獨立顯存(≥24GB) |
| llama.cpp | `GGML_CUDA=ON`,commit 8497981 | 同(編譯吃 CUDA 13) | 同(`nvcc` 在 PATH) |
| `-ngl` | 35B→100 / 小→99 | 同 | 同(全層) |
| 35B Q4_M 裝得下? | ✅(~21GB,64GB 統一) | ✅✅(128GB,可更大模型/更長 ctx) | 需 ≥24GB 卡 |
| 200K ctx KV | 必須 q4 KV + `--fit`(64GB 緊) | 更寬裕,可 f16 或更大 | 視卡 |
| ES 記憶體 | 2g | 4-8g | 4-8g |
| 抓 MinIO | `linux-arm64` | `linux-arm64` | `linux-amd64` |
| 抓 ES | `linux-aarch64` | `linux-aarch64` | `linux-x86_64` |

**GB10 特別注意**:JetPack 7 用 CUDA 13,torch(若要 python 模型)要 cu13 版;llama.cpp 從源編自動吃系統 CUDA,通常順。記憶體多,可跑更大模型或更長 ctx。

**x86 特別注意**:CUDA toolkit 手裝(加 `PATH`+`LD_LIBRARY_PATH`);`nvidia-smi` 確認卡;35B Q4 + 200K q4-KV 需 ~24GB+,選 3090/4090/A 系列。

---

## 12. 已知坑(照序排查)

1. **`uv sync` 掛在 `graspologic`(gitee SSL `CAfile: none`)** → 本 repo 已把依賴改指 github(§6.2);上游原版才需 `GIT_SSL_NO_VERIFY=1`。
2. **35B 200K ctx 卡死(~1 tok/s)** → 沒加 q4 KV。加 `--cache-type-k q4_0 --cache-type-v q4_0 --fit on`。
3. **rerank 分數全≈0** → GGUF 用了 Q4_K_M。換 **Q8_0**(§4.3 已抓現成 Q8)。
4. **rerank 500 `input too large`** → `-b/-ub` 太小。設 `2048`(≥ 單篇 chunk token)。
5. **rerank 30s 超時** → RAGFlow `rerank_model.py` timeout 30→600(§7.1,本 repo 已改)。
6. **登入 `Fail to crypt password`** → 正常,密碼要 RSA 加密(§9.1)。
7. **llama-server 起不來 / 沒 GPU** → `nvcc` 沒在 PATH 或沒編 CUDA。查 `build/bin/libggml-cuda.so` 存在、`nvidia-smi` 正常。
8. **ES 起不來** → `vm.max_map_count` 沒調(§8.8)。
9. **前端 404 / 空白** → 沒 `npm run build`(dist 不存在)或 vite preview 沒指對 dir。
10. **重開機後 RAGFlow 靜默全掛(redis `MISCONF` / 無法寫入)** → redis `dir` 放 `$INSTALL_ROOT/redis` 但沒加 drop-in。Ubuntu 預設 `ProtectSystem=true` 把 FS 設 ro(§5.2)。**必做**:drop-in `ReadWritePaths=$INSTALL_ROOT/redis`。驗證 `set __t ok`=OK、`rdb_last_bgsave_status:ok`(不是只看 PONG)。
11. **重開機後 ES/MinIO 沒起來** → 它們沒用 systemd(手動 nohup)。務必建 `elasticsearch.service`+`minio.service` 並 `enable`(§8.7/8.8),且 `After=local-fs.target`。
12. **`systemctl stop redis` 卡死** → redis 在 ro namespace 時,SIGTERM 觸發 save 失敗→hang。用 `sudo kill -9 $(pgrep -x redis-server)`。
13. **chunking 時 `Internal server error: Coordinate lower is less than upper`** → chunk 預覽 crop bug(§7.3,本 repo 已修;上游需手動套)。

---

## 13. 檔案地圖(本部署實際)

```
/mnt/ssd/
  code/ragflow/            # RAGFlow 0.27.1 (本 repo main, HEAD f5196fb), .venv/ (uv, CPython 3.13), web/dist (vite build)
  code/llama.cpp/          # build 1, commit 8497981, GGML_CUDA=ON
  models/                  # Qwen3.6-35B-A3B-UD-Q4_K_M-mtp.gguf + Ternary-Bonsai-27B-mmproj-Q8_0.gguf
                           # + Qwen3-Embedding-0.6B-f16.gguf + qwen3-reranker-0.6b-q8_0.gguf
  elasticsearch/           # elasticsearch-8.13.4/ (tarball, 內含 jdk)
  minio/                   # data/
  mysql/ redis/            # 系統套件 data(root/redis 擁有)
  node/                    # node v22.13.1
  nltk_data/               # punkt/punkt_tab/stopwords/wordnet/omw-1.4
  rerank/                  # (舊 python reranker,已棄用,可留可刪)
/etc/systemd/system/       # 8 支 unit(§8)
```

---

## 附:模型來源對照(全部 HF 現成,已驗證)

| 用途 | 檔名 | HF 來源 repo | 大小 | 備註 |
|---|---|---|---|---|
| chat | `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf` | `unsloth/Qwen3.6-35B-A3B-MTP-GGUF` | 22.6GB | MTP 版含 spec 權重;本地可改名為 `...-mtp.gguf` |
| VLM | `Ternary-Bonsai-27B-mmproj-Q8_0.gguf` | `prism-ml/Ternary-Bonsai-27B-gguf` | 629MB | mmproj(vision encoder);純文字可省 |
| embedding | `Qwen3-Embedding-0.6B-f16.gguf` | `Qwen/Qwen3-Embedding-0.6B-GGUF` | 1.2GB | `--embedding` |
| rerank | `qwen3-reranker-0.6b-q8_0.gguf` | `dean2155/Qwen3-Reranker-0.6B-Q8_0-GGUF` | 639MB | **務必 Q8_0**;`--reranking` |

> 抓取一律 `hf download <repo> --include "<glob>" --local-dir $MODEL_DIR`;
> Qwen 官方 reranker 只有 safetensors,本 runbook 用社群現成 Q8_0(§4.3),不必自己轉。
