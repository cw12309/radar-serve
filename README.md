# RADAR 腹部 CT 智能辅助诊断服务

基于阿里达摩院 **RADAR** 通用医学视觉-语言模型（*Science* 2026, doi [10.1126/science.aec6129](https://www.science.org/doi/10.1126/science.aec6129)）构建的院内腹部 CT 辅助诊断系统。上传 DICOM/NIfTI 影像后，自动完成 **36 个解剖结构分割** + **146 项征象阳性概率评估**，并在 OHIF 阅片器中叠加显示分割掩码与注意力热图，支持医师逐项采纳后由 LLM 撰写规范化影像报告并导出 PDF。

> **重要声明**：RADAR 模型目前仅用于科研目的，尚未经过前瞻性临床研究验证，**不得直接用于临床诊断决策**。所有输出必须由具备资质的放射科医师复核。

---

## 一、系统架构

系统由 4 个常驻组件构成，通过端口与 Unix socket 协作：

```
                    ┌──────────────────────────────────────────────┐
                    │  start_radar.sh（看门狗，每 5 秒探活并自动拉起） │
                    └───────────────┬──────────────────────────────┘
                                    │ 监控
              ┌─────────────────────┴─────────────────────┐
              ▼                                           ▼
   ┌──────────────────────┐                    ┌─────────────────────┐
   │  Flask 主服务         │  DICOMweb (HTTP)   │  OHIF 阅片器         │
   │  flask-app/app.py    │ ─────────────────► │  webpack dev server │
   │  :5000               │ ◄───── iframe ───── │  :3002              │
   └──────────┬───────────┘                    └─────────────────────┘
              │ Unix socket (JSON 行协议)
              │ /tmp/radar_infer.sock
              ▼
   ┌──────────────────────┐        ┌──────────────────────────────┐
   │  常驻推理守护进程      │  GPU   │  报告撰写 Agent               │
   │  infer_daemon.py     │ ─────► │  report_agent.py             │
   │  权重常驻，单次加载    │        │  → OpenAI 兼容 LLM 接口       │
   └──────────────────────┘        └──────────────────────────────┘
```

| 组件 | 入口 | 监听 | 职责 |
|---|---|---|---|
| Flask 主服务 | `flask-app/app.py` | `0.0.0.0:5000` | Web UI、影像上传与 DICOM→NIfTI 转换、DICOMweb 服务、诊断调度、报告生成、历史库、院内影像库 |
| OHIF 阅片器 | `ohif-viewer/platform/app` | `:3002` | 专业级 CT 阅片、分割掩码叠加、3D 重建 |
| 推理守护进程 | `flask-app/infer_daemon.py` | `/tmp/radar_infer.sock` | 模型权重只加载一次并常驻，接收推理任务，避免每次诊断重新加载 1.5GB 权重 |
| 看门狗 | `start_radar.sh` | — | 每 5 秒检查 5000/3002，进程崩溃后自动拉起 |

**降级路径**：`infer_daemon` 崩溃或 socket 不可用时，Flask 自动回退到一次性子进程模式（`infer_worker.py`），单次诊断变慢但服务不中断。`infer_daemon` 本身**不受看门狗保护**，需单独启动。

---

## 二、环境要求

| 项 | 要求 | 当前部署实测值 |
|---|---|---|
| 操作系统 | Linux x86_64 | Ubuntu / Debian |
| Python | 3.10 | 3.10.22（conda env `radar`） |
| PyTorch | 2.x + CUDA | 2.14.1+cu130 |
| CUDA | ≥ 12.x | 13.0 |
| GPU | 显存 ≥ 8GB（推荐 24GB） | RTX 4090 24GB |
| Node.js | 18.x（OHIF 构建） | v18.16.0 |
| 内存 | ≥ 32GB | 125GB |
| 磁盘 | ≥ 20GB（含 5GB 权重） | — |

**显存占用实测**：单次滑窗前向峰值 **6385 MiB**，约 **6.9 s/窗**；守护进程常态驻留约 7.3GB。8GB 显卡在修复前的代码路径下会 OOM，请确认使用当前版本。

### Python 依赖

依赖分两层，**版本必须严格锁定**（详见 [SETUP.md](SETUP.md)）：

```bash
# 推理核心（RADAR_inference / radar-web）
transformers==4.25      # 高版本会破坏 XBertEncoder 兼容性
timm==0.4.12
fairscale==0.4.4
monai
batchgenerators
diffusers<=0.16.0

# Web 服务层（flask-app/requirements.txt）
numpy>=1.24,<2.0        # numpy 2.x 与现有二进制扩展不兼容
pydicom>=2.4,<3.0
reportlab               # PDF 报告渲染
flask, requests, ...
```

---

## 三、模型权重准备

仓库出于体积考虑**不包含** `.pth` 权重（已在 `.gitignore` 中排除）。运行时需要以下 3 项：

| 文件 | 必需 | 来源 | 大小 |
|---|---|---|---|
| `ckpt/checkpoint_radar_pretrain.pth` | ✅ | HuggingFace 下载 | 1.57 GB |
| `ckpt/bert-base-chinese/` | ✅ | HuggingFace 下载（含 `config.json`、词表、权重） | ~400 MB |
| `ckpt/infer_text_embedding_radar.pt` | ✅ | **已随仓库分发**（Git LFS） | 346 KB |

```bash
# 方式一：使用仓库自带下载脚本
python download_scripts/download_checkpoints.py

# 方式二：手动从 HuggingFace 获取
#   https://huggingface.co/datasets/radar-generalist/RADAR
#   放置到 ckpt/ 目录下，保持文件名不变
```

克隆仓库后请先拉取 LFS 对象：

```bash
git lfs install
git lfs pull
```

> `CONFIGS_ROOT` 环境变量控制 BERT 查找路径，默认 `../ckpt`。`radar-web/modules/inference_engine.py` 会自动设置为仓库的 `ckpt/`，一般无需手工干预。

---

## 四、安装

```bash
# 1. 克隆（内网仓库）
git clone http://192.168.0.155/data-standardization/radar-serve.git radar
cd radar
git lfs pull

# 2. 创建 conda 环境
conda create -n radar python=3.10 -y
conda activate radar

# 3. 安装推理依赖
pip install -r requirements.txt

# 4. 安装 Web 服务依赖
pip install -r flask-app/requirements.txt

# 5. 安装 OHIF 前端依赖（首次约需 10-20 分钟）
cd ohif-viewer && yarn install && cd ../..

# 6. 准备权重（见上一节）
python download_scripts/download_checkpoints.py
```

---

## 五、启动与停止

### 一键启动（推荐）

```bash
cd /path/to/radar

# 前台看门狗（Ctrl+C 退出，服务随之保留）
./start_radar.sh

# 后台常驻
nohup ./start_radar.sh >> radar_watchdog.log 2>&1 &
```

看门狗会按需拉起 Flask（`:5000`）与 OHIF（`:3002`）；**已在运行的实例不会被重启**，因此可以安全地在服务运行期间执行该脚本。

### 启动常驻推理守护进程

`infer_daemon` 不在看门狗管辖范围内，需单独启动：

```bash
nohup /path/to/conda/envs/radar/bin/python flask-app/infer_daemon.py \
    --socket /tmp/radar_infer.sock --use-gpu \
    >> logs/infer_daemon.log 2>&1 &
```

首次启动需加载权重（数十秒），日志出现 `模型加载完成 device=cuda:0，开始监听 /tmp/radar_infer.sock` 即就绪。

### 访问

| 地址 | 说明 |
|---|---|
| `http://<服务器IP>:5000/` | 完整工作台（上传、阅片、报告、历史库） |
| `http://<服务器IP>:5000/ai` | 简化版 AI 诊断页 |
| `http://<服务器IP>:3002/` | OHIF 阅片器（通常经主服务 iframe 嵌入，无需直接访问） |

### 停止

```bash
# 停止看门狗（否则它会在 5 秒内把服务重新拉起）
pkill -f start_radar.sh

# 停止各服务
pkill -f 'flask-app/app.py'   # 或 pkill -f 'python app.py'
pkill -f infer_daemon.py
pkill -f 'webpack serve'
```

---

## 六、配置

### `flask-app/settings.json`

```json
{
  "theme": "dark",
  "language": "zh-CN",
  "confidence_threshold": 0.7,
  "use_gpu": true,
  "viewer_source": "local5000",
  "library_roots": [
    { "name": "清华长庚·腹部影像", "path": "/path/to/abdomen-export" }
  ]
}
```

| 键 | 说明 |
|---|---|
| `confidence_threshold` | 前端展示阈值，低于该值的阳性发现默认折叠（默认 `0.7`） |
| `use_gpu` | 是否使用 GPU 推理 |
| `viewer_source` | 阅片器来源；`local5000` 表示走主服务内置 DICOMweb |
| `library_roots` | 院内影像库根目录，**零拷贝**挂载（不复制文件，直接读取原路径） |

### 环境变量

敏感配置放在仓库根目录的 `radar.env`（**已被 `.gitignore` 排除，不会入库**），`start_radar.sh` 启动时自动 `source`：

```bash
# radar.env 示例（请自行填写，切勿提交）
RADAR_INTERNAL_TOKEN=<与平台后端约定的内部令牌>

# 报告撰写 LLM（OpenAI 兼容接口）
REPORT_LLM_BASE_URL=http://<llm-host>:<port>/v1
REPORT_LLM_MODEL=<模型名>
REPORT_LLM_API_KEY=<密钥，无鉴权时填 EMPTY>
REPORT_LLM_TIMEOUT=120

# 统一 AI 配置通道（可选，接入平台「AI 配置」页面）
QINHUA_AI_CONFIG_URL=http://127.0.0.1:11002/api/llm/internal/config
QINHUA_AI_CONFIG_TTL=30
```

未配置 `REPORT_LLM_*` 时，`report_agent.py` 使用内置默认值；LLM 调用失败会自动回退到模板文案，**报告生成永不因 LLM 不可用而中断**。

---

## 七、能力范围

### 36 个解剖结构分割

模型输出 36 个腹部/胸部结构的体素级分割掩码（索引 1–36，0 为背景），重采样间距 **1×1×5 mm**。完整索引表见 [ckpt/README.md](ckpt/README.md)。

### 146 项征象评估

覆盖 **18 个器官组**，共 146 项「器官_征象」组合：

| 器官组 | 项数 | 器官组 | 项数 |
|---|---:|---|---:|
| 大肠 | 18 | 肾上腺 | 6 |
| 肝脏 | 18 | 胃 | 6 |
| 肾脏 | 14 | 膀胱 | 6 |
| 胆囊 | 14 | 十二指肠 | 5 |
| 小肠 | 13 | 食管 | 5 |
| 肺 | 10 | 主动脉 | 4 |
| 胰腺 | 10 | 肋骨 | 3 |
| 脾脏 | 8 | 门静脉 | 3 |
| 心脏 | 2 | 骶骨 | 1 |

完整清单（中文 + 英文映射）定义在 `RADAR_inference/inference_demo.py` 的 `test_items` 与 `english_mapping` 中。

### 置信度分级

```
confidence = softmax(image_feat @ text_feat.T / temp)[1]     # temp = 0.038342

confidence >  0.5   → 纳入 diagnoses 列表
confidence >= 0.8   → high   （高风险）
confidence >= 0.6   → medium （中风险）
其余                → low    （低风险）
```

阈值逻辑见 `radar-web/modules/inference_engine.py`；前端展示阈值由 `settings.json` 的 `confidence_threshold` 单独控制。

### ⚠️ 适用边界与已知风险

**适用**：**增强 CT**，且扫描范围覆盖胸腹部大范围。

**会产生系统性高置信度假阳性的情况**（`flask-app/app.py` 中已内置警告提示）：

1. **平扫 CT** —— 模型在 40 万例增强 CT 上训练，平扫输入的强化特征缺失会被误判为病灶。
2. **Z 轴覆盖不足 250 mm** —— 滑窗裁剪后器官不完整，注意力分布异常。
3. **非胸腹部扫描** —— 单纯头颅、四肢、脊柱等不在训练分布内。

对以上输入，模型可能给出**高置信度但完全错误**的阳性发现。请在上传前确认扫描协议与覆盖范围。

### 模型不生成报告文字

RADAR 只输出结构化结果（分割掩码、146 项概率、注意力热图）。报告文字由 `report_agent.py` 调用**外部 LLM** 撰写，两者解耦。

---

## 八、输入输出规格

### 预处理管线

```
DICOM 序列 ──(flask-app/app.py 转换)──► NIfTI
   │
   ├─ 重采样至 1 × 1 × 5 mm
   ├─ transpose 调整轴序
   ├─ HU 裁剪至 [-300, 400]
   ├─ min-max 归一化
   └─ pad 至 (96, 256, 384)
   │
   ▼
滑窗推理：roi_size=(96,256,384), overlap=0.25, sw_batch_size=1
```

### 模型结构

| 部分 | 实现 |
|---|---|
| 视觉主干 | `PlainConvUNetLightD`（`vision_branch.py`） |
| 文本编码 | `XBertEncoder` = `bert-base-chinese`（词表 21128，12 层）+ `text_proj` Linear(768→256) |
| 器官投影 | 36 个器官各持 `vision_projs` Linear 与 `query_tokens(36,256)` |
| 融合 | `MultiheadAttention(256, 4 heads)`，温度 `temp=0.038342` |
| 参数量 | 131.1 M |

### 输出

```json
{
  "segmentation": "36 结构分割掩码 (NIfTI)",
  "diagnoses": [
    { "organ": "肝脏", "finding": "...", "confidence": 0.87, "severity": "high" }
  ],
  "attention_heatmap": "注意力热图（用于报告中病灶红圈定位）",
  "raw_output": {
    "model": "checkpoint_radar_pretrain.pth",
    "processing_time": 42.3,
    "device": "cuda:0"
  }
}
```

---

## 九、主要 HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 完整工作台 |
| GET | `/ai` | 简化版 AI 诊断页 |
| POST | `/api/upload` | 上传 DICOM/NIfTI |
| POST | `/api/batch/upload` | 批量上传 |
| POST | `/api/diagnose/<file_id>` | 触发诊断 |
| GET | `/api/diagnose/<file_id>/progress` | 查询诊断进度 |
| GET | `/api/image/slice/<file_id>/<idx>` | 取原始切片 |
| GET | `/api/overlay/<file_id>/slice/<idx>` | 取分割叠加切片 |
| GET | `/api/overlay/<file_id>/mesh` | 3D 重建网格 |
| GET | `/api/overlay/<file_id>/evidence-z` | 报告证据 Z 轴定位 |
| POST | `/api/report/generate` | 生成 PDF 报告（调用 LLM） |
| GET | `/api/report/llm_status` | LLM 可用性探测 |
| GET/POST | `/api/settings` | 读写 `settings.json` |
| GET | `/api/library/tree` `/api/library/cases` | 院内影像库浏览 |
| POST | `/api/library/import` `/api/library/import_path` | 影像库零拷贝导入 |
| GET | `/api/history` | 诊断历史 |
| GET | `/dicomweb/studies/...` | DICOMweb（供 OHIF 消费） |

完整路由见 `flask-app/app.py`。

---

## 十、目录结构

```
radar/
├── flask-app/                  # Web 服务层
│   ├── app.py                  # Flask 主服务（约 4100 行，全部路由）
│   ├── infer_daemon.py         # 常驻推理守护进程（Unix socket）
│   ├── infer_worker.py         # 一次性子进程推理（降级兜底）
│   ├── library_service.py      # 院内影像库零拷贝挂载
│   ├── report_agent.py         # LLM 报告撰写 Agent
│   ├── settings.json           # 运行时配置
│   ├── fonts/                  # PDF 中文字体（NotoSansSC-Bold.ttf，LFS）
│   ├── static/                 # 前端 js/css
│   └── templates/              # index.html / ai_diagnose.html
├── radar-web/
│   └── modules/
│       ├── inference_engine.py # RADAR 推理引擎（预处理 + 滑窗 + 后处理）
│       ├── pdf_generator.py    # PDF 报告渲染（reportlab）
│       ├── viewer_3d.py        # 3D 重建
│       └── visualization.py    # 热图/掩码叠加
├── RADAR_inference/
│   ├── inference_demo.py       # 官方推理入口；146 项诊断定义在此
│   └── dynamic_network_architectures/  # 模型结构（med.py / vision_branch.py）
├── RADAR_train/                # 训练代码（本服务不使用）
├── ohif-viewer/                # OHIF 阅片器（:3002）
├── ckpt/                       # 模型权重（.pth 不入库，需另行下载）
├── data/                       # 内置演示 DICOM 与测试数据
├── download_scripts/           # 权重与辅助数据下载脚本
├── docs/                       # 论文配图与文档
├── start_radar.sh              # 看门狗启动脚本
├── radar.env                   # 敏感配置（不入库，需自建）
├── SETUP.md                    # 详细安装说明（依赖版本锁定原因）
└── requirements.txt            # 推理核心依赖
```

---

## 十一、故障排查

| 现象 | 排查方向 |
|---|---|
| `:5000` 无响应 | 看门狗是否在跑（`pgrep -f start_radar.sh`）；查 `flask.log` |
| `:3002` 无响应 / OHIF 空白 | 查 `logs/ohif.log`；确认 `OHIF_PORT=3002` 已导出（前端 iframe 写死 3002，缺省会去抢 3000 并 `EADDRINUSE` 崩溃） |
| 诊断报「连接提前关闭」 | `infer_daemon` 已崩溃；查 `logs/infer_daemon.log`，重启守护进程。期间会自动降级到 `infer_worker.py`，功能可用但慢 |
| CUDA OOM | 显卡被其他进程（vLLM/ollama 等）占用；`nvidia-smi` 确认后释放。守护进程每次推理结束会 `empty_cache()` 归还显存 |
| `未找到RADAR权重文件` | `ckpt/checkpoint_radar_pretrain.pth` 缺失，执行第三节下载步骤 |
| `缺少文本嵌入文件` | `git lfs pull` 未执行，`ckpt/infer_text_embedding_radar.pt` 仍是 LFS 指针 |
| PDF 中文显示为方框 | `flask-app/fonts/NotoSansSC-Bold.ttf` 缺失（同样是 LFS 未拉取），且系统无 msyh/simhei/simsun 可回退 |
| 大量高置信度但明显错误的阳性 | 输入是平扫 CT 或 Z 轴覆盖 <250mm，见第七节适用边界 |
| 报告文字是模板而非专业描述 | LLM 不可达；`GET /api/report/llm_status` 探测，检查 `REPORT_LLM_BASE_URL` |

**健康检查**：

```bash
ss -tlnp | grep -E ':5000|:3002'          # 端口监听
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5000/ai   # 期望 200
ls -l /tmp/radar_infer.sock                # 推理 socket 存在
nvidia-smi                                 # GPU 占用
```

---

## 十二、许可与引用

本项目基于 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 发布（**非商业使用 + 相同方式共享**），第三方组件许可见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。

> The RADAR model is currently intended for research purposes only. Further improvements and prospective clinical studies are still required before it can be used directly for clinical deployment.

```bibtex
@article{damo-radar-2026,
    author = {Qi Zhang and Jianpeng Zhang and Weiwei Cao and Zilin Lu and Wanxing Chang and Haonan Ding and Cao Chen and Zhi Li and Xing Xue and Sinuo Wang and Shaoteng Zhang and Yutong Xie and Yong Xia and Qi Wu and Zhongyi Shui and Xi Li and Zhilin Zheng and Yanjie Zhou and Tony C.W. Mok and Yingda Xia and Hongkan Wang and Xianghua Ye and Tao Ma and Jie Peng and Xiaoguang Wang and Jian Ding and Yuming Gao and Huazhen Ye and Yiping Liu and Dongjie Chen and Zhaomin Ni and Jianwen Ning and Wei Zhang and Jian Liu and Chaohui Yu and Shenghong Ju and Jianfeng Zhang and Wenbo Xiao and Ling Zhang and Tingbo Liang},
    title = {An expert-level generalist AI for abdominal CT diagnosis},
    journal = {Science},
    volume = {393},
    number = {6817},
    pages = {eaec6129},
    year = {2026},
    doi = {10.1126/science.aec6129},
    URL = {https://www.science.org/doi/abs/10.1126/science.aec6129}
}
```
