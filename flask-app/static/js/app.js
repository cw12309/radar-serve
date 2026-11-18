// RADAR医学影像诊断平台 - 前端交互逻辑

// OHIF 查看器端口。默认 3002，需与后端 app.py 的 OHIF_PORT 及
// start_radar_system.ps1 的 $OhifPort 保持一致
// （3000=grafana、3001=bzh-server 均被本机 Docker 容器占用）。
const OHIF_PORT = 3002;

// lab-fit: 教学实验台以 iframe 嵌入本页；嵌入模式走紧凑布局
// （styles.css 的 html.in-iframe 规则），避免看片窗被 iframe 视口压缩
if (window.self !== window.top) {
    document.documentElement.classList.add('in-iframe');
}

// 全局状态
const AppState = {
    currentFileId: null,
    currentFileInfo: null,
    currentDiagnosis: null,
    // 诊断落库后的历史记录 id：生成报告时回传后端，后端据此读回院内溯源
    // 快照（患者信息/主诉病史/原始报告），报告才能带上真实临床背景
    currentHistoryCaseId: null,
    // 后端按全局阈值过滤前的完整诊断集合：前端调「置信度阈值」时本地
    // 重过滤，无需重新诊断
    allDiagnoses: [],
    currentTool: 'pan',
    imageData: null,
    viewerState: {
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        windowCenter: 40,
        windowWidth: 400,
        sliceIndex: 50
    }
};

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    initUpload();
    initViewer();
    initDiagnose();
    if (typeof initLibrary === 'function') initLibrary();
    initHistoryDetailDrawer();
    initSettings();
    loadSettings();
    loadHistory();
    initExternalHandoff();
});

// ============ 外部平台跳转接入（清华规培平台「腹部诊断」） ============
//
// 清华平台先把序列目录注册到本机（/api/library/import_path，零拷贝），再新开
// 标签页打开 /ai?file_id=<id>&auto=1。注册发生在另一个浏览器会话里，Flask 的
// cookie session 不互通，所以这里凭 file_id 调 /api/session/load 恢复「当前
// 影像」，复用上传成功后的同一套渲染链路；auto=1 时紧接着自动触发诊断，
// 实现「选序列 → 自动导入 → 直接出诊断结果」的免手工流程。
// 仅在简化版 /ai 页生效：该页没有影像库抽屉，参数不会与库内浏览交互冲突。

// ---- 诊断结果本地缓存（24h TTL） ----
// 避免每次刷新 / 重新打开同一 file_id 都要重新跑模型推理。
const DIAG_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
function saveDiagnosisCache(fileId, result, caseId) {
    try {
        localStorage.setItem('radar:diag:' + fileId, JSON.stringify({
            ts: Date.now(), result: result, case_id: caseId || null,
        }));
    } catch (_) { /* quota 超了静默失败 */ }
}
function loadDiagnosisCache(fileId) {
    try {
        const raw = localStorage.getItem('radar:diag:' + fileId);
        if (!raw) return null;
        const c = JSON.parse(raw);
        if (Date.now() - (c.ts || 0) > DIAG_CACHE_TTL_MS) {
            localStorage.removeItem('radar:diag:' + fileId);
            return null;
        }
        return c;
    } catch (_) { return null; }
}
function clearDiagnosisCache(fileId) {
    if (fileId) localStorage.removeItem('radar:diag:' + fileId);
}
function initExternalHandoff() {
    if (!document.getElementById('diagnosis-page')) return;
    const params = new URLSearchParams(window.location.search);
    const fileId = (params.get('file_id') || '').trim();
    if (!fileId) return;
    const auto = params.get('auto') === '1';

    loadExternalSession(fileId, auto);
}

// records-fix: 从服务器历史记录恢复诊断结果（跨浏览器/跨机器复现入口）。
// 记录页「打开诊断」只带 file_id，localStorage 24h 缓存常未命中；
// 不回退到服务器历史的话，看片窗只有影像、诊断区一片空白。
async function fetchHistoryDiagnosis(fileId) {
    try {
        const r = await fetch('/api/history?limit=500');
        const j = await r.json();
        const rec = ((j && j.records) || []).find((x) => x.file_id === fileId);
        if (!rec) return null;
        const d = await fetch('/api/history/' + encodeURIComponent(rec.id));
        const dj = await d.json();
        if (!dj.success || !dj.record || !dj.record.diagnosis) return null;
        return { result: dj.record.diagnosis, case_id: dj.record.id };
    } catch (e) { return null; }
}

async function loadExternalSession(fileId, auto) {
    showLoading('正在从清华平台导入影像...');
    try {
        const response = await fetch('/api/session/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_id: fileId }),
        });
        const data = await response.json();
        if (!data.success) {
            showToast(data.message || '导入影像失败', 'error');
            return;
        }

        AppState.currentFileId = data.file_id;
        AppState.currentFileInfo = data.info;
        displayFileInfo(data.info);
        showViewerSection();
        openOhifViewer(data.info.ohif_study_uid);
        setWorkflowStep('workflowViewerStep');
        showToast(data.message || '影像已导入', 'success');

        // 如果这个 file_id 已经有缓存的诊断结果，直接恢复——
        // 不用重新跑模型推理（省 30-90s），overlay 切片由后端按需渲染
        const cached = loadDiagnosisCache(fileId);
        if (cached && cached.result) {
            AppState.currentDiagnosis = cached.result;
            AppState.currentHistoryCaseId = cached.case_id || null;
            AppState.allDiagnoses = cached.result.all_diagnoses
                || cached.result.diagnoses || [];
            displayDiagnosisResult(cached.result);
            showOverlayCardPending(cached.result);
            initOverlayViewer(cached.result);
            syncThresholdUi();
            setWorkflowStep('workflowDiagnosisStep');
            setWorkflowStep('workflowReportStep');
            setReportBtnEnabled(true);
            // overlay 渲染需要知道 file_id，AppState.currentFileId 已设
            showToast('已恢复上次诊断结果', 'success');
            document.getElementById('diagProgress').hidden = true;
            return;
        }

        // records-fix: 本地缓存未命中时回退服务器历史记录恢复诊断结果，
        // 保证记录页「打开诊断」在任意浏览器都能复现当次诊断数据
        const hist = await fetchHistoryDiagnosis(fileId);
        if (hist && hist.result) {
            AppState.currentDiagnosis = hist.result;
            AppState.currentHistoryCaseId = hist.case_id || null;
            AppState.allDiagnoses = hist.result.all_diagnoses
                || hist.result.diagnoses || [];
            displayDiagnosisResult(hist.result);
            showOverlayCardPending(hist.result);
            initOverlayViewer(hist.result);
            syncThresholdUi();
            setWorkflowStep('workflowDiagnosisStep');
            setWorkflowStep('workflowReportStep');
            setReportBtnEnabled(true);
            showToast('已从历史记录恢复诊断结果', 'success');
            document.getElementById('diagProgress').hidden = true;
            return;
        }

        // auto=1 不再直接开诊：先弹序列确认框（推荐级别 + 基本信息），
        // 由医生确认后再开始诊断，避免把定位像/错误序列直接喂进模型
        if (auto) openSeriesConfirmModal();
    } catch (error) {
        console.error('[handoff] 导入影像失败:', error);
        showToast('导入影像失败: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

// ============ 序列确认框 ============
// 上传/导入完成后居中弹出：顶部是 RADAR 适用性结论（推荐/不推荐），
// 中部是序列基本信息（DICOM 头 + 体数据几何），底部确认后才开始诊断。
// 评估失败不阻塞流程：按「可评估性未知」展示，仍允许确认。
async function openSeriesConfirmModal() {
    const info = AppState.currentFileInfo || {};
    const meta = info.metadata || {};
    const seriesDir = info.series_dir || null;

    let assessment = null;
    try {
        const resp = await fetch('/api/assess/series', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                series: [{
                    series_id: AppState.currentFileId,
                    series_description: meta.series_description || info.filename,
                    modality: meta.modality || info.file_type,
                    image_count: info.slice_count,
                    slice_thickness: info.spacing ? info.spacing.slice : null,
                    series_dir: seriesDir,
                }],
            }),
        });
        const data = await resp.json();
        assessment = (data.results && data.results[0] && data.results[0].assessment) || null;
    } catch (err) {
        console.warn('[confirm] 序列适用性评估失败:', err);
    }

    renderSeriesConfirmModal(info, meta, assessment);
}

function renderSeriesConfirmModal(info, meta, assessment) {
    let modal = document.getElementById('seriesConfirmModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'seriesConfirmModal';
        modal.className = 'series-confirm';
        document.body.appendChild(modal);
    }

    const verdict = assessment ? assessment.verdict : null;
    const score = assessment ? assessment.score : null;
    let badgeClass = 'sc-badge--unknown';
    let badgeText = '适用性未知';
    if (verdict === 'recommended') { badgeClass = 'sc-badge--ok'; badgeText = '★ 推荐用于 AI 诊断'; }
    else if (verdict === 'usable') { badgeClass = 'sc-badge--warn'; badgeText = '可用（非最优序列）'; }
    else if (verdict === 'unsuitable') { badgeClass = 'sc-badge--bad'; badgeText = '不推荐用于 AI 诊断'; }

    const reasons = (assessment && assessment.reasons && assessment.reasons.length)
        ? assessment.reasons.join('；') : '';

    const spacing = info.spacing;
    const rows = [
        ['序列描述', meta.series_description || info.filename || '-'],
        ['序列编号', meta.series_number || '-'],
        ['检查类型', meta.modality || (info.file_type || '').toUpperCase() || '-'],
        ['检查部位', meta.body_part || '-'],
        ['切片数', `${info.slice_count ?? '-'} 张`],
        ['体数据尺寸', Array.isArray(info.shape) ? info.shape.join(' × ') : '-'],
        ['层厚', meta.slice_thickness || (spacing ? `${spacing.slice.toFixed(2)} mm` : '未提供')],
        ['像素间距', spacing ? `${spacing.row.toFixed(3)} × ${spacing.column.toFixed(3)} mm` : '未提供'],
        ['数据大小', `${info.size_mb ?? '-'} MB`],
        ['检查日期', meta.study_date || '-'],
        ['设备厂商', meta.manufacturer || '-'],
    ];

    modal.innerHTML = `
        <div class="series-confirm-mask"></div>
        <div class="series-confirm-card" role="dialog" aria-modal="true" aria-label="序列确认">
            <div class="sc-badge ${badgeClass}">${escapeHtml(badgeText)}${score != null && score >= 0 ? `　评分 ${score}` : ''}</div>
            <h3 class="sc-title">序列确认</h3>
            <p class="sc-sub">请核对以下序列信息，确认无误后开始 AI 诊断。</p>
            ${reasons ? `<div class="sc-reasons">${escapeHtml(reasons)}</div>` : ''}
            <div class="sc-grid">
                ${rows.map(([k, v]) => `<div class="sc-row"><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b></div>`).join('')}
            </div>
            <div class="sc-actions">
                <button class="btn btn-secondary" id="scCancelBtn">取消</button>
                <button class="btn btn-primary" id="scConfirmBtn">确认并开始诊断</button>
            </div>
        </div>`;
    modal.style.display = 'flex';

    modal.querySelector('#scCancelBtn').addEventListener('click', () => {
        modal.style.display = 'none';
        showToast('已取消诊断，可重新上传影像或从病例工作台再次导入', 'info');
    });
    modal.querySelector('#scConfirmBtn').addEventListener('click', () => {
        modal.style.display = 'none';
        performDiagnosis();
    });
}

// 历史详情抽屉的关闭交互（遮罩/✕/Esc）。与影像库抽屉各自独立，
// 因为两个抽屉可能在同一页面栈上，关闭判断只认自己那个。
function initHistoryDetailDrawer() {
    const drawer = document.getElementById('historyDrawer');
    if (!drawer) return;
    drawer.addEventListener('click', (e) => {
        if (e.target.closest('[data-hist-close]')) closeHistoryDetail();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !drawer.hidden) closeHistoryDetail();
    });
}

// ============ 导航功能 ============
function initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    const pages = document.querySelectorAll('.page');
    
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const targetPage = item.dataset.page;
            
            // 更新导航状态
            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');
            
            // 切换页面
            pages.forEach(page => page.classList.remove('active'));
            document.getElementById(`${targetPage}-page`).classList.add('active');
            
            // 加载页面数据
            if (targetPage === 'history') {
                loadHistory();
            } else if (targetPage === 'library') {
                // 首次进入才拉索引；后续切回直接用内存里的树与列表，避免重复扫盘
                if (!LibStateLoaded) { LibStateLoaded = true; refreshLibrary(false); }
            }
        });
    });
}

// ============ 文件上传 ============

// 文件夹里必然混有非影像文件，先在前端粗筛掉，避免把上千个无用条目塞进
// FormData 上传（后端仍会用文件头嗅探 + SeriesInstanceUID 分组做最终判定）。
// 注意不能按扩展名白名单筛：PACS 导出的 DICOM 常常没有扩展名（IM0001、纯 UID）。
const NOISE_FILE_RE = /\.(xml|txt|csv|json|pdf|html?|rtf|docx?|xlsx?|pptx?|md|ini|dll|exe|lnk|bmp|mp4|avi|mov)$/i;
const NOISE_NAME_RE = /^(dicomdir|thumbs\.db|desktop\.ini|\.ds_store|readme)/i;

function isPlausibleSliceFile(file) {
    const name = file.name || '';
    if (!name || name.startsWith('._')) return false;
    if (NOISE_NAME_RE.test(name)) return false;
    if (NOISE_FILE_RE.test(name)) return false;
    return true;
}

// 递归展开拖入的文件夹。dataTransfer.files 只含顶层文件，拖文件夹时为空，
// 必须走 items -> webkitGetAsEntry 才能拿到目录树。
async function collectFilesFromDataTransfer(dataTransfer) {
    const items = dataTransfer.items;
    if (!items || !items.length || typeof items[0].webkitGetAsEntry !== 'function') {
        return Array.from(dataTransfer.files || []);
    }

    const entries = [];
    for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry();
        if (entry) entries.push(entry);
    }
    if (!entries.length) return Array.from(dataTransfer.files || []);

    const out = [];
    const walk = (entry) => new Promise((resolve) => {
        if (entry.isFile) {
            entry.file(
                (f) => { out.push(f); resolve(); },
                () => resolve()
            );
            return;
        }
        if (!entry.isDirectory) { resolve(); return; }
        const reader = entry.createReader();
        const readBatch = () => {
            reader.readEntries(
                async (children) => {
                    if (!children.length) { resolve(); return; }
                    for (const child of children) await walk(child);
                    // readEntries 单次最多返回 100 条，必须反复读到空为止，
                    // 否则大文件夹会静默漏掉后面的切片
                    readBatch();
                },
                () => resolve()
            );
        };
        readBatch();
    });

    for (const entry of entries) await walk(entry);
    return out;
}

function initUpload() {
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const folderInput = document.getElementById('folderInput');

    // —— 折叠 toggle ——
    const toggleBtn = document.getElementById('uploadToggleBtn');
    const toggleLabel = document.getElementById('uploadToggleLabel');
    const ficReplace = document.getElementById('ficReplace');

    function setUploadAreaOpen(open) {
        if (open) {
            uploadArea.classList.add('is-open');
            toggleBtn.classList.add('is-open');
            toggleLabel.textContent = '收起上传';
        } else {
            uploadArea.classList.remove('is-open');
            toggleBtn.classList.remove('is-open');
            const hasFile = AppState && AppState.currentFileId;
            toggleLabel.textContent = hasFile ? '重新上传（更换当前文件）' : '点击上传影像';
        }
    }

    toggleBtn.addEventListener('click', () => {
        setUploadAreaOpen(!uploadArea.classList.contains('is-open'));
    });

    // upload-default-open: 页面加载后上传区默认展开，可手动收起
    // lab-fit: 嵌入模式（教学实验台 iframe）默认折叠，把空间让给看片窗；
    // 需要上传时点 toggle 展开即可
    setUploadAreaOpen(window.self === window.top);

    // "更换"按钮：重新展开上传区
    if (ficReplace) {
        ficReplace.addEventListener('click', () => {
            setUploadAreaOpen(true);
        });
    }

    // 拖拽上传（支持直接拖文件夹）—— 拖入时自动展开
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', () => {
        uploadArea.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', async (e) => {
        e.preventDefault();
        uploadArea.classList.remove('dragover');

        const files = await collectFilesFromDataTransfer(e.dataTransfer);
        if (!files.length) {
            showToast('未能读取拖入的内容', 'error');
            return;
        }
        handleFileUpload(files);
    });

    // 拖到整个 toggle bar 时也展开
    const toggleBar = document.getElementById('uploadToggleBar');
    if (toggleBar) {
        toggleBar.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (!uploadArea.classList.contains('is-open')) setUploadAreaOpen(true);
        });
        toggleBar.addEventListener('drop', (e) => {
            e.preventDefault();
        });
    }

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFileUpload(e.target.files);
        }
        // 清空以便同一批文件可重复选择（否则第二次 change 不触发）
        e.target.value = '';
    });

    if (folderInput) {
        folderInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleFileUpload(e.target.files);
            }
            e.target.value = '';
        });
    }
}

async function handleFileUpload(fileList) {
    let files = Array.from(fileList);

    // 压缩包整包上传，不参与切片筛选（.zip/.tar.gz 本身就是要交给后端解的）
    const hasArchive = files.some(f => /\.(zip|tar|tgz|tbz2|tar\.gz|tar\.bz2)$/i.test(f.name || ''));
    if (!hasArchive && files.length > 1) {
        const before = files.length;
        files = files.filter(isPlausibleSliceFile);
        const dropped = before - files.length;
        if (!files.length) {
            showToast('所选文件里没有可识别的影像切片', 'error');
            return;
        }
        if (dropped > 0) {
            console.info(`[upload] 前端已忽略 ${dropped} 个非影像文件`);
        }
    }

    const label = files.length > 1 ? `正在上传${files.length}个文件...` : '正在上传文件...';
    showLoading(label);

    // 预检：Chrome 受 Windows MAX_PATH(260 字符) 限制，路径过长的文件能出现在
    // 选择列表里，但上传时读不出内容，请求会被中止并报误导性的
    // "Failed to fetch"（net::ERR_ALPN_NEGOTIATION_FAILED）。这里读首文件的前
    // 1MB 提前暴露问题（坏路径在 open 阶段即抛错），不必整文件读一遍——
    // 单个 200MB 体数据整读会白白多花数秒并占住等量内存。
    if (!hasArchive && files.length) {
        try {
            await files[0].slice(0, 1024 * 1024).arrayBuffer();
        } catch (err) {
            hideLoading();
            console.error('[upload] 文件内容读取失败:', files[0].name, err);
            showToast('无法读取文件内容：多半是文件路径超过 Windows 260 字符限制。' +
                '请把 DICOM 文件夹复制到较短路径（如 D:\\dcm\\）后重新选择上传', 'error');
            return;
        }
    }

    const formData = new FormData();
    files.forEach(file => formData.append('files', file));

    try {
        const data = await uploadWithProgress(formData, files);

        if (data.success) {
            AppState.currentFileId = data.file_id;
            AppState.currentFileInfo = data.info;

            displayFileInfo(data.info);
            showViewerSection();
            openOhifViewer(data.info.ohif_study_uid);
            setWorkflowStep('workflowViewerStep');
            const studyNameEl = document.getElementById('viewerStudyName');
            if (studyNameEl) {
                studyNameEl.textContent = `${data.info.filename} · ${data.info.shape.join(' × ')}`;
            }

            showToast(data.message || '上传成功，已打开专业影像查看器', 'success');
            openSeriesConfirmModal();
        } else {
            showToast(data.message || '上传失败', 'error');
        }
    } catch (error) {
        console.error('Upload error:', error);
        showToast('上传失败: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

// 用 XHR 代替 fetch 上传：fetch 观察不到请求体的发送进度，几百张切片的序列
// 上传时界面只会停在「正在上传...」不动，看起来像通道卡死。XHR 的
// upload.onprogress 能实时回传百分比与已传/总大小；传输完成后再切到
// 「服务端解析中」文案，把网络传输与服务端 dcmread/OHIF 导出两段耗时分开呈现。
function uploadWithProgress(formData, files) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
        xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable || !e.total) return;
            const pct = Math.min(99, Math.floor((e.loaded / e.total) * 100));
            showLoading(`正在上传 ${pct}%（${(e.loaded / 1048576).toFixed(1)} / ${(e.total / 1048576).toFixed(1)} MB）`);
        };
        xhr.upload.onload = () => showLoading('传输完成，服务端正在解析序列与生成查看器数据...');
        xhr.onload = () => {
            try {
                resolve(JSON.parse(xhr.responseText));
            } catch (err) {
                reject(new Error('服务端返回无法解析'));
            }
        };
        xhr.onerror = () => reject(new Error('网络中断或服务不可达'));
        xhr.onabort = () => reject(new Error('上传已取消'));
        xhr.send(formData);
    });
}

function setWorkflowStep(stepId) {
    const step = document.getElementById(stepId);
    if (step) step.classList.add('active', 'done');
}

function openOhifViewer(studyUid, seriesUid) {
    if (!studyUid) {
        showToast('未生成OHIF研究数据', 'error');
        return;
    }
    // OHIF 主视口（Cornerstone3D）必须创建 WebGL2 上下文；无显卡/远程桌面等
    // 环境里新版 Chrome 默认禁用软件 WebGL 回退，WebGL2 拿不到，视口会永远停在
    // Loading（缩略图走 2D canvas 不受影响，容易误判成"数据没加载"）。
    // 打开查看器前先探测一次，不可用就直接给出原因和修复办法，别让用户干等。
    const warn = document.getElementById('webglWarn');
    if (warn) {
        let webgl2 = false;
        try {
            webgl2 = !!document.createElement('canvas').getContext('webgl2');
        } catch (e) { /* 探测失败按不可用处理 */ }
        warn.hidden = webgl2;
    }
    // 用 location.hostname 而不是写死 127.0.0.1：用户从远程（如 10.101.1.178:5000）
    // 打开本页时，iframe 指向 127.0.0.1 会打到用户自己机器上，根本连不上 OHIF。
    // OHIF 的 /dicomweb 是相对路径代理回 Flask，所以同源 hostname 才是对的。
    // initialseriesinstanceuid 是 OHIF 官方首屏定位参数（defaultRouteInit 读取）：
    // 不传时主视口默认挂第一个 display set（常是 Scout 定位像/剂量报告），
    // 用户选的诊断序列要等手动点缩略图才上屏，看起来像"一开始显示不出来"。
    const seriesParam = seriesUid
        ? `&initialseriesinstanceuid=${encodeURIComponent(seriesUid)}` : '';
    const viewerUrl = `http://${window.location.hostname}:${OHIF_PORT}/viewer/local5000?StudyInstanceUIDs=${encodeURIComponent(studyUid)}${seriesParam}`;
    // 简化版 /ai 页没有 OHIF 卡片：无 iframe 时跳过嵌入，仅保留 URL 构造
    const frame = document.getElementById('ohifViewerFrame');
    if (frame) frame.src = viewerUrl;
    const newTab = document.getElementById('openOhifNewTab');
    if (newTab) newTab.href = viewerUrl;
    if (!frame) return;

    // 把浏览器渲染环境快照上报到服务日志：视口卡 Loading 只发生在用户浏览器里，
    // 服务端接口全 200 也看不出问题。有了这份快照，出问题时查 flask.log 的
    // [client-diag] 即可定位（WebGL2 是否可用、浏览器版本等），不用用户翻控制台。
    let dWebgl2 = false, dWebgl1 = false;
    try {
        dWebgl2 = !!document.createElement('canvas').getContext('webgl2');
        dWebgl1 = !!document.createElement('canvas').getContext('webgl');
    } catch (e) { /* 探测失败按不可用上报 */ }
    fetch('/api/client_diag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            webgl2: dWebgl2,
            webgl1: dWebgl1,
            user_agent: navigator.userAgent,
            study_uid: studyUid,
            cross_origin_isolated: window.crossOriginIsolated === true,
            shared_array_buffer: typeof SharedArrayBuffer !== 'undefined',
        }),
    }).catch(() => { /* 诊断上报失败不影响主流程 */ });
}

function displayFileInfo(info) {
    const compact = document.getElementById('fileInfoCompact');
    if (compact) compact.style.display = 'inline-flex';

    const nameEl = document.getElementById('fileName');
    if (nameEl) nameEl.textContent = info.filename || '未知文件';

    const typeEl = document.getElementById('fileType');
    if (typeEl) typeEl.textContent = info.file_type ? info.file_type.toUpperCase() : '';

    const sizeEl = document.getElementById('fileSize');
    if (sizeEl) sizeEl.textContent = (info.size_mb || 0) + ' MB';

    const shapeEl = document.getElementById('fileShape');
    if (shapeEl) {
        shapeEl.textContent = info.shape ? info.shape.join(' × ') : '';
    }

    const slicesEl = document.getElementById('fileSlices');
    if (slicesEl) {
        const n = info.slice_count;
        slicesEl.textContent = n ? `${n} 张` : '';
    }

    const spacingEl = document.getElementById('fileSpacing');
    if (spacingEl) {
        const spacing = info.spacing;
        spacingEl.textContent = spacing
            ? `体素 ${spacing.row.toFixed(2)}×${spacing.column.toFixed(2)}×${spacing.slice.toFixed(2)}mm`
            : '';
    }

    // 上传成功后自动折叠上传区
    const uploadArea = document.getElementById('uploadArea');
    if (uploadArea && uploadArea.classList.contains('is-open')) {
        uploadArea.classList.remove('is-open');
        const toggleBtn = document.getElementById('uploadToggleBtn');
        const toggleLabel = document.getElementById('uploadToggleLabel');
        if (toggleBtn) toggleBtn.classList.remove('is-open');
        if (toggleLabel) toggleLabel.textContent = '重新上传（更换当前文件）';
    }

    // 患者与检查信息（DICOM / NIfTI 头）—— 旧 card 已移除，保留调用以防 renderMetaCard 空安全
    renderMetaCard(info.metadata, {
        card: 'fileMeta',
        grid: 'fileMetaGrid',
        source: 'fileMetaSource',
        title: 'fileMetaTitle',
    });
}

// 元数据中不参与逐字段展示的控制键
const META_CONTROL_KEYS = new Set(['label_map', 'source', 'num_instances']);

// 将后端提取的元数据渲染到指定卡片。DICOM 来源标注实例数，NIfTI 标注格式。
function renderMetaCard(metadata, ids) {
    const card = document.getElementById(ids.card);
    const grid = document.getElementById(ids.grid);
    if (!card || !grid) return;

    const fields = metadata
        ? Object.keys(metadata).filter(k => !META_CONTROL_KEYS.has(k) && metadata[k])
        : [];
    if (!fields.length) {
        card.style.display = 'none';
        grid.innerHTML = '';
        return;
    }

    card.style.display = '';
    const labelMap = metadata.label_map || {};
    // 按后端 label_map 的顺序（即 _DICOM_META_FIELDS 顺序）展示，未知键排在后面
    const order = Object.keys(labelMap);
    fields.sort((a, b) => {
        const ia = order.indexOf(a), ib = order.indexOf(b);
        return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
    });

    grid.innerHTML = '';
    fields.forEach(key => {
        const item = el('div', 'info-item');
        item.appendChild(el('span', 'info-label', labelMap[key] || key));
        item.appendChild(el('span', 'info-value', String(metadata[key])));
        grid.appendChild(item);
    });

    if (ids.source) {
        const srcEl = document.getElementById(ids.source);
        const src = metadata.source === 'dicom'
            ? `DICOM${metadata.num_instances ? ` · ${metadata.num_instances} 实例` : ''}`
            : (metadata.source === 'nifti' ? 'NIfTI 头' : '元数据');
        srcEl.textContent = src;
    }
    if (ids.title) {
        document.getElementById(ids.title).textContent =
            metadata.source === 'dicom' ? '患者与检查信息' : '影像信息';
    }
}

function showViewerSection() {
    /* lab-fit: 嵌入模式（教学实验台 iframe）下上传区默认展开占 ~445px，
       把看片窗挤出 iframe 可视区；看片区一旦显示就自动折叠上传区，
       用户仍可点 toggle 重新展开 */
    if (window.self !== window.top) {
        const ua = document.getElementById('uploadArea');
        if (ua && ua.classList.contains('is-open')) {
            ua.classList.remove('is-open');
            const tb = document.getElementById('uploadToggleBtn');
            const tl = document.getElementById('uploadToggleLabel');
            if (tb) tb.classList.remove('is-open');
            if (tl) tl.textContent = '重新上传（更换当前文件）';
        }
    }
    // 简化版 /ai 页无 OHIF 查看器卡片：逐个守卫，缺哪个跳过哪个
    const viewer = document.getElementById('viewerSection');
    if (viewer) viewer.style.display = 'block';
    const diagnose = document.getElementById('diagnoseSection');
    if (diagnose) diagnose.style.display = 'block';
    // 换了影像就等于换了诊断对象：旧结果作废，报告按钮重新置灰，
    // 等本次诊断成功后再启用（performDiagnosis 里开）
    setReportBtnEnabled(false);
}

// 报告按钮可用性：诊断完成前禁用置灰，避免拿旧结果/空结果去生成报告。
// 按钮位于「影像学发现」头部，与采纳计数合并显示（见 syncReportBtnLabel）
function setReportBtnEnabled(on) {
    const btn = document.getElementById('overlayReportBtn');
    if (btn) btn.disabled = !on;
}

// 「生成报告：n/m」（n=已采纳，m=当前列出）：计数与报告入口合并在发现
// 头部按钮上，采纳/拒绝/阈值变化后调用以同步计数。
// 只更新 label span，按钮内的服务状态圆点（reportModeDot）保持不变
function syncReportBtnLabel() {
    const label = document.getElementById('reportBtnLabel');
    if (!label) return;
    const ds = (AppState.currentDiagnosis || {}).diagnoses || [];
    label.textContent = ds.length
        ? `生成报告：${acceptedDiagnoses().length}/${ds.length}`
        : '生成报告';
}

// 报告按钮圆点：绿=大模型服务正常（报告由大模型撰写），红=不可用（模板生成）。
// 页面加载时检测一次，生成报告后按实际结果再同步一次
async function refreshReportModeDot() {
    const dot = document.getElementById('reportModeDot');
    const btn = document.getElementById('overlayReportBtn');
    if (!dot) return;
    try {
        const resp = await fetch('/api/report/llm_status');
        const data = await resp.json();
        const on = !!data.available;
        dot.className = 'ovf-report-dot ' + (on ? 'on' : 'off');
        if (btn) {
            btn.title = on
                ? '大模型服务正常：报告由大模型专业撰写'
                : '大模型服务不可用：报告按模板生成';
        }
    } catch (e) {
        dot.className = 'ovf-report-dot off';
    }
}

// ============ 影像查看器 ============
function initViewer() {
    // 主流程使用OHIF Viewer，旧Canvas逻辑不再初始化。
    return;
}
function initCanvasInteraction() {
    const canvas = document.getElementById('imageCanvas');
    let isDragging = false;
    let startX, startY;
    
    canvas.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX - AppState.viewerState.offsetX;
        startY = e.clientY - AppState.viewerState.offsetY;
    });
    
    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = Math.floor(e.clientX - rect.left);
        const y = Math.floor(e.clientY - rect.top);
        
        document.getElementById('mousePos').textContent = `(${x}, ${y})`;
        
        if (isDragging && AppState.currentTool === 'pan') {
            AppState.viewerState.offsetX = e.clientX - startX;
            AppState.viewerState.offsetY = e.clientY - startY;
            drawImage();
        }
    });
    
    canvas.addEventListener('mouseup', () => {
        isDragging = false;
    });
    
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (AppState.currentTool === 'zoom') {
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            AppState.viewerState.scale = Math.max(0.1, Math.min(10, AppState.viewerState.scale * delta));
            drawImage();
        }
    });
}

async function loadImageSlice(sliceIdx) {
    if (!AppState.currentFileId) return;
    
    const viewMode = document.getElementById('viewMode').value;
    const windowCenter = AppState.viewerState.windowCenter;
    const windowWidth = AppState.viewerState.windowWidth;
    
    try {
        const response = await fetch(
            `/api/image/slice/${AppState.currentFileId}/${sliceIdx}?view=${viewMode}&window_center=${windowCenter}&window_width=${windowWidth}`
        );
        
        const data = await response.json();
        
        if (data.success) {
            const img = new Image();
            img.onload = () => {
                AppState.imageData = img;
                drawImage();
                
                // 更新信息
                const shape = AppState.currentFileInfo.shape;
                const maxSlice = viewMode === 'axial' ? shape[0] : 
                               viewMode === 'sagittal' ? shape[2] : shape[1];
                document.getElementById('sliceInfo').textContent = `${sliceIdx + 1} / ${maxSlice}`;
                document.getElementById('viewInfo').textContent = viewMode.toUpperCase();
                document.getElementById('sliceSlider').max = maxSlice - 1;
            };
            img.src = 'data:image/png;base64,' + data.image;
        }
    } catch (error) {
        console.error('Load slice error:', error);
    }
}

function drawImage() {
    if (!AppState.imageData) return;
    
    const canvas = document.getElementById('imageCanvas');
    const ctx = canvas.getContext('2d');
    
    canvas.width = AppState.imageData.width;
    canvas.height = AppState.imageData.height;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    
    ctx.translate(canvas.width / 2 + AppState.viewerState.offsetX, 
                  canvas.height / 2 + AppState.viewerState.offsetY);
    ctx.scale(AppState.viewerState.scale, AppState.viewerState.scale);
    ctx.translate(-canvas.width / 2, -canvas.height / 2);
    
    ctx.drawImage(AppState.imageData, 0, 0);
    ctx.restore();
}

function updateImage() {
    loadImageSlice(AppState.viewerState.sliceIndex);
}

function resetViewer() {
    AppState.viewerState.scale = 1;
    AppState.viewerState.offsetX = 0;
    AppState.viewerState.offsetY = 0;
    drawImage();
}

function updateCursor(tool) {
    const canvas = document.getElementById('imageCanvas');
    const cursors = {
        'pan': 'move',
        'zoom': 'zoom-in',
        'window': 'crosshair'
    };
    canvas.style.cursor = cursors[tool] || 'default';
}

async function loadMultiviewImages() {
    if (!AppState.currentFileId) return;
    
    showLoading('加载三视图...');
    
    try {
        const response = await fetch(`/api/image/multiview/${AppState.currentFileId}`);
        const data = await response.json();
        
        if (data.success) {
            document.getElementById('axialImage').src = 'data:image/png;base64,' + data.views.axial.image;
            document.getElementById('sagittalImage').src = 'data:image/png;base64,' + data.views.sagittal.image;
            document.getElementById('coronalImage').src = 'data:image/png;base64,' + data.views.coronal.image;
        }
    } catch (error) {
        console.error('Load multiview error:', error);
        showToast('加载三视图失败', 'error');
    } finally {
        hideLoading();
    }
}

function initSettings() {
    const threshold = document.getElementById('confidenceSetting');
    // 简化版 /ai 页无设置控件：跳过（设置仍可在主页修改，接口共用）
    if (!threshold) return;
    threshold.addEventListener('input', () => {
        document.getElementById('confidenceSettingValue').textContent = `${threshold.value}%`;
    });
    document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
}

async function loadSettings() {
    const response = await fetch('/api/settings');
    const data = await response.json();
    if (!data.success) return;
    // 主题对任何页面都生效；控件回填仅在设置控件存在时执行（/ai 页没有）
    applyTheme(data.settings.theme);
    const themeEl = document.getElementById('themeSetting');
    if (!themeEl) return;
    themeEl.value = data.settings.theme;
    document.getElementById('languageSetting').value = data.settings.language;
    document.getElementById('confidenceSetting').value = Math.round(data.settings.confidence_threshold * 100);
    document.getElementById('confidenceSettingValue').textContent = `${Math.round(data.settings.confidence_threshold * 100)}%`;
    document.getElementById('gpuSetting').checked = data.settings.use_gpu;
}

async function saveSettings() {
    const payload = {
        theme: document.getElementById('themeSetting').value,
        language: document.getElementById('languageSetting').value,
        confidence_threshold: Number(document.getElementById('confidenceSetting').value) / 100,
        use_gpu: document.getElementById('gpuSetting').checked
    };
    const response = await fetch('/api/settings', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (data.success) {
        applyTheme(data.settings.theme);
        showToast('设置已保存并生效', 'success');
    } else {
        showToast(data.message || '设置保存失败', 'error');
    }
}

function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
}


function initDiagnose() {
    // 手动「开始AI诊断」按钮已移除（诊断由序列确认框触发），元素可能不存在
    const diagnoseBtn = document.getElementById('diagnoseBtn');
    // 报告按钮在「影像学发现」头部（与采纳计数合并），缺失时不影响诊断流程
    const generateReportBtn = document.getElementById('overlayReportBtn');

    if (diagnoseBtn) diagnoseBtn.addEventListener('click', performDiagnosis);
    if (generateReportBtn) generateReportBtn.addEventListener('click', generateReport);
    initThresholdCtl();
    refreshReportModeDot();

    // 发现列表 / 证据列表 的展开-收起
    const findingsBtn = document.getElementById('toggleFindingsBtn');
    if (findingsBtn) {
        findingsBtn.addEventListener('click', () => {
            const grid = document.getElementById('findingsList');
            const collapsed = grid.classList.toggle('collapsed');
            findingsBtn.textContent = collapsed ? '展开全部' : '收起';
        });
    }
    const explBtn = document.getElementById('toggleExplanationBtn');
    if (explBtn) {
        explBtn.addEventListener('click', () => {
            const list = document.getElementById('evidenceList');
            const collapsed = list.classList.toggle('collapsed');
            explBtn.textContent = collapsed ? '展开全部' : '收起';
        });
    }
}

// 诊断步骤定义：key 与后端 _set_diag_progress 的 step 对应，前端按序渲染
const DIAG_STEPS = [
    { key: 'loading',    label: '读取影像数据' },
    { key: 'preparing',  label: '重采样与推理准备' },
    { key: 'inferring',  label: '模型推理（器官分割 / 病灶检出）' },
    { key: 'assessing',  label: '扫描范围与对比剂适用性评估' },
    { key: 'finalizing', label: '结果整理与历史记录保存' },
];

let diagProgressTimer = null;
let diagProgressAnimTimer = null;

function renderDiagProgress(currentKey, detail, startedAt) {
    const panel = document.getElementById('diagProgress');
    const bar = document.getElementById('diagProgressBar');
    const stepsEl = document.getElementById('diagProgressSteps');
    const elapsedEl = document.getElementById('diagProgressElapsed');
    panel.hidden = false;

    const idx = DIAG_STEPS.findIndex(s => s.key === currentKey);
    const activeIdx = idx < 0 ? 0 : idx;
    // 进度条：按步骤等分，当前步骤内用已耗时做缓动填充（推理耗时不定）
    const base = activeIdx / DIAG_STEPS.length;
    const span = 1 / DIAG_STEPS.length;
    const inStep = Math.min(0.85, ((Date.now() / 1000) - (startedAt || Date.now() / 1000)) % 60 / 60 * 0.85);
    bar.style.width = `${Math.min(97, (base + span * Math.max(0.15, inStep)) * 100)}%`;

    stepsEl.innerHTML = DIAG_STEPS.map((s, i) => {
        const state = i < activeIdx ? 'done' : (i === activeIdx ? 'active' : 'todo');
        const mark = state === 'done' ? '✓' : (state === 'active' ? '●' : '○');
        const extra = (state === 'active' && detail) ? ` <em>${escapeHtml(detail)}</em>` : '';
        return `<li class="${state}"><span class="step-mark">${mark}</span>${s.label}${extra}</li>`;
    }).join('');

    if (startedAt) {
        const sec = Math.max(0, Math.round(Date.now() / 1000 - startedAt));
        elapsedEl.textContent = `已用时 ${sec}s`;
    }
}

function stopDiagProgressPolling() {
    if (diagProgressTimer) {
        clearInterval(diagProgressTimer);
        diagProgressTimer = null;
    }
    if (diagProgressAnimTimer) {
        clearInterval(diagProgressAnimTimer);
        diagProgressAnimTimer = null;
    }
}

function startDiagProgressPolling(fileId, startedAt) {
    stopDiagProgressPolling();
    let lastKey = 'loading', lastDetail = '';
    // progfix: 单一计时基准。轮询与本地动画定时器此前各用一套基准
    // （服务器 started_at vs 本地点击时刻，相差上传/预处理耗时），交替
    // 写同一元素导致「已用时」来回跳（如 2→5→4）。统一为 progStart：
    // 服务器基准一到手即采纳，两个定时器共用，读数单调递增。
    let progStart = startedAt;
    const tick = async () => {
        try {
            const res = await fetch(`/api/diagnose/${fileId}/progress`);
            const d = await res.json();
            if (d.running) {
                lastKey = d.step || lastKey;
                lastDetail = d.detail || lastDetail;
                if (d.started_at) progStart = d.started_at;
                renderDiagProgress(lastKey, lastDetail, progStart);
            } else {
                // 后端已清进度：诊断结束（成败由主请求的响应处理）
                stopDiagProgressPolling();
            }
        } catch (e) { /* 轮询失败不中断诊断，下一轮再试 */ }
    };
    tick();
    diagProgressTimer = setInterval(tick, 1200);
    // 本地计时器：让"已用时"与进度条动效平滑推进
    diagProgressAnimTimer = setInterval(() => {
        if (diagProgressTimer && !document.getElementById('diagProgress').hidden) {
            renderDiagProgress(lastKey, lastDetail, progStart);
        }
    }, 1000);
}

// ============ 发现采纳/拒绝 ============
// 每条影像学发现可「采纳」或「拒绝」：拒绝 = 置灰沉底（可恢复），不参与
// 叠加受累与报告；采纳时影像所见选填，报告只收录采纳项。
// 仅显式采纳的发现进报告：默认未采纳，医生逐条确认后采纳
function acceptedDiagnoses() {
    const ds = (AppState.currentDiagnosis || {}).diagnoses || [];
    return ds.filter(d => d.accepted === true && !d.rejected);
}

// 拒绝/恢复后轻量刷新叠加：受累器官着色/图例标记/可见范围与当前
// 列表内「未拒绝」发现保持一致，不重拉 overlay 数据（切片缓存保留）
function refreshAffectedOverlay() {
    const listed = ((AppState.currentDiagnosis || {}).diagnoses || [])
        .filter(d => !d.rejected);
    const names = new Set(listed.map(d => d.organ));
    OverlayState.organConfidence = new Map();
    OverlayState.organFinding = new Map();
    listed.forEach(d => {
        const c = Number(d.confidence) || 0;
        const prev = OverlayState.organConfidence.get(d.organ);
        if (prev == null || c > prev) {
            OverlayState.organConfidence.set(d.organ, c);
            OverlayState.organFinding.set(d.organ, d);
        }
    });
    OverlayState.affectedIds = new Set(
        OverlayState.legend.filter(o => names.has(o.name)).map(o => o.id)
    );
    // 定位标记指向的器官若已被拒绝移除，标注一并熄灭，并恢复可见范围
    if (OverlayState.locate && !names.has(OverlayState.locate.organ)) {
        OverlayState.locate = null;
        if (OverlayState.prevVisible) {
            OverlayState.visible = OverlayState.prevVisible;
            OverlayState.prevVisible = null;
        }
    }
    if (OverlayState.organMode === 'affected') {
        OverlayState.visible = new Set(OverlayState.affectedIds);
        if (!OverlayState.visible.size) OverlayState.visible =
            new Set(OverlayState.legend.map(o => o.id));
    }
    buildOverlayLegend();
    renderOverlay();
}

// ============ 置信度阈值（本地重过滤） ============
// 后端诊断时按全局设置阈值过滤过一次；这里保留完整集合 all_diagnoses，
// 用户拖动滑杆即可在本地重过滤：发现列表、叠加受累器官、印象横幅与
// PDF 报告（用 currentDiagnosis 生成）全部同步，无需重新诊断。
function initThresholdCtl() {
    const btn = document.getElementById('thresholdBtn');
    const pop = document.getElementById('thresholdPop');
    const range = document.getElementById('thresholdRange');
    if (!btn || !pop || !range) return;
    // 弹层打开时移到 body 下、按文档坐标 absolute 定位到按钮正下方：
    // 随页面滚动与按钮保持相对位置（fixed 滚动后会脱离按钮），且含块在
    // 面板 overflow:hidden 之外不被裁剪。无需跟随循环。
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!pop.hidden) { pop.hidden = true; return; }
        if (pop.parentElement !== document.body) document.body.appendChild(pop);
        pop.hidden = false;
        const r = btn.getBoundingClientRect();
        const left = r.left + window.scrollX + r.width / 2 - pop.offsetWidth / 2;
        pop.style.left = Math.max(8, left) + 'px';
        pop.style.top = (r.bottom + window.scrollY + 6) + 'px';
    });
    pop.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => { pop.hidden = true; });
    range.addEventListener('input', () => {
        const t = Number(range.value) / 100;
        applyConfidenceThreshold(t);
    });
}

function syncThresholdUi() {
    const t = (AppState.currentDiagnosis || {}).settings?.confidence_threshold;
    const val = document.getElementById('thresholdVal');
    const popVal = document.getElementById('thresholdPopVal');
    const range = document.getElementById('thresholdRange');
    const shown = t != null ? t : 0.5;
    if (val) val.textContent = pct(shown);
    if (popVal) popVal.textContent = pct(shown);
    if (range) range.value = String(Math.round(shown * 100));
}

function applyConfidenceThreshold(t) {
    const result = AppState.currentDiagnosis;
    if (!result) return;
    const all = AppState.allDiagnoses.length ? AppState.allDiagnoses
        : (result.all_diagnoses || result.diagnoses || []);
    AppState.allDiagnoses = all;
    // 置信度降序，保证发现列表/报告按严重度排列的既有约定不变。
    // 拒绝态挂在对象上（d.rejected），重过滤不丢失，列表渲染时沉底显示
    result.diagnoses = all
        .filter(d => (Number(d.confidence) || 0) >= t - 1e-9)
        .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0));
    result.settings = Object.assign({}, result.settings, { confidence_threshold: t });
    displayDiagnosisResult(result);
    // 列表立即按新阈值刷新；叠加图像随后异步重载
    renderOverlayFindings(result.diagnoses || []);
    initOverlayViewer(result);
    syncThresholdUi();
}

async function performDiagnosis() {
    if (!AppState.currentFileId) {
        showToast('请先上传影像文件', 'warning');
        return;
    }

    // 不再全屏遮罩：诊断是长任务，锁死页面会让用户以为卡死。
    // 改为诊断区内局部进度条 + 步骤列表，页面其余部分照常可用。
    const btn = document.getElementById('diagnoseBtn');
    if (btn) {
        btn.disabled = true;
        btn.classList.add('is-busy');
    }
    // 诊断期间报告按钮置灰：避免用旧结果生成报告；成功后再启用
    setReportBtnEnabled(false);
    const startedAt = Date.now() / 1000;
    renderDiagProgress('loading', '', startedAt);
    startDiagProgressPolling(AppState.currentFileId, startedAt);

    try {
        const response = await fetch(`/api/diagnose/${AppState.currentFileId}`, {
            method: 'POST'
        });

        const mediaType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
        if (mediaType !== 'application/json') {
            throw new Error(`暂时无法获取诊断结果（HTTP ${response.status}）。请先查看诊断历史，再决定是否重试。`);
        }
        const data = await response.json().catch(() => {
            throw new Error('诊断服务返回了无法读取的结果。请先查看诊断历史，再决定是否重试。');
        });

        if (response.ok && data?.success) {
            AppState.currentDiagnosis = data.result;
            AppState.currentHistoryCaseId = data.case_id || null;
            AppState.allDiagnoses = data.result.all_diagnoses
                || data.result.diagnoses || [];
            displayDiagnosisResult(data.result);
            // 发现列表先行，图像渲染后台准备（见 showOverlayCardPending）
            showOverlayCardPending(data.result);
            initOverlayViewer(data.result);
            syncThresholdUi();
            setWorkflowStep('workflowDiagnosisStep');
            setWorkflowStep('workflowReportStep');
            setReportBtnEnabled(true);
            if ((data.result.warnings || []).length) {
                showToast('诊断完成，但输入影像不满足模型适用条件，结果仅供参考', 'warning');
            } else {
                showToast('诊断完成，结果已生成', 'success');
            }
            // 诊断完成 → 写入 localStorage 缓存（24h TTL），
            // 同 file_id 刷新/重开页面时直接恢复，省掉 30-90s 模型推理
            saveDiagnosisCache(data.file_id || AppState.currentFileId,
                data.result, AppState.currentHistoryCaseId);
            // 结果已渲染：收起进度面板并滚到结果区
            document.getElementById('diagProgress').hidden = true;
            document.getElementById('resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
            showToast(data?.message || '诊断失败', 'error');
            document.getElementById('diagProgress').hidden = true;
        }
    } catch (error) {
        console.error('Diagnosis error:', error);
        showToast('诊断失败: ' + error.message, 'error');
        document.getElementById('diagProgress').hidden = true;
    } finally {
        stopDiagProgressPolling();
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('is-busy');
        }
    }
}

// ---- 诊断结果可视化辅助 ----
const SEVERITY_META = {
    high: { label: '高风险', cls: 'sev-high' },
    medium: { label: '中风险', cls: 'sev-medium' },
    low: { label: '低风险', cls: 'sev-low' },
};

function sevClass(sev) {
    return (SEVERITY_META[sev] || SEVERITY_META.low).cls;
}

function sevLabel(sev) {
    return (SEVERITY_META[sev] || SEVERITY_META.low).label;
}

// 总体风险分级：取所有阳性项中最高严重度；无阳性项则为「未见异常」
function overallSeverity(diagnoses) {
    if (!diagnoses.length) return null;
    if (diagnoses.some(d => d.severity === 'high')) return 'high';
    if (diagnoses.some(d => d.severity === 'medium')) return 'medium';
    return 'low';
}

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
}

function pct(v) {
    return (Number(v || 0) * 100).toFixed(1) + '%';
}

function displayDiagnosisResult(result) {
    const section = document.getElementById('resultSection');
    section.style.display = 'block';

    const diagnoses = result.diagnoses || [];
    const explanation = result.explanation || {};
    const threshold = result.settings?.confidence_threshold;

    // 引擎标识
    const engineEl = document.getElementById('resultEngine');
    if (engineEl) {
        const dev = explanation.device || result.raw_output?.device || '';
        engineEl.textContent = `${result.engine || 'RADAR'}${dev ? ' · ' + dev : ''}`;
    }

    // 患者与检查信息（随诊断结果返回，DICOM 时含真实患者ID）
    renderMetaCard(result.metadata, {
        card: 'resultMetaCard',
        grid: 'resultMetaGrid',
        source: 'resultMetaSource',
    });

    // ===== 输入适用性警告（扫描范围/对比剂不满足训练分布）=====
    const warnBox = document.getElementById('inputWarnings');
    const warnings = result.warnings || [];
    if (warnBox) {
        if (warnings.length) {
            warnBox.innerHTML = '<div class="iw-title">输入影像不满足模型适用条件，以下结果假阳性风险高</div>'
                + '<ul>' + warnings.map(w => `<li>${w}</li>`).join('') + '</ul>';
            warnBox.hidden = false;
        } else {
            warnBox.innerHTML = '';
            warnBox.hidden = true;
        }
    }

    // ===== 总体印象横幅 =====
    // 简化版 /ai 页只保留上传/叠加看片/报告，横幅与各结果卡片均按存在性渲染
    const organs = result.organs_detected || [];
    const banner = document.getElementById('impressionBanner');
    const overall = overallSeverity(diagnoses);
    if (banner) {
        banner.className = 'impression-banner card ' + (overall ? sevClass(overall) : 'sev-low');
        document.getElementById('overallRiskValue').textContent = overall ? sevLabel(overall) : '未见异常';

        const headlineEl = document.getElementById('impressionHeadline');
        const detailEl = document.getElementById('impressionDetail');
        if (!diagnoses.length) {
            headlineEl.textContent = '未发现达到阈值的明显异常';
            detailEl.textContent = `本次共评估 ${explanation.total_items ?? '—'} 个诊断项，均在置信度阈值${threshold != null ? `（${pct(threshold)}）` : ''}以下。RADAR 分割识别到 ${organs.length} 个器官，建议结合临床常规随访。`;
        } else {
            const topOrgans = [...new Set(diagnoses.map(d => d.organ))];
            headlineEl.textContent = `检出 ${diagnoses.length} 项阳性发现，累及 ${topOrgans.length} 个器官`;
            const top3 = diagnoses.slice(0, 3).map(d => `${d.organ}·${d.finding}（${pct(d.confidence)}）`);
            detailEl.textContent = `主要为：${top3.join('；')}${diagnoses.length > 3 ? ' 等' : ''}。`;
        }
    }

    // ===== 关键指标 =====
    const maxConf = diagnoses.length ? Math.max(...diagnoses.map(d => Number(d.confidence) || 0)) : 0;
    const topFinding = diagnoses.length ? diagnoses[0] : null;
    if (document.getElementById('lesionCount')) {
        document.getElementById('lesionCount').textContent = diagnoses.length;
        document.getElementById('lesionCountHint').textContent = threshold != null
            ? `置信度 ≥ ${pct(threshold)}` : '超过置信度阈值';
        document.getElementById('confidenceValue').textContent = diagnoses.length ? pct(maxConf) : '—';
        document.getElementById('confidenceHint').textContent = topFinding
            ? `${topFinding.organ}·${topFinding.finding}` : '无阳性项';
        const sevEl = document.getElementById('severityValue');
        sevEl.textContent = overall ? sevLabel(overall) : '正常';
        sevEl.className = 'metric-value metric-value-sm ' + (overall ? sevClass(overall) : 'is-normal');
        document.getElementById('organCount').textContent = organs.length;
    }

    // ===== 影像学发现（卡片网格）=====
    const grid = document.getElementById('findingsList');
    if (grid) {
        grid.innerHTML = '';
        grid.className = 'findings-grid' + (diagnoses.length > 6 ? ' collapsed' : '');
        const findingsBtn = document.getElementById('toggleFindingsBtn');
        if (findingsBtn) {
            findingsBtn.style.display = diagnoses.length > 6 ? '' : 'none';
            findingsBtn.textContent = '展开全部';
        }
        if (!diagnoses.length) {
            grid.appendChild(el('div', 'empty-state', '未见达到阈值的影像学发现。'));
        } else {
            diagnoses.forEach(d => {
                const card = el('div', 'finding-card ' + sevClass(d.severity));
                const top = el('div', 'finding-top');
                top.appendChild(el('span', 'finding-organ', d.organ));
                top.appendChild(el('span', 'finding-conf', pct(d.confidence)));
                card.appendChild(top);

                const nameWrap = el('div');
                nameWrap.appendChild(el('div', 'finding-name', d.finding));
                if (d.finding_en) nameWrap.appendChild(el('div', 'finding-name-en', d.finding_en));
                card.appendChild(nameWrap);

                const bar = el('div', 'finding-bar');
                const fill = el('span');
                fill.style.width = Math.max(2, Math.round((Number(d.confidence) || 0) * 100)) + '%';
                bar.appendChild(fill);
                card.appendChild(bar);

                const foot = el('div', 'finding-foot');
                foot.appendChild(el('span', 'severity-tag', sevLabel(d.severity)));
                foot.appendChild(el('span', 'finding-rec', d.recommendation || '建议专科进一步评估。'));
                card.appendChild(foot);

                grid.appendChild(card);
            });
        }
    }

    // ===== 器官分割 =====
    const chips = document.getElementById('organChips');
    if (chips) {
        chips.innerHTML = '';
        const organNote = document.getElementById('organNote');
        const affectedOrgans = new Set(diagnoses.map(d => d.organ));
        if (!organs.length) {
            chips.appendChild(el('div', 'empty-state', '未获取到器官分割结果。'));
            if (organNote) organNote.textContent = '';
        } else {
            organs.forEach(o => {
                chips.appendChild(el('span', 'organ-chip' + (affectedOrgans.has(o) ? ' is-target' : ''), o));
            });
            if (organNote) organNote.textContent = `共 ${organs.length} 个器官 · 蓝色为受累器官`;
        }
    }

    // ===== Top-N 得分条形图 =====
    const chart = document.getElementById('topScoresChart');
    if (chart) {
        chart.innerHTML = '';
        const topScores = explanation.top_scores || [];
        if (!topScores.length) {
            chart.appendChild(el('div', 'empty-state', '暂无得分排行数据。'));
        } else {
            topScores.forEach(s => {
                const positive = Number(s.confidence) >= (threshold ?? 0.5);
                const row = el('div', 'score-row' + (positive ? ' is-positive sev-medium' : ''));
                row.appendChild(el('span', 'score-label', s.item));
                row.appendChild(el('span', 'score-val', pct(s.confidence)));
                const track = el('div', 'score-track');
                const fill = el('span');
                fill.style.width = Math.max(2, Math.round((Number(s.confidence) || 0) * 100)) + '%';
                track.appendChild(fill);
                row.appendChild(track);
                chart.appendChild(row);
            });
        }
    }

    // ===== 建议处理 =====
    const recList = document.getElementById('recommendationsList');
    if (recList) {
        recList.innerHTML = '';
        (diagnoses.length ? diagnoses : [{ recommendation: '未见明显异常，建议结合临床情况进行常规随访。' }]).forEach(d => {
            recList.appendChild(el('li', null, d.recommendation || '建议由专科医生进一步评估。'));
        });
    }

    // ===== 可解释性与证据 =====
    // 简化版 /ai 页不含本卡片：按存在性渲染
    if (document.getElementById('explanationMethod')) {
        document.getElementById('explanationMethod').textContent = explanation.method || '';
        document.getElementById('explanationSummary').textContent = explanation.summary || '';

        const evidenceList = document.getElementById('evidenceList');
        evidenceList.innerHTML = '';
        evidenceList.className = 'evidence-list' + (diagnoses.length > 3 ? ' collapsed' : '');
        const explBtn = document.getElementById('toggleExplanationBtn');
        if (explBtn) {
            explBtn.style.display = diagnoses.length > 3 ? '' : 'none';
            explBtn.textContent = '展开全部';
        }
        if (!diagnoses.length) {
            evidenceList.appendChild(el('div', 'empty-state', '无阳性项证据。'));
        } else {
            diagnoses.forEach(d => {
                const item = el('div', 'evidence-item');
                const strong = el('strong', null, `${d.organ}·${d.finding}：`);
                item.appendChild(strong);
                item.appendChild(document.createTextNode(d.evidence || '未提供具体影像证据'));
                evidenceList.appendChild(item);
            });
        }

        const limitsBox = document.getElementById('limitationsBox');
        limitsBox.innerHTML = '';
        const limits = explanation.limitations || [];
        if (limits.length) {
            limitsBox.appendChild(el('div', 'limitations-title', '使用限制'));
            const ul = document.createElement('ul');
            limits.forEach(t => ul.appendChild(el('li', null, t)));
            limitsBox.appendChild(ul);
            limitsBox.style.display = '';
        } else {
            limitsBox.style.display = 'none';
        }

        const meta = document.getElementById('inferenceMeta');
        meta.innerHTML = '';
        const procTime = explanation.processing_time_sec ?? result.raw_output?.processing_time;
        const metaItems = [
            procTime != null ? `推理耗时 ${procTime} s` : '',
            explanation.device ? `设备 ${explanation.device}` : '',
            explanation.total_items != null ? `评估诊断项 ${explanation.total_items}` : '',
            result.patient_id ? `患者 ${result.patient_id}` : '',
        ].filter(Boolean);
        metaItems.forEach(t => meta.appendChild(el('span', null, t)));
    }

    // 分割叠加交互看片由调用方在结果渲染后触发（阈值重过滤时也会单独重跑）

    // 库内病例：把 AI 发现同步到「院内原始报告对照」卡右侧
    if (typeof renderAiSummaryIntoCompare === 'function') {
        renderAiSummaryIntoCompare(result, diagnoses);
    }

    section.scrollIntoView({ behavior: 'smooth' });
}

// ============ 分割叠加交互看片 ============
// 叠加数据（预处理 CT 灰度 + 器官标签）由推理引擎在诊断时导出为 overlay.npz，
// 与 stitched_mask 逐体素对齐，故前端按切片直接叠加即可，无需坐标逆变换。
const OverlayState = {
    fileId: null,
    meta: null,
    legend: [],
    affectedIds: new Set(),
    // 器官标签 -> 该器官最高置信度（注意力热力模式用）
    organConfidence: new Map(),
    // 器官名 -> 该器官最高置信度的诊断项（3D 病灶标注用）
    organFinding: new Map(),
    visible: new Set(),
    slice: 0,
    opacity: 0.45,
    // 2D 渲染模式：fill 填充 / contour 轮廓 / heat 注意力热力 / ct 隐藏叠加
    renderMode: 'heat',
    // 分割来源：full 后处理完整分割（补器官内部洞/裂缝、观感完整）/
    // raw 模型原始输出（默认，忠实 QC 视图）/ fine TotalSegmentator
    segSource: 'raw',
    // 3D 场景当前网格对应的分割来源（切换来源时需重建）
    scene3dSource: null,
    // 视图模式：2d 切片 / 3d 重建
    mode: '2d',
    // 「定位」跳转后的临时标注：{ ids:Set, names:[], until:时间戳 }，
    // 在目标切片上画红轮廓+名称标签，几秒后自动消失
    locate: null,
    // 进入定位前的可见器官快照：定位期间只显示目标器官，取消时恢复
    prevVisible: null,
    // 单窗切片来源：ai = AI 叠加空间 / orig = 原始 DICOM 序列同层切片；
    // srcFailed = 原始映射不可用（NIfTI 缺失/补零区），按钮切不过去
    src: 'ai',
    srcFailed: false,
    // 主窗是否已画过处理序列切片：已画过则后续取数不再盖加载遮罩
    hasDrawn: false,
    // locatefast: 证据层表页内缓存（{fid, map} 与在途 {fid, p}），
    // 定位按钮与切片就绪后的预取共用
    evidenceZ: null,
    evidenceZP: null,
    // locatefast: 切片未就绪时点了定位，记下待跳器官，
    // 切片加载完成后自动跳到病灶层
    pendingLocate: null,
    // 2D 缩放/平移视图：{ s: 倍数, tx/ty: 平移像素 }，transform 整体作用于
    // canvas（origin 中心），悬停器官提示按 rect 换算自动跟随，无需重渲染。
    // s 为相对「适配舞台」的绝对倍数：fitScale = 恰好铺满舞台的倍数，
    // 初始 s = fitScale（居中铺满）；userZoomed = 用户手动缩放过（不再自动适配）
    view: { s: 1, tx: 0, ty: 0 },
    fitScale: 1,
    lastFit: 0,
    userZoomed: false,
    // 拖拽平移中的起点快照 { x, y, tx, ty }，未拖拽为 null
    drag: null,
    current: null,
    cache: new Map(),
    cacheOrder: [],
    playTimer: null,
    loadSeq: 0,
    bound: false,
    scene3d: null,
    threeLoading: null,
};

function setOverlayLoading(on) {
    const l = document.getElementById('overlayLoading');
    if (l) l.classList.toggle('is-visible', !!on);
}

// ---- 2D 切片缩放/平移 ----
// transform 作用于 canvas 元素本身：切片像素数据不动，放大是浏览器插值
// （image-rendering: pixelated 保持锐利），悬停提示/定位标注随缩放自然对齐
function setOverlayView(s, tx, ty) {
    const canvas = document.getElementById('overlayCanvas');
    if (!canvas) return;
    const v = OverlayState.view;
    v.s = Math.min(10, Math.max(0.05, s));
    // 平移钳制：画面已铺满舞台时保证不露黑边；未铺满（缩小/适配）时居中
    const stage = document.getElementById('overlayStage');
    const sw = stage ? stage.clientWidth : canvas.offsetWidth;
    const sh = stage ? stage.clientHeight : canvas.offsetHeight;
    const mx = Math.max(0, (canvas.offsetWidth * v.s - sw) / 2);
    const my = Math.max(0, (canvas.offsetHeight * v.s - sh) / 2);
    v.tx = Math.min(mx, Math.max(-mx, tx));
    v.ty = Math.min(my, Math.max(-my, ty));
    applyViewTransforms();
    const lbl = document.getElementById('overlayZoomVal');
    // 百分比相对适配倍数：初始/复位 = 100%
    if (lbl) lbl.textContent = Math.round(v.s / (OverlayState.fitScale || 1) * 100) + '%';
}

// 缩放/平移只改 CSS transform：主看片与对照双窗三个 canvas 同步跟随，
// 不触发像素重合成，拖拽/滚轮缩放全程零重绘开销
function applyViewTransforms() {
    const v = OverlayState.view;
    const fit = OverlayState.fitScale || 1;
    // 主窗：绝对倍数（含适配基数）；双窗 canvas 尺寸按各自舞台算，只跟随
    // 相对适配的用户缩放 rel = s/fit，避免适配基数把双窗一起缩掉
    const rel = v.s / fit;
    const tMain = `translate(${v.tx}px, ${v.ty}px) scale(${v.s})`;
    const tDual = `translate(${v.tx * rel}px, ${v.ty * rel}px) scale(${rel})`;
    ['overlayCanvas', 'dualCanvasAi', 'dualCanvasOrig'].forEach(id => {
        const c = document.getElementById(id);
        if (!c) return;
        c.style.transform = id === 'overlayCanvas' ? tMain : tDual;
        // 超出各自适配倍数（用户放大、画面溢出舞台）才显示拖拽光标
        const z = id === 'overlayCanvas' ? v.s / fit : rel;
        c.classList.toggle('is-zoomed', z > 1.001);
    });
    syncLocateLabel();
}

// 以舞台坐标 (qx, qy) 为锚点缩放：该屏幕点在缩放前后保持不动
function zoomOverlayAt(qx, qy, factor) {
    const canvas = document.getElementById('overlayCanvas');
    if (!canvas) return;
    const v = OverlayState.view;
    const s2 = Math.min(10, Math.max(0.05, v.s * factor));
    if (s2 === v.s) return;
    OverlayState.userZoomed = true;
    const cx = canvas.offsetLeft + canvas.offsetWidth / 2;
    const cy = canvas.offsetTop + canvas.offsetHeight / 2;
    const ux = (qx - cx - v.tx) / v.s;
    const uy = (qy - cy - v.ty) / v.s;
    setOverlayView(s2, qx - cx - ux * s2, qy - cy - uy * s2);
}

// 以看片区域中心为锚点缩放（工具条 +/− 按钮用）
function zoomOverlayCenter(factor) {
    const stage = document.getElementById('overlayStage');
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    zoomOverlayAt(r.width / 2, r.height / 2, factor);
}

// ============ 原始序列对照阅片（双窗联动） ============
// 左窗 = AI 处理后的 96 层叠加空间，右窗 = 原始 DICOM 序列同层（原始矩阵/
// 原始 HU 窗化）。层号按预处理变换映射（后端 orig_slice），缩放/平移/器官
// 可见性/定位标注两窗共享，医生可在原始影像上核对 AI 发现对应的真实层面。
const DualState = {
    enabled: false,
    slice: -1,          // 已渲染的 overlay 层号，避免重复拉取
    entry: null,        // 原始切片 { ct, mask, width, height, origIndex, origSlices }
    cache: new Map(),   // overlay 层号 -> entry（独立小缓存，翻层不重复请求）
    loadSeq: 0,
    bound: false,
};

function dualWindowParams() {
    // 窗位/窗宽取上传信息卡的 DICOM 元数据，与原始序列显示一致
    const md = (AppState.currentFileInfo || {}).metadata || {};
    const num = (v, d) => {
        const f = parseFloat(String(v == null ? '' : v).split(/[\\/]/)[0]);
        return Number.isFinite(f) && f > 0 ? f : d;
    };
    return { wc: num(md.window_center, 40), ww: num(md.window_width, 400) };
}

// 双窗按「物理尺寸等比」显示：AI 空间像素间距 1×1×5mm，原始序列用 DICOM
// PixelSpacing。两窗 canvas 的显示高度按 视野物理高度(mm) 等比分配，
// 同一解剖结构在两窗显示为相同物理尺度，肉眼可直接比对大小/位置。
function dualPhysScale() {
    const meta = OverlayState.meta;
    const info = AppState.currentFileInfo || {};
    const sp = info.spacing || {};
    const row = Number(sp.row) > 0 ? Number(sp.row) : 1;   // 原始面内间距 mm
    const ai = meta ? { w: meta.width, h: meta.height, pr: 1, pc: 1 } : null;
    const og = DualState.entry
        ? { w: DualState.entry.width, h: DualState.entry.height, pr: row, pc: row }
        : null;
    if (!ai || !og) return null;
    const physH = { ai: ai.h * ai.pr, og: og.h * og.pr };   // 视野物理高 mm
    const physW = { ai: ai.w * ai.pc, og: og.w * og.pc };   // 视野物理宽 mm
    const stage = document.querySelector('#dualViewCard .dual-stage');
    // 页面没有对照双窗卡（/ai）或卡隐藏（display:none）时 clientWidth/Height
    // 为 0：回退主舞台尺寸，使单窗物理比例不依赖对照卡存不存在
    const mstage = document.getElementById('overlayStage');
    const liveH = (stage && stage.clientHeight ? stage.clientHeight
        : (mstage ? mstage.clientHeight : 440)) - 8;
    const liveW = (stage && stage.clientWidth ? stage.clientWidth
        : (mstage ? mstage.clientWidth : 800)) - 8;
    // jitter-fix: 首次有效测量后锁定舞台盒，翻层不再改变 canvas 显示尺寸
    if (!DualState.lockedBox && liveW > 0 && liveH > 0) {
        DualState.lockedBox = { W: liveW, H: liveH };
    }
    const H = DualState.lockedBox ? DualState.lockedBox.H : liveH;
    const W = DualState.lockedBox ? DualState.lockedBox.W : liveW;
    if (H <= 0 || W <= 0) return null;
    // 每 mm 显示像素：两窗同一比例，取能同时容纳两窗视野的上限
    const k = Math.min(H / Math.max(physH.ai, physH.og), W / Math.max(physW.ai, physW.og));
    return {
        ai: { w: Math.max(40, Math.round(physW.ai * k)), h: Math.max(40, Math.round(physH.ai * k)) },
        og: { w: Math.max(40, Math.round(physW.og * k)), h: Math.max(40, Math.round(physH.og * k)) },
    };
}

// 单窗物理比例：主看片 canvas 的显示尺寸按 mm 等比内联设置，处理序列与原始
// 序列用同一 mm/像素比例（与对照双窗口径一致），切换来源时解剖结构显示大小
// 不变，不会「突然变大/变小」。处理序列未就绪时按原始切片尺寸显示。
function applyMainPhysScale() {
    const stage = document.getElementById('overlayStage');
    const canvas = document.getElementById('overlayCanvas');
    if (!stage || !canvas) return;
    const meta = OverlayState.meta;
    const metaKey = meta ? `${meta.width}x${meta.height}x${meta.num_slices}` : '';
    const scale = dualPhysScale();
    let d = null;
    if (scale) {
        d = (OverlayState.src === 'orig' && DualState.entry) ? scale.og : scale.ai;
        OverlayState.lastPhys = { key: metaKey, ai: scale.ai, og: scale.og };
    } else if (OverlayState.lastPhys && OverlayState.lastPhys.key === metaKey) {
        // jitter-fix2: 翻层瞬间 DualState.entry 被置空，dualPhysScale 返回 null，
        // 旧逻辑会清掉 canvas 内联尺寸导致画面闪回自然尺寸。同一序列内
        // 复用最后一次有效物理尺寸，切换过程画面尺寸恒定。
        d = (OverlayState.src === 'orig' && OverlayState.lastPhys.og)
            ? OverlayState.lastPhys.og : OverlayState.lastPhys.ai;
    }
    if (!d) {
        stage.classList.remove('phys-scaled');
        canvas.style.width = '';
        canvas.style.height = '';
        applyFitScale();
        return;
    }
    stage.classList.add('phys-scaled');
    canvas.style.width = d.w + 'px';
    canvas.style.height = d.h + 'px';
    applyFitScale();
}

// 适配倍数：canvas 显示尺寸恰好铺满舞台（居中）的缩放值。初始/复位时视图
// 取该倍数（画面居中铺满，处理序列与原始序列同一口径）；用户手动缩放后
// 不再自动抢回。舞台或 canvas 尺寸变化（切来源/窗口拉伸）时重算
// jitter-fix: 舞台尺寸在首次有效测量后锁定，翻层/滚动条出没不再重排；
// 仅真实窗口 resize 时解锁重算（见文件末尾 resize 监听）
function lockedStageSize(stage) {
    // drawer-fix: 收起/展开控制面板的过渡期内用实时尺寸，画布连续重适配
    if (OverlayState.liveFitUntil && Date.now() < OverlayState.liveFitUntil) {
        return { w: stage.clientWidth, h: stage.clientHeight };
    }
    if (!OverlayState.lockedStage && stage.clientWidth > 0 && stage.clientHeight > 0) {
        OverlayState.lockedStage = { w: stage.clientWidth, h: stage.clientHeight };
    }
    return OverlayState.lockedStage || { w: stage.clientWidth, h: stage.clientHeight };
}
function unlockStageSize() {
    OverlayState.lockedStage = null;
    DualState.lockedBox = null;
}

function applyFitScale() {
    const stage = document.getElementById('overlayStage');
    const canvas = document.getElementById('overlayCanvas');
    if (!stage || !canvas || !canvas.offsetWidth || !canvas.offsetHeight) return;
    // 几乎铺满（只留 2% 间隙避免贴边糊），彻底消掉下方/右侧大黑条
    // jitter-fix: 用锁定尺寸算 fit，翻层时 fit 恒定，画面不再逐层跳动
    const ls = lockedStageSize(stage);
    const fit = Math.min(ls.w / canvas.offsetWidth,
        ls.h / canvas.offsetHeight) * 0.98;
    if (fit <= 0) return;
    const changed = Math.abs(fit - (OverlayState.fitScale || 0)) > 1e-6;
    OverlayState.fitScale = fit;
    if (!OverlayState.userZoomed) {
        // 仅 fit 真正变化（新序列/窗口 resize）时回居中；翻层保持当前视图
        if (changed || !OverlayState.view || !OverlayState.view.s) setOverlayView(fit, 0, 0);
    } else {
        setOverlayView(OverlayState.view.s, OverlayState.view.tx, OverlayState.view.ty);
    }
}

// 复位：回到适配倍数的居中视图
function resetOverlayView() {
    OverlayState.userZoomed = false;
    setOverlayView(OverlayState.fitScale || 1, 0, 0);
}

function setDualEnabled(on) {
    const card = document.getElementById('dualViewCard');
    DualState.enabled = !!on;
    // 页面无对照卡（/ai）时链路空跑：仍预取原始切片，供主窗「原始序列」
    // 切换与物理比例计算使用，只是不显示双窗 UI
    if (card) card.style.display = DualState.enabled ? '' : 'none';
    const btn = document.getElementById('dualViewToggle');
    if (btn) btn.classList.toggle('is-active', DualState.enabled);
    if (DualState.enabled) {
        bindDualEvents();
        DualState.slice = -1;
        loadDualSlice(OverlayState.slice);
    }
}

async function loadDualSlice(idx) {
    if (!DualState.enabled || !OverlayState.meta) return;
    if (DualState.slice !== idx) DualState.entry = null;
    DualState.slice = idx;
    const token = ++DualState.loadSeq;
    const setBusy = (on) => {
        const l = document.getElementById('dualLoading');
        if (l) l.classList.toggle('is-visible', on);
    };
    try {
        let entry = DualState.cache.get(idx);
        if (!entry) {
            setBusy(true);
            const { wc, ww } = dualWindowParams();
            // crop=1：后端把原始切片裁到与 AI 空间同一物理 FOV，
            // 两窗显示同区域、同尺度，肉眼可直接比对
            const resp = await fetch(
                `/api/overlay/${encodeURIComponent(OverlayState.fileId)}/orig_slice/${idx}`
                + `?mode=${encodeURIComponent(OverlayState.segSource)}`
                + `&window_center=${wc}&window_width=${ww}&crop=1`
            );
            const data = await resp.json();
            if (token !== DualState.loadSeq) return;
            if (!data.success) {
                DualState.entry = null;
                renderDual();
                // 单窗原始序列模式：标记映射不可用，主窗提示并熄灭定位标注
                OverlayState.srcFailed = true;
                if (OverlayState.src === 'orig') {
                    renderOverlay();
                    updateSrcLabel();
                }
                showDualUnavailable(data.message || '原始序列映射不可用');
                return;
            }
            const [ct, mask] = await Promise.all([decodePng(data.ct), Promise.resolve(decodeMask(data.mask))]);
            entry = {
                ct, mask, width: data.width, height: data.height,
                origIndex: data.orig_index, origSlices: data.orig_slices,
                nearest: data.nearest === true,
                cropRect: data.crop_rect || null,
            };
            DualState.cache.set(idx, entry);
            while (DualState.cache.size > 8) {
                DualState.cache.delete(DualState.cache.keys().next().value);
            }
        }
        if (token !== DualState.loadSeq) return;
        DualState.entry = entry;
        OverlayState.srcFailed = false;
        showDualUnavailable(null);
        applyMainPhysScale();   // 原始尺寸就绪：单窗物理比例可精确计算
        renderDual();
        // 单窗原始序列模式：切片就绪后主窗重绘并刷新层号标记
        if (OverlayState.src === 'orig') {
            renderOverlay();
            updateSrcLabel();
        }
    } catch (e) {
        console.error('loadDualSlice error:', e);
    } finally {
        if (token === DualState.loadSeq) setBusy(false);
    }
}

function showDualUnavailable(msg) {
    const box = document.getElementById('dualUnavailable');
    if (!box) return;
    if (msg) {
        box.textContent = msg;
        box.hidden = false;
    } else {
        box.hidden = true;
    }
}

// 双窗渲染：左 = 叠加空间（复用主缓存切片），右 = 原始序列同层。
// 两窗共用 OverlayState 的可见器官/渲染模式/透明度/定位标注/缩放平移。
function renderDual() {
    if (!DualState.enabled) return;
    const left = document.getElementById('dualCanvasAi');
    const right = document.getElementById('dualCanvasOrig');
    if (!left || !right) return;
    const idx = OverlayState.slice;
    const ai = OverlayState.cache.get(idx) || OverlayState.current;
    if (ai) compositeSliceTo(left, ai.ct, ai.mask, ai.width, ai.height);
    const og = DualState.entry;
    if (og && DualState.slice === idx) {
        compositeSliceTo(right, og.ct, og.mask, og.width, og.height, og.nearest);
    } else {
        const ctx = right.getContext('2d');
        right.width = 8; right.height = 8;
        ctx.clearRect(0, 0, 8, 8);
    }
    // 显示尺寸按物理尺度等比：裁到同 FOV 后两窗解剖结构同大小同位置
    const scale = dualPhysScale();
    if (scale) {
        left.style.width = scale.ai.w + 'px';
        left.style.height = scale.ai.h + 'px';
        right.style.width = scale.og.w + 'px';
        right.style.height = scale.og.h + 'px';
    }
    const aiLbl = document.getElementById('dualAiSlice');
    const ogLbl = document.getElementById('dualOrigSlice');
    if (aiLbl) aiLbl.textContent = `处理序列 · 第 ${idx + 1} 层`;
    if (ogLbl) {
        ogLbl.textContent = og && DualState.slice === idx
            ? `${og.nearest ? '最近原图' : '原始序列'} · 第 ${og.origIndex + 1}/${og.origSlices} 层`
            : '原始序列 · —';
    }
    applyViewTransforms();
}

function bindDualEvents() {
    if (DualState.bound) return;
    const card = document.getElementById('dualViewCard');
    // 页面无对照卡（/ai）：无需绑定双窗交互事件
    if (!card) return;
    DualState.bound = true;
    // 任一窗滚轮：翻层（两窗同步）；Ctrl+滚轮：以光标为锚点缩放两窗
    card.addEventListener('wheel', (e) => {
        if (!OverlayState.meta) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
            // 锚点换算到主看片舞台坐标：zoomOverlayAt 维护共享视图，
            // applyViewTransforms 让双窗 canvas 同步跟随
            const stage = document.getElementById('overlayStage');
            const r = stage.getBoundingClientRect();
            zoomOverlayAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.2 : 1 / 1.2);
            return;
        }
        stopOverlayPlay();
        const dir = e.deltaY > 0 ? 1 : -1;
        const next = Math.min(OverlayState.meta.num_slices - 1, Math.max(0, OverlayState.slice + dir));
        if (next !== OverlayState.slice) {
            document.getElementById('overlaySlice').value = String(next);
            // loadOverlaySlice 内部会带上对照窗的同步拉取
            loadOverlaySlice(next);
        }
    }, { passive: false });

    // 拖拽平移：两窗同步（复用 OverlayState.view）
    let drag = null;
    card.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || OverlayState.view.s <= 1) return;
        e.preventDefault();
        drag = { x: e.clientX, y: e.clientY, tx: OverlayState.view.tx, ty: OverlayState.view.ty };
    });
    window.addEventListener('mousemove', (e) => {
        if (!drag) return;
        setOverlayView(OverlayState.view.s, drag.tx + (e.clientX - drag.x), drag.ty + (e.clientY - drag.y));
        renderDual();
    });
    window.addEventListener('mouseup', () => { drag = null; });
    card.addEventListener('dblclick', () => { resetOverlayView(); renderDual(); });

    // 悬停：两窗分别按各自矩阵报器官名与坐标
    const hover = (canvas, isOrig) => (e) => {
        const cur = isOrig ? DualState.entry : (OverlayState.cache.get(OverlayState.slice) || OverlayState.current);
        const tip = document.getElementById('dualCursorTip');
        if (!cur || !tip) return;
        const rect = canvas.getBoundingClientRect();
        const px = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width));
        const py = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height));
        if (px < 0 || py < 0 || px >= cur.width || py >= cur.height) { tip.style.display = 'none'; return; }
        const lab = cur.mask[py * cur.width + px];
        const organ = OverlayState.legend.find(o => o.id === lab);
        const name = cur.nearest ? '未叠加分割' : (lab === 0 ? '背景' : (organ ? organ.name : `器官${lab}`));
        tip.textContent = `${isOrig ? '原始' : 'AI'} · ${name} · (${px}, ${py})`;
        tip.style.display = 'block';
        const stageRect = document.getElementById('dualViewCard').getBoundingClientRect();
        tip.style.left = (e.clientX - stageRect.left + 14) + 'px';
        tip.style.top = (e.clientY - stageRect.top + 14) + 'px';
    };
    const ca = document.getElementById('dualCanvasAi');
    const co = document.getElementById('dualCanvasOrig');
    ca.addEventListener('mousemove', hover(ca, false));
    co.addEventListener('mousemove', hover(co, true));
    card.addEventListener('mouseleave', () => {
        const tip = document.getElementById('dualCursorTip');
        if (tip) tip.style.display = 'none';
    });
}

// 诊断结果一回来就先把看片卡片亮出来：影像学发现列表立即渲染。
// 初始画面走「原始序列对照左窗」的样式：先拉原始 DICOM 同层切片直接上屏
// （不盖全屏加载遮罩），处理序列切片就绪后再自然替换，避免长时间黑屏+遮罩
function showOverlayCardPending(result) {
    const card = document.getElementById('overlayCard');
    if (!card || !result || !result.overlay) return;
    card.style.display = '';
    renderOverlayFindings(result.diagnoses || []);
    // 看片状态复位：避免上一病例的处理序列切片被当作新病例画面
    OverlayState.current = null;
    OverlayState.cache.clear();
    OverlayState.slice = 0;
    const sl = document.getElementById('overlaySlice');
    if (sl) sl.value = '0';
    updateSrcLabel();
}

async function initOverlayViewer(result) {
    const card = document.getElementById('overlayCard');
    const fileId = AppState.currentFileId;
    if (!fileId || !result || !result.overlay) {
        if (card) card.style.display = 'none';
        return;
    }

    stopOverlayPlay();
    OverlayState.fileId = fileId;
    OverlayState.cache.clear();
    OverlayState.cacheOrder = [];
    OverlayState.current = null;
    OverlayState.slice = 0;
    OverlayState.loadSeq = 0;
    // 单窗来源复位到 AI 叠加：新病例的原始序列映射与旧病例无关
    OverlayState.src = 'ai';
    OverlayState.srcFailed = false;
    OverlayState.hasDrawn = false;
    // locatefast: 新一轮诊断作废证据层缓存与待跳状态（旧病例层号无意义）
    OverlayState.evidenceZ = null;
    OverlayState.evidenceZP = null;
    OverlayState.pendingLocate = null;
    updateSrcToggleUi();
    // 新诊断的网格与旧文件不同：标记 3D 场景需重建，避免沿用旧器官网格
    OverlayState.scene3dSource = null;
    // 新一轮诊断：缩放/平移复位（回到适配倍数的居中视图）
    resetOverlayView();

    // 器官 -> 最高置信度：注意力热力模式按它给受累器官着色
    OverlayState.organConfidence = new Map();
    // 器官 -> 最高置信度的诊断项：3D 病灶标注显示发现名与置信度
    OverlayState.organFinding = new Map();
    (result.diagnoses || []).forEach(d => {
        const c = Number(d.confidence) || 0;
        const prev = OverlayState.organConfidence.get(d.organ);
        if (prev == null || c > prev) {
            OverlayState.organConfidence.set(d.organ, c);
            OverlayState.organFinding.set(d.organ, d);
        }
    });

    const affectedNames = new Set((result.diagnoses || []).map(d => d.organ));

    card.style.display = '';
    bindOverlayEvents();

    // 不再盖全屏加载遮罩：主窗已有原始序列占位画面，处理序列就绪后自然替换
    try {
        // 按当前选择的分割来源拉 meta；来源不可用（如 fine 未生成）回退 full
        let resp = await fetch(
            `/api/overlay/${encodeURIComponent(fileId)}/meta?mode=${encodeURIComponent(OverlayState.segSource)}`
        );
        if (!resp.ok && OverlayState.segSource !== 'full') {
            OverlayState.segSource = 'full';
            resp = await fetch(`/api/overlay/${encodeURIComponent(fileId)}/meta`);
        }
        // overlay 导出已改后台线程两段式：主 npz（看片所需）约 5s 落盘、
        // attn 更晚；轮询等待主 npz 就绪——前 10 次 400ms 快速探测，之后
        // 1.5s 退避（上限 60s）；期间叠加卡片显示加载态
        let data = null;
        for (let attempt = 0; attempt < 46; attempt++) {
            if (resp.ok) {
                data = await resp.json();
                if (data.success) break;
            }
            data = null;
            if (OverlayState.fileId !== fileId) return; // 已切到新诊断，放弃本轮
            await new Promise(r => setTimeout(r, attempt < 10 ? 400 : 1500));
            resp = await fetch(`/api/overlay/${encodeURIComponent(fileId)}/meta`);
        }
        if (!data || !data.success) {
            // ovfix: 导出始终未就绪：不再静默隐藏看片卡（用户只看到空白与
            // 转圈，误以为"影像加载不出来"）。保留卡片并给出可操作提示
            setOverlayLoading(false);
            OverlayState.pendingLocate = null;
            if (OverlayState.pendWatch) clearTimeout(OverlayState.pendWatch);
            showToast('影像切片加载失败：服务器叠加数据未就绪，请稍后重开本记录或重新诊断', 'error');
            return;
        }

        // 分割来源下拉：精细分割仅在后台生成完成后出现
        const segSel = document.getElementById('overlaySegSource');
        if (segSel) {
            const fineOpt = segSel.querySelector('option[value="fine"]');
            if (fineOpt) fineOpt.hidden = !data.has_fine;
            if (segSel.value !== OverlayState.segSource) segSel.value = OverlayState.segSource;
        }

        OverlayState.meta = data;
        OverlayState.legend = data.organ_legend || [];
        OverlayState.affectedIds = new Set(
            OverlayState.legend.filter(o => affectedNames.has(o.name)).map(o => o.id)
        );
        // 默认只看受累器官：打开看片即聚焦病灶区域，
        // 需要全局解剖对照时点工具条「全选器官」
        OverlayState.visible = new Set(OverlayState.affectedIds);
        // 新一轮诊断：上一轮的定位标注作废（按钮由 renderOverlayFindings 重建）；
        // locatefast: 本轮切片加载期间点过定位（pendingLocate）则保留标注状态，
        // 就绪后补全器官 ids 并落到病灶层
        if (!OverlayState.pendingLocate) {
            OverlayState.locate = null;
            OverlayState.prevVisible = null;
        }
        // 对照双窗的原始切片缓存同样作废（层映射/分割来源可能变化）
        DualState.cache.clear();
        DualState.entry = null;
        DualState.slice = -1;

        buildOverlayLegend();
        setOverlayOrgans(OverlayState.affectedIds.size ? 'affected' : 'all');
        renderOverlayFindings(result.diagnoses || []);
        // locatefast: 预取证据层表，定位按钮点击时不再现场等待
        getEvidenceZMap(fileId, false);
        const sliceInput = document.getElementById('overlaySlice');
        sliceInput.max = String(Math.max(0, data.num_slices - 1));
        document.getElementById('overlaySize').textContent =
            `${data.width} × ${data.height} × ${data.num_slices}`;

        // 默认从第一张切片开始浏览：医生习惯自顶向下逐层翻阅，
        // 需要快速到病灶时用发现列「定位」或图例「跳转」
        OverlayState.slice = 0;
        sliceInput.value = '0';
        // 原始序列对照链路默认开启：有卡（主页）显示双窗，无卡（/ai）空跑
        // 预取原始切片，供主窗「原始序列」切换与物理比例使用
        if (!DualState.enabled) setDualEnabled(true);
        await loadOverlaySlice(0);
        // locatefast: 切片就绪后自动落到病灶层（医生在加载期间已点定位）
        const pend = OverlayState.pendingLocate;
        if (pend && OverlayState.fileId === fileId) {
            OverlayState.pendingLocate = null;
            if (OverlayState.pendWatch) clearTimeout(OverlayState.pendWatch);
            const pendIds = new Set(OverlayState.legend
                .filter(x => x.name === pend.organ).map(x => x.id));
            if (OverlayState.locate && OverlayState.locate.organ === pend.organ) {
                OverlayState.locate.ids = pendIds;
                OverlayState.locate.slice = pend.slice;
            }
            OverlayState.visible = pendIds;
            syncLegendCheckboxes();
            OverlayState.slice = pend.slice;
            sliceInput.value = String(pend.slice);
            loadOverlaySlice(pend.slice);
            renderOverlay();
            syncScene3dVisibility('all');
        }
    } catch (e) {
        console.error('Overlay init error:', e);
        // ovfix: 初始化异常不再整卡隐藏（此前静默隐藏=用户看到"影像加载
        // 不出来"且无任何反馈）。保留卡片并 toast 原因，便于定位与重试
        setOverlayLoading(false);
        OverlayState.pendingLocate = null;
        if (OverlayState.pendWatch) clearTimeout(OverlayState.pendWatch);
        showToast('看片初始化异常：' + ((e && e.message) || e) + '，请重开本记录重试', 'error');
    } finally {
        // 仅当仍是本轮诊断时才清加载态：旧轮询放弃不应关掉新诊断的加载指示
        if (OverlayState.fileId === fileId) setOverlayLoading(false);
    }
}

// boxId 参数化：主看片与对照窗各自一份图例，勾选状态共享 OverlayState.visible
function buildOverlayLegend(boxId = 'overlayLegend') {
    const box = document.getElementById(boxId);
    if (!box) return;
    box.innerHTML = '';
    const items = OverlayState.legend;
    const countEl = document.getElementById(boxId === 'overlayLegend' ? 'overlayLegendCount' : 'dualLegendCount');
    if (countEl) countEl.textContent = `${items.length} 个`;
    items.forEach(o => {
        const label = el('label', 'overlay-legend-item');
        label.title = `层 ${o.z_min + 1}–${o.z_max + 1} · ${o.volume} 体素`;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = OverlayState.visible.has(o.id);
        cb.addEventListener('change', () => {
            if (cb.checked) OverlayState.visible.add(o.id);
            else OverlayState.visible.delete(o.id);
            label.classList.toggle('is-off', !cb.checked);
            renderOverlay();
            syncScene3dVisibility();
        });
        const sw = el('span', 'overlay-swatch');
        sw.style.background = `rgb(${o.color.join(',')})`;
        label.appendChild(cb);
        label.appendChild(sw);
        label.appendChild(el('span', 'overlay-legend-name', o.name));
        if (OverlayState.affectedIds.has(o.id)) {
            label.appendChild(el('span', 'overlay-legend-tag', '受累'));
        }
        // 跳转到该器官正中层面
        const jump = document.createElement('button');
        jump.type = 'button';
        jump.className = 'overlay-legend-jump';
        jump.textContent = '跳转';
        jump.title = `跳到${o.name}正中层面`;
        jump.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const target = Math.round((o.z_min + o.z_max) / 2);
            document.getElementById('overlaySlice').value = String(target);
            stopOverlayPlay();
            loadOverlaySlice(target);
        });
        label.appendChild(jump);
        box.appendChild(label);
    });
}

// locatefast: 证据层表页内缓存（按 file_id 隔离、并发去重）。
// 定位按钮与切片就绪后的预取共用；backfill 后 force 重取。
function getEvidenceZMap(fid, force) {
    const done = OverlayState.evidenceZ;
    if (!force && done && done.fid === fid) return Promise.resolve(done.map);
    const pend = OverlayState.evidenceZP;
    if (!force && pend && pend.fid === fid) return pend.p;
    const entry = {
        fid,
        p: fetch(`/api/overlay/${fid}/evidence-z`)
            .then(r => r.json())
            .then(j => {
                const map = (j && j.success) ? (j.evidence_z || {}) : null;
                OverlayState.evidenceZ = { fid, map };
                return map;
            })
            .catch(() => {
                OverlayState.evidenceZP = null;
                return null;
            }),
    };
    OverlayState.evidenceZP = entry;
    return entry.p;
}

// 看片右侧「影像学发现」速览列：诊断结果与切片同屏对照，无需上下翻动页面。
// 点击条目跳到该器官正中层面，并在热力模式下高亮对应器官。
function renderOverlayFindings(diagnoses) {
    const list = document.getElementById('overlayFindingsList');
    if (!list) return;
    list.innerHTML = '';
    syncReportBtnLabel();

    if (!diagnoses.length) {
        list.appendChild(el('div', 'ovf-empty', '未见达到阈值的影像学发现'));
        return;
    }

    // 器官名 -> Z 范围（图例里有），用于「定位」跳转
    const zRange = {};
    OverlayState.legend.forEach(o => { zRange[o.name] = o; });

    // 拒绝的发现不删除：置灰并沉到列表最底部，可恢复（sort 稳定，其余保持原序）
    const ordered = diagnoses.slice()
        .sort((a, b) => (a.rejected ? 1 : 0) - (b.rejected ? 1 : 0));
    // 重渲染前记住滚动位置，避免交互后列表跳回顶部
    const prevScroll = list.scrollTop;

    ordered.forEach((d, i) => {
        const item = el('div', 'ovf-item ' + sevClass(d.severity));
        item.dataset.organ = d.organ;
        if (d.rejected) item.classList.add('is-rejected');

        const top = el('div', 'ovf-top');
        top.appendChild(el('span', 'ovf-organ', d.organ));
        top.appendChild(el('span', 'ovf-conf', pct(d.confidence)));
        item.appendChild(top);

        item.appendChild(el('div', 'ovf-name', d.finding));

        const bar = el('div', 'ovf-bar');
        const fill = el('span');
        fill.style.width = Math.max(2, Math.round((Number(d.confidence) || 0) * 100)) + '%';
        bar.appendChild(fill);
        item.appendChild(bar);

        const meta = el('div', 'ovf-meta');
        meta.appendChild(el('span', null, sevLabel(d.severity)));
        // 操作组：定位（跳层标注）/ 采纳（进入报告）/ 拒绝（直接移除）
        const acts = el('div', 'ovf-actions');
        const o = zRange[d.organ];
        // locatefast: 定位按钮不再等图例（切片）就绪才出现：有 evidence_z
        // 或可取证据层表即跳病灶层；切片本身后台加载，医生不必干等
        if (o || d.evidence_z != null || AppState.currentFileId) {
            const jump = el('button', 'ovf-jump', '定位');
            jump.type = 'button';
            jump.title = `跳到${d.organ}病灶证据层并标注`;
            jump.addEventListener('click', async (e) => {
                e.stopPropagation();
                const ids = new Set(OverlayState.legend
                    .filter(x => x.name === d.organ).map(x => x.id));
                // 再次点击 = 取消标记：清掉红圈/标签但保持当前切片不动，
                // 且只保留当前病灶器官的分割轮廓（不恢复定位前可见范围）
                if (OverlayState.locate && OverlayState.locate.organ === d.organ) {
                    OverlayState.locate = null;
                    OverlayState.prevVisible = null;
                    OverlayState.pendingLocate = null;
                    // locatelabel3: 取消后渲染模式保持热力不变；清空可见器官
                    // 使画面回到原图（无热力/无轮廓），叠加用全选/受累恢复
                    OverlayState.visible = new Set();
                    syncLegendCheckboxes();
                    jump.classList.remove('is-on');
                    jump.textContent = '定位';
                    renderOverlay();
                    syncScene3dVisibility('all');
                    return;
                }
                // 换一条发现：先熄灭其它按钮的取消态
                list.querySelectorAll('.ovf-jump.is-on').forEach(n => {
                    n.classList.remove('is-on');
                    n.textContent = '定位';
                });
                // locate-fix5: 点击立即置灰并显示「定位中…」。旧记录无 evidence_z
                // 时证据层需现场请求，此前按钮在等待期间毫无反馈，显得不灵敏，
                // 且可被重复点击触发并发请求
                jump.disabled = true;
                jump.textContent = '定位中…';
                try {
                    const fid = AppState.currentFileId;
                    // 证据层表页内缓存（并发去重），补推理后强制重取
                    const getEvidenceZ = (force) => getEvidenceZMap(fid, force);
                    // locate-fix: 优先跳后端证据层（与报告证据图同层，病灶证据所在层）
                    let target = (d.evidence_z != null) ? d.evidence_z : null;
                    if (target == null) {
                        const map = await getEvidenceZ(false);
                        if (map) target = map[d.organ];
                    }
                    // locate-fix3: 无注意力证据时补推理生成 attn.npz（约一分钟），
                    // 再取证据层；不回退器官截面积最大层
                    if (target == null) {
                        showToast('该病例缺少病灶注意力证据，正在补推理生成（约1分钟）…', 'info');
                        try {
                            const b = await fetch(
                                `/api/overlay/${fid}/backfill-attn`,
                                { method: 'POST' });
                            const bj = await b.json();
                            if (bj && bj.success) {
                                const map2 = await getEvidenceZ(true);
                                if (map2) target = map2[d.organ];
                            } else {
                                showToast((bj && bj.message) || '病灶证据生成失败', 'error');
                            }
                        } catch (err) {
                            showToast('病灶证据生成失败：网络异常', 'error');
                        }
                    }
                    if (target == null) {
                        showToast('该发现暂无病灶层面证据，无法精确定位', 'error');
                        return;
                    }
                    // 定位期间只显示当前病灶的分割：首次进入定位时快照当前
                    // 可见范围，切到仅目标器官；换一条发现时沿用同一快照
                    if (!OverlayState.locate) {
                        OverlayState.prevVisible = new Set(OverlayState.visible);
                    }
                    if (ids.size) {
                        OverlayState.visible = new Set(ids);
                        syncLegendCheckboxes();
                    }
                    OverlayState.locate = {
                        ids,
                        organ: d.organ,
                        names: [d.organ],
                        slice: target,
                    };
                    // heat-default: 定位展示用注意力热力而非轮廓；同步下拉
                    // 与图例。可见器官保持定位隔离（仅目标器官），不走
                    // change 处理器的 affected 逻辑
                    if (OverlayState.renderMode !== 'heat') {
                        OverlayState.renderMode = 'heat';
                        const rmSel = document.getElementById('overlayMode');
                        if (rmSel) rmSel.value = 'heat';
                        const hl = document.getElementById('overlayHeatLegend');
                        if (hl) hl.hidden = false;
                    }
                    jump.classList.add('is-on');
                    jump.textContent = '取消';
                    stopOverlayPlay();
                    // locatefast: 切片尚未就绪（overlay 导出中）时先记下待跳
                    // 器官，切片加载完成后自动落到病灶层；已就绪则立即跳
                    try {
                        if (OverlayState.meta && OverlayState.hasDrawn) {
                            OverlayState.pendingLocate = null;
                            if (OverlayState.pendWatch) clearTimeout(OverlayState.pendWatch);
                            document.getElementById('overlaySlice').value = String(target);
                            loadOverlaySlice(target);
                            renderOverlay();
                            syncScene3dVisibility('all');
                        } else {
                            OverlayState.pendingLocate = { organ: d.organ, slice: target };
                            showToast('切片后台加载中（约5-10秒），就绪后自动跳到病灶层', 'info');
                            // ovfix: 待跳看门狗——切片始终未就绪时给出明确反馈，
                            // 避免按钮停在"取消"态、画面停在转圈却无任何提示
                            if (OverlayState.pendWatch) clearTimeout(OverlayState.pendWatch);
                            OverlayState.pendWatch = setTimeout(() => {
                                if (OverlayState.pendingLocate) {
                                    OverlayState.pendingLocate = null;
                                    showToast('切片加载超时，病灶跳转已取消，可稍后重试定位', 'warning');
                                }
                            }, 90000);
                        }
                    } catch (jerr) {
                        // ovfix: 跳转链路任何异常都要可见（此前静默失败，
                        // 表现为点了定位/补推理完成后画面不动、不跳层）
                        console.error('locate jump error:', jerr);
                        showToast('定位跳转异常：' + ((jerr && jerr.message) || jerr), 'error');
                    }
                } finally {
                    jump.disabled = false;
                    // 成功路径保持「取消」高亮；失败/无证据路径恢复「定位」
                    if (!jump.classList.contains('is-on')) jump.textContent = '定位';
                }
            });
            // 重渲染（拒绝/阈值变化）后恢复取消态
            if (OverlayState.locate && OverlayState.locate.organ === d.organ) {
                jump.classList.add('is-on');
                jump.textContent = '取消';
            }
            acts.appendChild(jump);
        }
        // 采纳：写入PDF报告。点击后在条目下方展开「影像所见」编辑器，
        // 医生填写并确认后才真正采纳；已采纳再点 = 取消采纳（所见保留）
        const acc = el('button', 'ovf-accept', '采纳');
        acc.type = 'button';
        acc.title = '采纳后写入PDF报告（影像所见选填）';
        const syncAcc = () => {
            acc.classList.toggle('is-on', d.accepted === true);
        };
        syncAcc();
        acc.addEventListener('click', (e) => {
            e.stopPropagation();
            if (d.rejected) {
                showToast('该发现已拒绝，请先恢复后再采纳', 'info');
                return;
            }
            if (d.accepted === true) {
                d.accepted = false;
                d.noteOpen = false;
                syncAcc();
                syncReportBtnLabel();
                renderOverlayFindings((AppState.currentDiagnosis || {}).diagnoses || []);
                showToast(`已取消采纳：${d.organ} ${d.finding}（不写入报告）`, 'info');
                return;
            }
            // 进入采纳流程：展开编辑器（已有所见则带入供修改）
            d.noteOpen = true;
            d.noteEditing = true;
            renderOverlayFindings((AppState.currentDiagnosis || {}).diagnoses || []);
        });
        acts.appendChild(acc);
        // 拒绝：置灰并沉到列表底部（可恢复），不再从列表删除
        const rej = el('button', d.rejected ? 'ovf-accept is-on' : 'ovf-reject',
            d.rejected ? '恢复' : '拒绝');
        rej.type = 'button';
        rej.title = d.rejected
            ? '恢复该发现：回到原位置并重新参与采纳'
            : '拒绝该发现：置灰沉底，不参与叠加与报告，可恢复';
        rej.addEventListener('click', (e) => {
            e.stopPropagation();
            setFindingRejected(d, !d.rejected);
        });
        acts.appendChild(rej);
        meta.appendChild(acts);
        item.appendChild(meta);

        // 影像所见面板：查看态（文本+编辑按钮）/ 编辑态（textarea+常用短语）
        item.appendChild(buildNotePanel(d));

        // 点击整条：向下展开/收起该发现的影像所见内容
        item.addEventListener('click', () => {
            if (d.rejected) return;   // 置灰条目不响应展开
            d.noteOpen = !d.noteOpen;
            if (d.noteOpen && !d.note) {
                // 还没写所见：直接进编辑态，省去再点一次采纳
                d.noteEditing = true;
            }
            renderOverlayFindings((AppState.currentDiagnosis || {}).diagnoses || []);
        });

        list.appendChild(item);
    });
    list.scrollTop = prevScroll;
}

// 影像所见面板。查看态显示医生确认的文本 + 「编辑」；编辑态为 textarea，
// 带常用描述短语一键插入、字数统计、Ctrl+Enter 确认。确认 = 保存所见并采纳。
function buildNotePanel(d) {
    const wrap = el('div', 'ovf-note');
    if (!d.noteOpen) { wrap.hidden = true; return wrap; }

    if (!d.noteEditing && d.note) {
        const head = el('div', 'ovf-note-head');
        head.appendChild(el('span', 'ovf-note-title', '影像所见'));
        const edit = el('button', 'ovf-note-editbtn', '编辑');
        edit.type = 'button';
        edit.addEventListener('click', (e) => {
            e.stopPropagation();
            d.noteEditing = true;
            renderOverlayFindings((AppState.currentDiagnosis || {}).diagnoses || []);
        });
        head.appendChild(edit);
        wrap.appendChild(head);
        const text = el('div', 'ovf-note-text', d.note);
        wrap.appendChild(text);
        return wrap;
    }

    // 编辑态
    const head = el('div', 'ovf-note-head');
    head.appendChild(el('span', 'ovf-note-title', d.note ? '编辑影像所见' : '填写影像所见（选填）'));
    wrap.appendChild(head);

    const ta = document.createElement('textarea');
    ta.className = 'ovf-note-input';
    ta.rows = 4;
    ta.placeholder = '描述该发现的影像表现，如：胰腺体部见类圆形低密度影，边界欠清，直径约 2.3cm，邻近胰管轻度扩张…';
    ta.value = d.note || '';
    ta.addEventListener('click', (e) => e.stopPropagation());
    wrap.appendChild(ta);

    // 常用描述短语：点击在光标处插入，减少打字
    const chips = el('div', 'ovf-note-chips');
    ['见低密度影', '边界清晰', '边界欠清', '密度均匀', '密度不均',
     '未见明显强化', '邻近结构受压', '建议结合增强检查', '建议随访复查']
        .forEach(t => {
            const c = el('button', 'ovf-note-chip', t);
            c.type = 'button';
            c.addEventListener('click', (e) => {
                e.stopPropagation();
                const s = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
                const ins = (s > 0 && ta.value[s - 1] !== '，' && ta.value[s - 1] !== '。' && s > 0) ? '，' + t : t;
                ta.value = ta.value.slice(0, s) + ins + ta.value.slice(ta.selectionEnd == null ? s : ta.selectionEnd);
                ta.focus();
                ta.selectionStart = ta.selectionEnd = s + ins.length;
                counter.textContent = `${ta.value.length} 字`;
            });
            chips.appendChild(c);
        });
    wrap.appendChild(chips);

    const foot = el('div', 'ovf-note-foot');
    const counter = el('span', 'ovf-note-count', `${ta.value.length} 字`);
    ta.addEventListener('input', () => { counter.textContent = `${ta.value.length} 字`; });
    foot.appendChild(counter);
    const cancel = el('button', 'ovf-note-cancel', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', (e) => {
        e.stopPropagation();
        d.noteEditing = false;
        d.noteOpen = !!d.note;   // 无已存所见则收起面板
        renderOverlayFindings((AppState.currentDiagnosis || {}).diagnoses || []);
    });
    const save = el('button', 'ovf-note-save', '确认采纳');
    save.type = 'button';
    save.addEventListener('click', (e) => {
        e.stopPropagation();
        // 影像所见为选填：留空也允许采纳，报告侧自行跳过空所见
        const text = ta.value.trim();
        d.note = text;
        d.noteEditing = false;
        d.noteOpen = !!text;   // 留空采纳则收起编辑器，点条目可再补填
        d.accepted = true;
        renderOverlayFindings((AppState.currentDiagnosis || {}).diagnoses || []);
        showToast(text
            ? `已采纳：${d.organ} ${d.finding}（影像所见将写入报告）`
            : `已采纳：${d.organ} ${d.finding}`, 'success');
    });
    ta.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') save.click();
    });
    foot.appendChild(cancel);
    foot.appendChild(save);
    wrap.appendChild(foot);
    return wrap;
}

// 拒绝/恢复：拒绝 = 置灰沉底 + 退出叠加受累与报告；恢复 = 回原位置。
// 不删除数据，医生可随时反悔。
function setFindingRejected(d, on) {
    d.rejected = !!on;
    if (on) {
        d.accepted = false;
        d.noteOpen = false;
        d.noteEditing = false;
    }
    refreshAffectedOverlay();
    renderOverlayFindings((AppState.currentDiagnosis || {}).diagnoses || []);
    showToast(on
        ? `已拒绝：${d.organ} ${d.finding}（置灰沉底，可恢复）`
        : `已恢复：${d.organ} ${d.finding}`, 'info');
}

// 把 OverlayState.visible 同步回图例复选框（程序化改变可见性后调用）。
// 主看片与对照窗两份图例一起同步，保证勾选态永远一致。
function syncLegendCheckboxes() {
    ['overlayLegend', 'dualLegend'].forEach(boxId => {
        const box = document.getElementById(boxId);
        if (!box) return;
        box.querySelectorAll('.overlay-legend-item').forEach((label, i) => {
            const o = OverlayState.legend[i];
            if (!o) return;
            const on = OverlayState.visible.has(o.id);
            const cb = label.querySelector('input');
            if (cb) cb.checked = on;
            label.classList.toggle('is-off', !on);
        });
    });
}

function decodePng(b64) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = 'data:image/png;base64,' + b64;
    });
}

function decodeMask(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function putOverlayCache(idx, entry) {
    OverlayState.cache.set(idx, entry);
    OverlayState.cacheOrder.push(idx);
    /* smooth-fix: 8 -> 32 层，配合邻层预取覆盖连续翻阅 */
    while (OverlayState.cacheOrder.length > 32) {
        OverlayState.cache.delete(OverlayState.cacheOrder.shift());
    }
}

/* smooth-fix: 邻层串行预取队列。翻层落地后后台拉 ±1~3 层，
   下一次滚轮通常缓存命中、同步出图，消除逐层网络往返的卡顿感。
   串行泵保证任意时刻只多占一条隧道请求，不与按需取数抢带宽。 */
const ovPrefetchQueue = [];
let ovPrefetchBusy = false;
let ovLoadInflight = false;   // 按需取数在途（滚轮合流用）
let ovPendingSlice = null;    // 在途期间滚轮记录的目标层

function prefetchAround(idx) {
    const meta = OverlayState.meta;
    if (!meta) return;
    for (const off of [1, -1, 2, -2, 3, -3]) {
        const i = idx + off;
        if (i < 0 || i >= meta.num_slices) continue;
        if (OverlayState.cache.has(i) || ovPrefetchQueue.includes(i)) continue;
        ovPrefetchQueue.push(i);
    }
    pumpPrefetch();
}

async function pumpPrefetch() {
    if (ovPrefetchBusy) return;
    ovPrefetchBusy = true;
    while (ovPrefetchQueue.length) {
        const i = ovPrefetchQueue.shift();
        if (OverlayState.cache.has(i)) continue;
        try {
            await fetchOverlaySliceEntry(i);
        } catch (e) { /* 预取失败静默，不影响主链路 */ }
    }
    ovPrefetchBusy = false;
}

// 拉取并解码单层叠加数据（主看片与对照阅片双窗共用），顺带写入主缓存
async function fetchOverlaySliceEntry(idx) {
    const resp = await fetch(
        `/api/overlay/${encodeURIComponent(OverlayState.fileId)}/slice/${idx}`
        + `?mode=${encodeURIComponent(OverlayState.segSource)}`
    );
    const data = await resp.json();
    if (!data.success) throw new Error(data.message || '切片获取失败');
    const [ct, mask] = await Promise.all([
        decodePng(data.ct),
        Promise.resolve(decodeMask(data.mask)),
    ]);
    const entry = { ct, mask, width: data.width, height: data.height };
    putOverlayCache(idx, entry);
    return entry;
}

async function loadOverlaySlice(idx) {
    const meta = OverlayState.meta;
    if (!meta) return;
    OverlayState.slice = idx;
    document.getElementById('overlaySliceVal').textContent = `${idx + 1} / ${meta.num_slices}`;
    // 单窗「原始序列」模式与对照双窗共用 DualState 缓存：后台预取，切来源时即时出图
    loadDualSlice(idx);

    if (OverlayState.cache.has(idx)) {
        OverlayState.current = OverlayState.cache.get(idx);
        renderOverlay();
        updateSrcLabel();
        /* smooth-fix: 缓存命中同步出图；顺带复位在途标记
           （在途旧请求的结果已被 loadSeq 作废，其 finally 不再复位） */
        ovLoadInflight = false;
        ovPendingSlice = null;
        prefetchAround(idx);
        return;
    }

    const token = ++OverlayState.loadSeq;
    ovLoadInflight = true;
    // 主窗已有画面（原始占位/旧切片）时不盖遮罩：翻层/首轮取数静默替换
    setOverlayLoading(!OverlayState.hasDrawn);
    try {
        const entry = await fetchOverlaySliceEntry(idx);
        if (token !== OverlayState.loadSeq) return; // 已有更新的请求，丢弃本次渲染
        OverlayState.current = entry;
        renderOverlay();
        updateSrcLabel();
    } catch (e) {
        console.error('loadOverlaySlice error:', e);
    } finally {
        if (token === OverlayState.loadSeq) {
            setOverlayLoading(false);
            ovLoadInflight = false;
            prefetchAround(idx);
            /* smooth-fix: 排空在途期间滚轮记录的目标层 */
            const p = ovPendingSlice;
            ovPendingSlice = null;
            if (p !== null && p !== OverlayState.slice) loadOverlaySlice(p);
        }
    }
}

// 单窗来源切换：同一展示窗口在 AI 叠加与原始序列切片间来回切换。
// 原始切片复用对照双窗的取数链路（DualState 缓存），层号映射关系不变。
function setOverlaySource(src) {
    if (src === 'orig' && OverlayState.srcFailed) {
        showToast('原始序列映射不可用（无对应原始切片）', 'warning');
        return;
    }
    if (OverlayState.src === src) return;
    OverlayState.src = src;
    updateSrcToggleUi();
    renderOverlay();
    updateSrcLabel();
}

function updateSrcToggleUi() {
    document.querySelectorAll('#overlaySrcToggle .mode-btn').forEach(b => {
        b.classList.toggle('is-active', b.dataset.src === OverlayState.src);
    });
}

// 按钮旁的层号标记：标明当前窗口显示的是哪个序列的第几张
function updateSrcLabel() {
    const lab = document.getElementById('overlaySrcLabel');
    if (!lab) return;
    const meta = OverlayState.meta;
    if (!meta) { lab.textContent = ''; return; }
    if (OverlayState.src === 'orig') {
        const e = DualState.cache.get(OverlayState.slice) || DualState.entry;
        if (e && e.origIndex != null) {
            lab.textContent = `${e.nearest ? '最近原图' : '原始序列'} 第 ${e.origIndex + 1} / ${e.origSlices} 张`;
            return;
        }
        lab.textContent = '原始序列 层号映射中…';
        return;
    }
    lab.textContent = `处理序列 第 ${OverlayState.slice + 1} / ${meta.num_slices} 层`;
}

function isBoundary(mask, p, x, y, w, h) {
    const lab = mask[p];
    if (x > 0 && mask[p - 1] !== lab) return true;
    if (x < w - 1 && mask[p + 1] !== lab) return true;
    if (y > 0 && mask[p - w] !== lab) return true;
    if (y < h - 1 && mask[p + w] !== lab) return true;
    return false;
}

// 注意力热力配色：置信度 0→1 走 蓝→青→绿→黄→红（与图例渐变一致）
function heatColor(t) {
    const c = Math.min(1, Math.max(0, t));
    const stops = [
        [0.0, 0, 64, 255],
        [0.25, 0, 220, 255],
        [0.5, 80, 255, 80],
        [0.75, 255, 230, 0],
        [1.0, 255, 40, 0],
    ];
    for (let i = 1; i < stops.length; i++) {
        if (c <= stops[i][0]) {
            const [p0, r0, g0, b0] = stops[i - 1];
            const [p1, r1, g1, b1] = stops[i];
            const k = (c - p0) / (p1 - p0);
            return [
                r0 + (r1 - r0) * k,
                g0 + (g1 - g0) * k,
                b0 + (b1 - b0) * k,
            ];
        }
    }
    return [255, 40, 0];
}

function renderOverlay() {
    const canvas = document.getElementById('overlayCanvas');
    const cur = OverlayState.current;
    // 处理序列切片就绪前主窗保持空舞台：首帧即处理序列，不做占位画面，
    // 避免「先小后大」的尺寸跳变
    if (!canvas || !cur) return;
    applyMainPhysScale();
    // 单窗来源为原始序列时：主窗口直接画原始切片（叠加/定位标注同规则）
    if (OverlayState.src === 'orig') {
        const e = DualState.cache.get(OverlayState.slice) || DualState.entry;
        if (e && e.ct) {
            compositeSliceTo(canvas, e.ct, e.mask, e.width, e.height, e.nearest);
            renderDual();
            return;
        }
        // 原始切片尚未就绪：先以 AI 层占位，加载完成后 loadDualSlice 会重渲染
    }
    compositeSliceTo(canvas, cur.ct, cur.mask, cur.width, cur.height);
    OverlayState.hasDrawn = true;
    // 对照阅片双窗跟随主看片渲染（翻层/叠加来源/器官可见性/定位变化）
    renderDual();
}

// 把单层 CT + 器官标签合成到指定 canvas：主看片与「原始序列对照」双窗共用
function compositeSliceTo(canvas, ct, mask, width, height, plain = false) {
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(ct, 0, 0, width, height);
    if (plain) return;

    const rmode = OverlayState.renderMode;
    if (rmode === 'ct') {
        if (OverlayState.src === 'orig' && OverlayState.srcFailed) {
            ctx.save();
            ctx.fillStyle = 'rgba(255, 193, 7, 0.9)';
            ctx.font = '12px sans-serif';
            ctx.fillText('该层无对应原始切片', 8, 18);
            ctx.restore();
            return;
        }
        drawLocateAnnotation(ctx, width, height, mask);
        return;
    }

    const base = ctx.getImageData(0, 0, width, height);
    const out = ctx.createImageData(width, height);
    out.data.set(base.data);
    const d = out.data;

    const palette = {};
    OverlayState.legend.forEach(o => { palette[o.id] = o.color; });
    // 热力模式：器官标签 -> 该器官最高置信度（无诊断项的器官不上色）
    const heatConf = {};
    OverlayState.legend.forEach(o => {
        const c = OverlayState.organConfidence.get(o.name);
        if (c != null) heatConf[o.id] = c;
    });
    const alpha = OverlayState.opacity;
    const contour = rmode === 'contour';
    const heat = rmode === 'heat';

    // 热力模式：一次性算出「每个像素到器官内部核心的距离」，中心浓、
    // 边缘淡（羽化），避免色块生硬切割 CT 纹理。按切片缓存。
    let distMap = null;
    if (heat && Object.keys(heatConf).length) {
        distMap = getOverlayDistMap();
    }

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            const lab = mask[p];
            if (lab === 0 || !OverlayState.visible.has(lab)) continue;
            if (contour && !isBoundary(mask, p, x, y, width, height)) continue;
            const i = p * 4;
            if (heat) {
                // 只渲染有阳性诊断项的器官
                const conf = heatConf[lab];
                if (conf == null) continue;
                const falloff = Math.min(1, distMap[p] / 6);
                const c = heatColor(conf);
                const a = alpha * (0.45 + 0.55 * falloff);
                d[i]     = d[i]     * (1 - a) + c[0] * a;
                d[i + 1] = d[i + 1] * (1 - a) + c[1] * a;
                d[i + 2] = d[i + 2] * (1 - a) + c[2] * a;
            } else if (contour) {
                const c = palette[lab] || [255, 0, 255];
                d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
            } else {
                const c = palette[lab] || [255, 0, 255];
                d[i]     = d[i]     * (1 - alpha) + c[0] * alpha;
                d[i + 1] = d[i + 1] * (1 - alpha) + c[1] * alpha;
                d[i + 2] = d[i + 2] * (1 - alpha) + c[2] * alpha;
            }
        }
    }
    ctx.putImageData(out, 0, 0);
    // 单窗原始序列模式：映射不可用（补零区/无 NIfTI）时提示并熄灭标注
    if (OverlayState.src === 'orig' && OverlayState.srcFailed) {
        ctx.save();
        ctx.fillStyle = 'rgba(255, 193, 7, 0.9)';
        ctx.font = '12px sans-serif';
        ctx.fillText('该层无对应原始切片', 8, 18);
        ctx.restore();
        return;
    }
    drawLocateAnnotation(ctx, width, height, mask);
}

// 「定位」跳转标注：在定位切片上给目标器官画红色轮廓+名称标签。
// 不自动过期：再次点击同一条发现的「取消」才清除；手动翻离定位层时
// 标注自动隐藏（状态保留，翻回来又见）。
function ensureLocateLabel() {
    let el = document.getElementById('locateLabel');
    if (!el) {
        const stage = document.getElementById('overlayStage');
        if (!stage) return null;
        el = document.createElement('div');
        el.id = 'locateLabel';
        el.className = 'locate-label';
        stage.appendChild(el);
    }
    return el;
}

// locate-label: 器官名称用 DOM 标签显示（矢量文字，放大不糊），锚点按
// canvas 变换后包围盒线性映射，缩放/平移由 applyViewTransforms 同步。
function syncLocateLabel() {
    const el = document.getElementById('locateLabel');
    if (!el) return;
    const loc = OverlayState.locate;
    const canvas = document.getElementById('overlayCanvas');
    const stage = document.getElementById('overlayStage');
    if (!loc || !loc.anchor || !canvas || !stage
        || OverlayState.slice !== loc.slice) {
        el.style.display = 'none';
        return;
    }
    const cr = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const bw = canvas.width, bh = canvas.height;
    if (cr.width < 2 || !bw || !bh) { el.style.display = 'none'; return; }
    const x = cr.left - sr.left + (loc.anchor.x + 0.5) * cr.width / bw;
    const y = cr.top - sr.top + (loc.anchor.y + 0.5) * cr.height / bh;
    el.textContent = loc.names.join(' / ');
    el.style.display = 'block';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
}

function drawLocateAnnotation(ctx, width, height, mask) {
    const loc = OverlayState.locate;
    // locate-label: 红色轮廓已去除，仅计算标签锚点（器官边界最上像素）
    if (!loc || !loc.ids.size || OverlayState.slice !== loc.slice) {
        const gone = document.getElementById('locateLabel');
        if (gone) gone.style.display = 'none';
        return;
    }
    const total = width * height;
    const inSet = (q) => q >= 0 && q < total && loc.ids.has(mask[q]);
    let topY = height, topX = 0, any = false;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (!loc.ids.has(mask[p])) continue;
            if (!inSet(p - 1) || !inSet(p + 1) || !inSet(p - width) || !inSet(p + width)) {
                any = true;
                if (y < topY || (y === topY && x < topX)) { topY = y; topX = x; }
            }
        }
    }
    if (!any) {
        const gone = document.getElementById('locateLabel');
        if (gone) gone.style.display = 'none';
        return;
    }
    loc.anchor = { x: topX, y: topY };
    ensureLocateLabel();
    syncLocateLabel();
}

// 当前切片的羽化距离图（Uint8，值=到异标签的切比雪夫距离，封顶 8）。
// 两遍扫描（左上→右下、右下→左上）近似距离变换，O(W*H)，随切片缓存。
function getOverlayDistMap() {
    const cur = OverlayState.current;
    if (cur.distMap) return cur.distMap;
    const { mask, width: w, height: h } = cur;
    const CAP = 8;
    const dist = new Uint8Array(w * h);
    // 第一遍：边界像素置 0，其余先置 CAP
    for (let p = 0; p < w * h; p++) {
        dist[p] = isBoundary(mask, p, p % w, Math.floor(p / w), w, h) ? 0 : CAP;
    }
    // 左上→右下
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = y * w + x;
            let v = dist[p];
            if (x > 0) v = Math.min(v, dist[p - 1] + 1);
            if (y > 0) v = Math.min(v, dist[p - w] + 1);
            dist[p] = v;
        }
    }
    // 右下→左上
    for (let y = h - 1; y >= 0; y--) {
        for (let x = w - 1; x >= 0; x--) {
            const p = y * w + x;
            let v = dist[p];
            if (x < w - 1) v = Math.min(v, dist[p + 1] + 1);
            if (y < h - 1) v = Math.min(v, dist[p + w] + 1);
            dist[p] = v > CAP ? CAP : v;
        }
    }
    cur.distMap = dist;
    return dist;
}

function handleOverlayHover(e) {
    const tip = document.getElementById('overlayCursorTip');
    if (!tip) return;
    // 单窗原始序列模式：画布画的是原始切片，悬停取数也用原始 entry
    const origEntry = OverlayState.src === 'orig'
        ? (DualState.cache.get(OverlayState.slice) || DualState.entry) : null;
    const cur = (OverlayState.src === 'orig' && origEntry && origEntry.ct)
        ? origEntry : OverlayState.current;
    if (!cur) return;
    const canvas = document.getElementById('overlayCanvas');
    const rect = canvas.getBoundingClientRect();
    const px = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width));
    const py = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height));
    if (px < 0 || py < 0 || px >= cur.width || py >= cur.height) {
        tip.style.display = 'none';
        return;
    }
    const lab = cur.mask[py * cur.width + px];
    const organ = OverlayState.legend.find(o => o.id === lab);
    const name = cur.nearest ? '未叠加分割' : (lab === 0 ? '背景' : (organ ? organ.name : `器官${lab}`));
    // 单窗原始序列模式：层号用原始序列映射层，与按钮旁标记一致
    const layerTxt = origEntry && origEntry.origIndex != null
        ? `原始第 ${origEntry.origIndex + 1} 张` : `层 ${OverlayState.slice + 1}`;
    tip.textContent = `${name} · ${layerTxt} · (${px}, ${py})`;
    tip.style.display = 'block';
    const stageRect = document.getElementById('overlayStage').getBoundingClientRect();
    tip.style.left = (e.clientX - stageRect.left + 14) + 'px';
    tip.style.top = (e.clientY - stageRect.top + 14) + 'px';
}

// 播放按钮主/对照窗各一个，状态共享：任一处播放/暂停，两边文案同步
function overlayPlayBtns() {
    return ['overlayPlayBtn', 'dualPlayBtn']
        .map(id => document.getElementById(id)).filter(Boolean);
}

function toggleOverlayPlay() {
    if (OverlayState.playTimer) {
        stopOverlayPlay();
    } else {
        overlayPlayBtns().forEach(b => { b.textContent = '⏸ 暂停'; });
        OverlayState.playTimer = setInterval(() => {
            const n = OverlayState.meta.num_slices;
            const next = (OverlayState.slice + 1) % n;
            document.getElementById('overlaySlice').value = String(next);
            loadOverlaySlice(next);
        }, 180);
    }
}

function stopOverlayPlay() {
    if (OverlayState.playTimer) {
        clearInterval(OverlayState.playTimer);
        OverlayState.playTimer = null;
        overlayPlayBtns().forEach(b => { b.textContent = '▶ 播放'; });
    }
}

function setOverlayOrgans(which) {
    const affectedOn = which === 'affected' && OverlayState.affectedIds.size > 0;
    // 记录当前范围模式：拒绝/恢复刷新叠加时据此保持「只看受累」语义
    OverlayState.organMode = affectedOn ? 'affected' : 'all';
    // 定位隔离期间手动改范围 = 用户接管可见性：丢弃快照，取消定位不再回滚
    OverlayState.prevVisible = null;
    if (affectedOn) {
        OverlayState.visible = new Set(OverlayState.affectedIds);
    } else {
        OverlayState.visible = new Set(OverlayState.legend.map(o => o.id));
    }
    // 当前范围在工具条按钮上高亮（主看片 + 对照窗两处按钮一起同步）
    [['overlayAllOrgansBtn', 'dualAllOrgansBtn'],
     ['overlayAffectedBtn', 'dualAffectedBtn']].forEach(pair => {
        pair.forEach(id => {
            const b = document.getElementById(id);
            if (b) b.classList.toggle('is-active', id.includes('Affected') ? affectedOn : !affectedOn);
        });
    });
    syncLegendCheckboxes();
    renderOverlay();
    syncScene3dVisibility();
}

// ------------------------------------------------------------------ //
// 3D 重建模式：three.js 表面网格渲染（marching cubes 网格来自后端）
// ------------------------------------------------------------------ //

function loadThree() {
    if (window.THREE) return Promise.resolve(window.THREE);
    if (OverlayState.threeLoading) return OverlayState.threeLoading;
    OverlayState.threeLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js';
        s.onload = () => resolve(window.THREE);
        s.onerror = () => {
            OverlayState.threeLoading = null;
            reject(new Error('three.js 加载失败（需联网）'));
        };
        document.head.appendChild(s);
    });
    return OverlayState.threeLoading;
}

// hostId 参数化：主看片与对照窗各持一个独立 3D 场景（各自相机/网格），
// 状态分别存 OverlayState.scene3d / DualState.scene3d，互不干扰
function initScene3d(hostId = 'overlayStage3d') {
    const THREE = window.THREE;
    const host = document.getElementById(hostId);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070c);
    const camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);
    // 世界坐标为患者 RAS 物理空间：+z 为头侧，相机 up 必须对齐 +z，
    // 否则默认 +y up 会让人体横躺
    camera.up.set(0, 0, 1);
    scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(1, 1.4, 1);
    scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0x8899ff, 0.5);
    dir2.position.set(-1, -0.6, -1);
    scene.add(dir2);

    const group = new THREE.Group();
    scene.add(group);

    const state = {
        THREE, renderer, scene, camera, group, hostId,
        meshes: new Map(),       // organId -> THREE.Mesh
        yaw: 0.6, pitch: 0.35, dist: 0, target: new THREE.Vector3(),
        panX: 0, panY: 0, built: false,
    };

    // 手工轨道控制：左键旋转、右键平移、滚轮缩放
    const dom = renderer.domElement;
    let drag = null;
    dom.addEventListener('contextmenu', e => e.preventDefault());
    dom.addEventListener('pointerdown', e => {
        drag = { x: e.clientX, y: e.clientY, btn: e.button };
        dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', e => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX; drag.y = e.clientY;
        if (drag.btn === 2) {
            state.panX -= dx * state.dist * 0.0012;
            state.panY += dy * state.dist * 0.0012;
        } else {
            state.yaw -= dx * 0.006;
            state.pitch = Math.min(1.45, Math.max(-1.45, state.pitch + dy * 0.006));
        }
        updateCamera3d();
    });
    dom.addEventListener('pointerup', () => { drag = null; });
    dom.addEventListener('wheel', e => {
        e.preventDefault();
        state.dist *= e.deltaY > 0 ? 1.1 : 0.9;
        state.dist = Math.min(3000, Math.max(60, state.dist));
        updateCamera3d();
    }, { passive: false });

    function updateCamera3d() {
        const t = state.target;
        // 轨道参数：yaw 绕头轴(+z)旋转，pitch 为相对横断面的仰角；
        // yaw=0/pitch=0 即正前位（相机在 -y 侧朝 +y 看，up=+z）
        const right = { x: Math.cos(state.yaw), y: Math.sin(state.yaw), z: 0 };
        const ox = state.panX * right.x;
        const oy = state.panX * right.y;
        const oz = state.panY;
        camera.position.set(
            t.x + ox + state.dist * Math.cos(state.pitch) * Math.sin(state.yaw),
            t.y + oy - state.dist * Math.cos(state.pitch) * Math.cos(state.yaw),
            t.z + oz + state.dist * Math.sin(state.pitch),
        );
        camera.lookAt(t.x + ox, t.y + oy, t.z + oz);
    }
    state.updateCamera = updateCamera3d;

    function resize() {
        const w = host.clientWidth, h = host.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    state.resize = resize;
    new ResizeObserver(resize).observe(host);
    resize();
    updateCamera3d();

    (function loop() {
        requestAnimationFrame(loop);
        if (host.hidden) return;
        renderer.render(scene, camera);
    }());

    if (hostId === 'overlayStage3d') OverlayState.scene3d = state;
    else DualState.scene3d = state;
    return state;
}

// 用 canvas 画一块带文字的气泡，做成 three.js 精灵，作为 3D 病灶标注。
// depthTest:false + 高 renderOrder，保证标签始终浮在器官表面之上、不被遮挡。
function makeLabelSprite(THREE, lines, opts = {}) {
    const pad = 18, lineH = 46, fontSize = 40;
    const font = `bold ${fontSize}px "Microsoft YaHei","PingFang SC",sans-serif`;
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = font;
    let textW = 0;
    lines.forEach(l => { textW = Math.max(textW, probe.measureText(l).width); });
    const w = Math.ceil(textW + pad * 2 + 8);
    const h = Math.ceil(lines.length * lineH + pad * 2);

    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    // 圆角背景
    const r = 16;
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.arcTo(w, 0, w, h, r); ctx.arcTo(w, h, 0, h, r);
    ctx.arcTo(0, h, 0, 0, r); ctx.arcTo(0, 0, w, 0, r); ctx.closePath();
    ctx.fillStyle = opts.bg || 'rgba(9,17,30,0.86)';
    ctx.fill();
    // 左侧强调色条
    if (opts.accent) { ctx.fillStyle = opts.accent; ctx.fillRect(0, 0, 7, h); }
    ctx.font = font; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    lines.forEach((l, i) => {
        ctx.fillStyle = i === 0 ? '#ffffff' : (opts.subColor || '#ffcf4d');
        ctx.fillText(l, pad + 4, pad + lineH * i + lineH / 2);
    });

    const tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, depthTest: false, transparent: true,
    }));
    const hh = opts.height || 34;   // 标签世界高度
    sprite.scale.set(hh * w / h, hh, 1);
    sprite.renderOrder = 999;
    return sprite;
}

// which: 'main' | 'dual'。两窗 3D 各自构建/缓存（scene3dSource 分别记录），
// 网格数据同源（后端 /mesh），但场景实例独立，可各自旋转观察
async function buildScene3d(which = 'main') {
    const isDual = which === 'dual';
    const loading = document.getElementById(isDual ? 'dualStage3dLoading' : 'stage3dLoading');
    const errBox = document.getElementById(isDual ? 'dualStage3dError' : 'stage3dError');
    const src = OverlayState.segSource;
    const owned = isDual ? DualState.scene3d : OverlayState.scene3d;
    const ownedSrc = isDual ? DualState.scene3dSource : OverlayState.scene3dSource;
    // 已构建且来源未变则只同步可见性，避免重复拉网格
    if (owned && owned.built && ownedSrc === src) {
        syncScene3dVisibility(which);
        return;
    }
    errBox.hidden = true;
    loading.hidden = false;
    try {
        // 必须先加载 three.js 再初始化场景：initScene3d 依赖 window.THREE，
        // 旧代码在其之前调用会因 THREE 未定义抛错，导致 3D 永远卡在加载态。
        await loadThree();
        const state = owned || initScene3d(isDual ? 'dualStage3d' : 'overlayStage3d');
        // 切换分割来源时清空旧网格，重新拉取对应来源的网格
        if (state.built) {
            state.meshes.forEach(mesh => {
                mesh.children.forEach(c => {
                    if (c.material) {
                        if (c.material.map) c.material.map.dispose();
                        c.material.dispose();
                    }
                });
                mesh.geometry.dispose();
                mesh.material.dispose();
            });
            state.meshes.clear();
            state.group.clear();
            state.built = false;
        }
        const resp = await fetch(
            `/api/overlay/${encodeURIComponent(OverlayState.fileId)}/mesh?mode=${encodeURIComponent(src)}`
        );
        if (!resp.ok) {
            const detail = await resp.json().catch(() => ({}));
            throw new Error(detail.message || `网格获取失败（HTTP ${resp.status}）`);
        }
        // 二进制网格：[u32 headLen][u32 blobLen][head JSON utf8][blob]
        // blob 内各器官顶点（uint16，0.1 体素量化）与面片（uint16/uint32）顺序拼接
        const buf = await resp.arrayBuffer();
        const dv = new DataView(buf);
        const headLen = dv.getUint32(0, true);
        const data = JSON.parse(new TextDecoder().decode(
            new Uint8Array(buf, 8, headLen)));
        if (!data.success) throw new Error(data.message || '网格获取失败');
        const blob = new Uint8Array(buf, 8 + headLen);
        const THREE = state.THREE;
        // 顶点已是患者世界坐标（RAS mm，相对 m.origin）：+x 左 / +y 前 /
        // +z 头，轴向与间距全由后端真实几何（DICOM affine）决定，前端不再
        // 做任何 spacing/轴向约定换算
        const org = data.origin || [0, 0, 0];
        let count = 0;
        data.meshes.forEach(m => {
            // slice 拷贝到独立 ArrayBuffer：blob 绝对偏移未必满足 TypedArray
            // 对齐要求（尤其 uint32 面片），拷贝后从字节 0 起天然对齐
            const nv = m.nverts;
            const pos = new Float32Array(nv * 3);
            if (m.q) {
                const vq = new Uint16Array(
                    blob.slice(m.voff, m.voff + m.flen).buffer);
                for (let i = 0; i < nv; i++) {
                    const j = i * 3;
                    pos[j] = org[0] + vq[j] * 0.1;
                    pos[j + 1] = org[1] + vq[j + 1] * 0.1;
                    pos[j + 2] = org[2] + vq[j + 2] * 0.1;
                }
            } else {
                const vf = new Float32Array(
                    blob.slice(m.voff, m.voff + m.flen).buffer);
                for (let i = 0; i < nv * 3; i++) pos[i] = vf[i];
            }
            const fLen = m.nfaces * 3 * (m.f32 ? 4 : 2);
            const fBuf = blob.slice(m.foff, m.foff + fLen).buffer;
            const faces = m.f32 ? new Uint32Array(fBuf) : new Uint16Array(fBuf);
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            geo.setIndex(new THREE.BufferAttribute(faces, 1));
            geo.computeVertexNormals();
            geo.computeBoundingBox();

            // 病灶标注：受累器官按诊断置信度走热力色并加悬浮标签，
            // 其余器官降透明度作为解剖背景，突出模型发现的病灶。
            // id=0 为后端从 CT 灰度提取的体表轮廓，常驻极低透明度作解剖参照。
            const isBody = m.id === 0;
            const isLesion = !isBody && OverlayState.affectedIds.has(m.id);
            const conf = OverlayState.organConfidence.get(m.name);
            let color, opacity;
            if (isBody) {
                color = new THREE.Color(`rgb(${m.color.join(',')})`);
                opacity = 0.10;
            } else if (isLesion && conf != null) {
                const rgb = heatColor(conf);
                color = new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
                opacity = 0.97;
            } else {
                color = new THREE.Color(`rgb(${m.color.join(',')})`);
                opacity = 0.22;
            }
            const mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
                color, transparent: true, opacity, side: THREE.DoubleSide,
                shininess: isLesion ? 42 : 18,
                specular: new THREE.Color(isLesion ? 0x303030 : 0x141414),
                depthWrite: !isLesion && !isBody,  // 半透明层不写深度，避免遮挡标签
            }));
            mesh.name = m.name;
            mesh.userData.lesion = isLesion;

            if (isLesion) {
                const d = OverlayState.organFinding.get(m.name) || {};
                const rgb = heatColor(conf == null ? 0.5 : conf);
                const accent = `rgb(${rgb.map(x => Math.round(x)).join(',')})`;
                const label = makeLabelSprite(THREE, [
                    m.name,
                    `${d.finding || '异常发现'} ${conf != null ? pct(conf) : ''}`.trim(),
                ], { accent });
                // 定位到该器官包围盒顶部中心（世界坐标 +z 为头侧）
                const bb = geo.boundingBox;
                label.position.set(
                    (bb.min.x + bb.max.x) / 2,
                    (bb.min.y + bb.max.y) / 2,
                    bb.max.z + 12,
                );
                mesh.add(label);   // 作为器官子节点：器官隐藏时标签一并隐藏
            }

            state.group.add(mesh);
            state.meshes.set(m.id, mesh);
            count += 1;
        });
        if (!count) throw new Error('没有可重建的器官网格');
        const box = new THREE.Box3().setFromObject(state.group);
        const center = new THREE.Vector3();
        box.getCenter(center);
        state.target.copy(center);
        state.dist = box.getSize(new THREE.Vector3()).length() * 1.35;
        state.updateCamera();
        state.built = true;
        if (isDual) DualState.scene3dSource = src;
        else OverlayState.scene3dSource = src;
        syncScene3dVisibility(which);
    } catch (e) {
        console.error('3D 重建失败:', e);
        errBox.textContent = (e && e.message) ? e.message : String(e);
        errBox.hidden = false;
    } finally {
        loading.hidden = true;
    }
}

// which: 'main' | 'dual' | 'all'（图例勾选等全局操作时两场景一起同步）
function syncScene3dVisibility(which = 'main') {
    const targets = which === 'all'
        ? [OverlayState.scene3d, DualState.scene3d]
        : [which === 'dual' ? DualState.scene3d : OverlayState.scene3d];
    targets.forEach(state => {
        if (!state || !state.built) return;
        const loc = OverlayState.locate;
        state.meshes.forEach((mesh, id) => {
            // id=0 体表轮廓常驻显示，不受器官图例勾选影响
            if (id === 0) {
                mesh.visible = true;
                return;
            }
            if (!OverlayState.visible.has(id)) {
                mesh.visible = false;
                return;
            }
            // 病灶器官（受累于诊断）在 3D 中默认隐藏，需点发现列表的「定位」
            // 才显示对应病灶，避免一进 3D 所有病灶标签糊满屏；
            // 非病灶器官按图例勾选常态显示
            mesh.visible = mesh.userData.lesion
                ? !!(loc && loc.ids && loc.ids.has(id))
                : true;
        });
    });
}

async function setOverlayMode(mode) {
    if (OverlayState.mode === mode) return;
    OverlayState.mode = mode;
    document.querySelectorAll('#overlayModeToggle .mode-btn').forEach(b => {
        b.classList.toggle('is-active', b.dataset.mode === mode);
    });
    const stage2d = document.getElementById('overlayStage');
    const stage3d = document.getElementById('overlayStage3d');
    const hint = document.getElementById('overlayHint');
    if (mode === '3d') {
        stage2d.hidden = true;
        stage3d.hidden = false;
        hint.textContent = '拖拽旋转 · 滚轮缩放 · 右键平移';
        stopOverlayPlay();
        await buildScene3d();
    } else {
        stage3d.hidden = true;
        stage2d.hidden = false;
        hint.textContent = '滚轮/↑↓翻层 · 悬停查看器官 · 图例可跳转';
        renderOverlay();
    }
}

function bindOverlayEvents() {
    if (OverlayState.bound) return;
    OverlayState.bound = true;

    // 舞台尺寸变化（浏览器窗口缩放 / 拖右下角手柄拉伸看片窗口）：
    // 重算适配倍数，画面保持居中铺满；用户手动缩放后只重钳制平移
    const stageEl = document.getElementById('overlayStage');
    if (stageEl && typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => applyFitScale()).observe(stageEl);
    } else {
        window.addEventListener('resize', () => applyFitScale());
    }
    // jitter-fix: 真实窗口 resize 才解锁舞台盒并重算一次自适应
    window.addEventListener('resize', () => { unlockStageSize(); applyFitScale(); });

    // 控制面板抽屉：向右收起 / 向左展开，收起后看片舞台增大可视化面积；
    // 舞台尺寸变化由上面的 ResizeObserver 自动重适配
    const sideToggle = document.getElementById('overlaySideToggle');
    if (sideToggle) {
        sideToggle.addEventListener('click', () => {
            const body = sideToggle.closest('.overlay-body');
            if (!body) return;
            const collapsed = body.classList.toggle('side-collapsed');
            // drawer-fix4: 过渡期内解锁舞台盒并逐帧重适配；手动缩放过的视图
            // 按舞台宽度变化比例同步缩放，画布始终跟随抽屉收展变宽/复原，
            // 结束后重新锁定，外窗宽度保持不变
            OverlayState.liveFitUntil = Date.now() + 700;
            unlockStageSize();
            const stageBox = document.getElementById('overlayStage');
            let lastW = stageBox ? stageBox.clientWidth : 0;
            const t0 = performance.now();
            const tick = () => {
                const w = stageBox ? stageBox.clientWidth : lastW;
                if (OverlayState.userZoomed && OverlayState.view
                        && lastW > 0 && w > 0 && w !== lastW) {
                    const r = w / lastW;
                    OverlayState.view.s *= r;
                    OverlayState.view.tx *= r;
                    OverlayState.view.ty *= r;
                }
                applyFitScale();
                lastW = w;
                if (performance.now() - t0 < 550) requestAnimationFrame(tick);
                else { OverlayState.liveFitUntil = 0; unlockStageSize(); applyFitScale(); }
            };
            requestAnimationFrame(tick);
            sideToggle.textContent = collapsed ? '«' : '»';
            sideToggle.title = collapsed ? '展开控制面板' : '收起控制面板';
        });
    }

    const sliceInput = document.getElementById('overlaySlice');
    sliceInput.addEventListener('input', () => {
        stopOverlayPlay();
        loadOverlaySlice(parseInt(sliceInput.value, 10));
    });

    const opacity = document.getElementById('overlayOpacity');
    opacity.addEventListener('input', () => {
        OverlayState.opacity = parseInt(opacity.value, 10) / 100;
        document.getElementById('overlayOpacityVal').textContent = opacity.value + '%';
        renderOverlay();
    });

    const segSource = document.getElementById('overlaySegSource');
    if (segSource) {
        segSource.addEventListener('change', async () => {
            OverlayState.segSource = segSource.value;
            OverlayState.cache.clear();
            OverlayState.cacheOrder = [];
            OverlayState.current = null;
            // 分割换了来源，原始窗的映射标签也要按新 mask 重拉
            DualState.cache.clear();
            DualState.entry = null;
            DualState.slice = -1;
            OverlayState.srcFailed = false;
            await loadOverlaySlice(OverlayState.slice);
            // 3D 已构建时按新来源重建网格
            if (OverlayState.mode === '3d') await buildScene3d();
        });
    }

    const mode = document.getElementById('overlayMode');
    mode.addEventListener('change', () => {
        OverlayState.renderMode = mode.value;
        const heatLegend = document.getElementById('overlayHeatLegend');
        if (heatLegend) heatLegend.hidden = mode.value !== 'heat';
        // 热力模式默认只看受累器官，突出模型关注区域
        if (mode.value === 'heat' && OverlayState.affectedIds.size > 0) {
            setOverlayOrgans('affected');
        } else {
            renderOverlay();
        }
    });

    // 单窗来源切换：AI叠加 ↔ 原始序列（3D 重建下无切片概念，忽略）
    document.querySelectorAll('#overlaySrcToggle .mode-btn').forEach(b => {
        b.addEventListener('click', () => {
            if (OverlayState.mode === '3d') {
                showToast('3D 重建模式下无切片来源概念，请先切回 2D 切片', 'info');
                return;
            }
            setOverlaySource(b.dataset.src);
        });
    });

    const stage = document.getElementById('overlayStage');
    const canvas = document.getElementById('overlayCanvas');
    // 滚轮：默认翻层；Ctrl/Meta+滚轮 = 以光标为锚点缩放（与浏览器习惯一致）
    stage.addEventListener('wheel', (e) => {
        if (!OverlayState.meta) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
            const r = stage.getBoundingClientRect();
            zoomOverlayAt(e.clientX - r.left, e.clientY - r.top,
                e.deltaY < 0 ? 1.2 : 1 / 1.2);
            return;
        }
        stopOverlayPlay();
        const dir = e.deltaY > 0 ? 1 : -1;
        /* smooth-fix: 取数在途时以 pending 目标层为基准累加，
           连续滚轮不丢层；完成后串行排空，避免并发请求挤爆隧道 */
        const base = (ovPendingSlice !== null) ? ovPendingSlice : OverlayState.slice;
        const next = Math.min(OverlayState.meta.num_slices - 1, Math.max(0, base + dir));
        if (next !== base) {
            sliceInput.value = String(next);
            if (ovLoadInflight) ovPendingSlice = next;
            else loadOverlaySlice(next);
        }
    }, { passive: false });

    // 拖拽平移（放大后查看局部）：按下记起点，移动改 tx/ty，松开结束。
    // 未溢出舞台时平移被钳制为 0，不影响悬停查看器官
    canvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        OverlayState.drag = { x: e.clientX, y: e.clientY, tx: OverlayState.view.tx, ty: OverlayState.view.ty };
    });
    window.addEventListener('mousemove', (e) => {
        const d = OverlayState.drag;
        if (!d) return;
        setOverlayView(OverlayState.view.s, d.tx + (e.clientX - d.x), d.ty + (e.clientY - d.y));
    });
    window.addEventListener('mouseup', () => { OverlayState.drag = null; });
    // 双击复位：回到适配倍数的居中视图
    canvas.addEventListener('dblclick', () => resetOverlayView());

    // 缩放工具条：+/−/复位
    const zin = document.getElementById('overlayZoomIn');
    const zout = document.getElementById('overlayZoomOut');
    const zreset = document.getElementById('overlayZoomReset');
    if (zin) zin.addEventListener('click', () => zoomOverlayCenter(1.25));
    if (zout) zout.addEventListener('click', () => zoomOverlayCenter(1 / 1.25));
    if (zreset) zreset.addEventListener('click', () => resetOverlayView());

    canvas.addEventListener('mousemove', handleOverlayHover);
    canvas.addEventListener('mouseleave', () => {
        const tip = document.getElementById('overlayCursorTip');
        if (tip) tip.style.display = 'none';
    });

    // 键盘翻层：看片卡可见时 ↑/↓ 或 W/S 切换切片（焦点在输入控件上时不拦截）
    document.addEventListener('keydown', (e) => {
        const card = document.getElementById('overlayCard');
        if (!OverlayState.meta || !card || card.style.display === 'none') return;
        const tag = (document.activeElement || {}).tagName || '';
        if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag)) return;
        let dir = 0;
        if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') dir = -1;
        else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') dir = 1;
        if (!dir) return;
        e.preventDefault();
        stopOverlayPlay();
        const next = Math.min(OverlayState.meta.num_slices - 1, Math.max(0, OverlayState.slice + dir));
        if (next !== OverlayState.slice) {
            sliceInput.value = String(next);
            loadOverlaySlice(next);
        }
    });

    document.getElementById('overlayPlayBtn').addEventListener('click', toggleOverlayPlay);
    document.getElementById('overlayAllOrgansBtn').addEventListener('click', () => setOverlayOrgans('all'));
    document.getElementById('overlayAffectedBtn').addEventListener('click', () => setOverlayOrgans('affected'));
    // 原始序列对照双窗：开关切换，开启即拉当前层原始切片
    const dualBtn = document.getElementById('dualViewToggle');
    if (dualBtn) dualBtn.addEventListener('click', () => setDualEnabled(!DualState.enabled));
    document.querySelectorAll('#overlayModeToggle .mode-btn').forEach(btn => {
        btn.addEventListener('click', () => setOverlayMode(btn.dataset.mode));
    });
}

async function generateReport(options = {}) {
    // options.preview=true 时不下载而是新标签页打开预览（历史记录预览用）；
    // options.case_id 传入时后端从库里读回完整诊断结果，本地无需持有结果。
    const preview = !!options.preview;
    let diagnosis_result = options.diagnosis_result || AppState.currentDiagnosis;
    if (!diagnosis_result && !options.case_id) {
        showToast('请先进行AI诊断', 'warning');
        return;
    }
    // 报告只收录「采纳」的发现：发送前替换 diagnoses（浅拷贝，不动本地结果）
    if (diagnosis_result && !options.case_id) {
        const accepted = acceptedDiagnoses();
        if (!accepted.length) {
            showToast('没有已采纳的发现，无法生成报告', 'warning');
            return;
        }
        diagnosis_result = Object.assign({}, diagnosis_result, { diagnoses: accepted });
    }

    showLoading('大模型撰写专业报告中...');

    try {
        const response = await fetch('/api/report/generate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                diagnosis_result,
                case_id: options.case_id || AppState.currentHistoryCaseId,
                file_id: options.file_id !== undefined ? options.file_id : AppState.currentFileId,
                patient_info: options.patient_info || (diagnosis_result ? {
                    patient_id: (diagnosis_result.metadata || {}).patient_id
                        || ('P' + new Date().getTime()),
                    study_date: new Date().toISOString().split('T')[0],
                    modality: 'CT'
                } : {})
            })
        });

        const data = await response.json();

        if (data.success) {
            // 圆点按本次实际生成方式同步：绿=大模型撰写，红=模板生成
            const dot = document.getElementById('reportModeDot');
            if (dot) dot.className = 'ovf-report-dot ' + (data.llm_used ? 'on' : 'off');
            if (preview) {
                openPdfPreview(data.pdf_data, data.filename);
            } else {
                // 下载PDF
                const link = document.createElement('a');
                link.href = 'data:application/pdf;base64,' + data.pdf_data;
                link.download = data.filename;
                link.click();
                showToast(data.llm_used ? '专业报告已生成（大模型撰写）' : 'PDF报告已生成', 'success');
            }
        } else {
            showToast(data.message || '生成报告失败', 'error');
        }
    } catch (error) {
        console.error('Generate report error:', error);
        showToast('生成报告失败: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

// 在新标签页打开 PDF 预览（blob URL，不落地磁盘）
function openPdfPreview(pdfBase64, filename) {
    try {
        const bytes = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const win = window.open(url, '_blank');
        if (!win) {
            showToast('浏览器拦截了新窗口，请允许弹出后重试', 'warning');
            URL.revokeObjectURL(url);
            return;
        }
        // PDF 已被新标签页读入内存，延迟释放 blob URL
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        showToast(`报告预览已打开：${filename || ''}`, 'success');
    } catch (error) {
        console.error('Open pdf preview error:', error);
        showToast('打开预览失败: ' + error.message, 'error');
    }
}

// 历史记录「预览报告」：按 case_id 让后端从库里读回诊断结果现生成现预览
function previewHistoryReport(caseId) {
    generateReport({ preview: true, case_id: caseId });
}

// ============ 历史记录 ============
async function loadHistory() {
    try {
        const response = await fetch('/api/history');
        const data = await response.json();
        
        if (data.success) {
            displayHistory(data.records);
        }
    } catch (error) {
        console.error('Load history error:', error);
    }
}

function displayHistory(records) {
    const historyList = document.getElementById('historyList');
    // 简化版 /ai 页无历史列表：loadHistory 照常调用，这里直接跳过渲染
    if (!historyList) return;
    historyList.innerHTML = '';
    
    if (records.length === 0) {
        historyList.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">暂无历史记录</p>';
        return;
    }
    
    records.forEach(record => {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.style.borderLeftColor = RISK_COLOR[record.risk_level] || 'var(--primary)';
        // 列表接口只带摘要，这里不渲染大字段；点击才去拉完整诊断结果
        item.innerHTML = `
            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                <strong>患者ID: ${escapeHtml(record.patient_id || '-')}</strong>
                <span style="color: var(--text-secondary);">${escapeHtml(record.timestamp || '')}</span>
            </div>
            <div class="history-item-file">
                ${escapeHtml(record.file_name || '-')}
            </div>
            <div style="color: var(--text-secondary);">
                诊断结论: ${escapeHtml(record.diagnosis.diagnosis || '无')}
            </div>
            <div class="history-item-meta">
                ${sourceTag(record.source)}
                ${riskBadge(record.risk_level)}
                ${record.findings_count != null ? `<span class="history-tag">${record.findings_count} 项发现</span>` : ''}
                ${record.organs_detected_count ? `<span class="history-tag muted">${record.organs_detected_count} 器官</span>` : ''}
                ${record.processing_time ? `<span class="history-tag muted">${Number(record.processing_time).toFixed(1)}s</span>` : ''}
                ${(record.warnings || []).length ? `<span class="history-tag muted">${record.warnings.length} 条警告</span>` : ''}
                <button class="history-preview-btn" data-case="${record.case_id}"
                        title="在新标签页预览该次诊断的PDF报告">预览报告</button>
            </div>
        `;
        item.addEventListener('click', () => openHistoryDetail(record.case_id));
        // 预览按钮独立于整行的「打开详情」点击，需阻止冒泡
        item.querySelector('.history-preview-btn').addEventListener('click', (ev) => {
            ev.stopPropagation();
            previewHistoryReport(record.case_id);
        });
        historyList.appendChild(item);
    });
}

const RISK_COLOR = {
    high: 'var(--danger, #dc2626)',
    medium: 'var(--warning, #d97706)',
    low: 'var(--primary)',
    none: 'var(--text-tertiary)',
};

function riskBadge(level) {
    const label = { high: '高风险', medium: '中风险', low: '低风险', none: '无显著异常' }[level] || '-';
    return `<span class="history-tag" style="border-color:${RISK_COLOR[level] || 'var(--border-color)'};color:${RISK_COLOR[level] || 'var(--text-secondary)'}">${label}</span>`;
}

// 升级前的老记录没有存 file_id，来源无从判定（数据库里是 NULL）。
// 这种情况显示「来源未记录」，而不是误标成「外部导入」。
function sourceTag(source) {
    if (source === 'library') return '<span class="history-tag">院内影像库</span>';
    if (source === 'upload') return '<span class="history-tag muted">外部导入</span>';
    return '<span class="history-tag muted">来源未记录</span>';
}

function sourceLabel(source) {
    return { library: '院内影像库', upload: '外部导入' }[source] || '来源未记录';
}

// ==================== 历史记录详情（完整诊断结果） ====================
// 列表只传小摘要，完整结果（explanation / top_scores / warnings / metadata /
// 原始报告）在此按需加载，避免历史记录一多就把整库拖到浏览器。
async function openHistoryDetail(caseId) {
    const drawer = document.getElementById('historyDrawer');
    const body = document.getElementById('histDrawerBody');
    if (!drawer || !body) return;
    drawer.hidden = false;
    document.body.classList.add('drawer-open');
    document.getElementById('histDrawerTitle').textContent = '诊断记录详情';
    document.getElementById('histDrawerSub').textContent = '加载中…';
    body.innerHTML = '<div class="lib-empty">加载中…</div>';

    try {
        const res = await fetch('/api/history/' + encodeURIComponent(caseId));
        const data = await res.json();
        if (!data.success) throw new Error(data.message || '记录不存在');
        const r = data.record;
        renderHistoryDetail(r);
    } catch (err) {
        console.error('[history] detail failed', err);
        body.innerHTML = `<div class="lib-empty">${escapeHtml(err.message)}</div>`;
    }
}

function closeHistoryDetail() {
    const drawer = document.getElementById('historyDrawer');
    if (drawer) drawer.hidden = true;
    document.body.classList.remove('drawer-open');
}

function renderHistoryDetail(r) {
    const body = document.getElementById('histDrawerBody');
    const d = r.diagnosis;
    const lib = r.library_context;
    const p = (lib && lib.patient) || {};

    document.getElementById('histDrawerTitle').textContent =
        `${p.patient_name || r.patient_id || '匿名'} · ${p.medical_record_no || lib?.accession_number || r.patient_id || ''}`;
    document.getElementById('histDrawerSub').textContent = [
        r.timestamp, r.file_name,
        sourceLabel(r.source),
        d?.engine || '', r.processing_time ? `${Number(r.processing_time).toFixed(1)}s` : '',
    ].filter(Boolean).join(' · ');

    // 左栏：完整诊断结果（含推理依据与警告，这些都不在列表摘要里）
    const left = [];
    left.push(histSection('诊断结论', histDiagnosisRows(d?.diagnoses || r.summary?.diagnoses || [])));
    if (d?.warnings?.length) {
        left.push(histSection('输入质量警告',
            d.warnings.map((w) => `<div class="hist-warn">${escapeHtml(typeof w === 'string' ? w : (w.message || JSON.stringify(w)))}</div>`).join('')));
    }
    if (r.organs_detected?.length) {
        left.push(histSection(`检出器官（${r.organs_detected.length}）`,
            `<div class="hist-organ-chips">${r.organs_detected.map((o) => `<span>${escapeHtml(o)}</span>`).join('')}</div>`));
    }
    if (d?.explanation) {
        const e = d.explanation;
        const top = (e.top_scores || []).map((t) =>
            `<div class="hist-top-row"><span>${escapeHtml(t.item)}</span><b>${(t.confidence * 100).toFixed(1)}%</b></div>`).join('');
        left.push(histSection('推理依据',
            `${e.method ? `<div class="hist-text">${escapeHtml(e.method)}</div>` : ''}
             ${e.summary ? `<div class="hist-text muted">${escapeHtml(e.summary)}</div>` : ''}
             ${top ? `<div class="hist-top-title">置信度 Top ${e.top_scores.length}（共 ${e.total_items || '-'} 项）</div>${top}` : ''}
             ${e.limitations?.length ? `<div class="hist-text muted">局限：${e.limitations.map(escapeHtml).join('；')}</div>` : ''}`));
    }
    if (!d) {
        left.push(histSection('完整诊断结果',
            '<div class="lib-empty">该记录产生于升级前，仅保存了结论摘要，未留存推理依据与警告等完整数据。重新导入影像并诊断即可获得完整记录。</div>'));
    }
    // 元数据与诊断页一致：用 label_map 显示中文字段名并按其顺序排列，
    // 控制键（label_map/source/num_instances）不参与展示。
    // 完整 DICOM 元数据在 diagnosis_json.metadata 里（入库时已合并 image_shape/
    // file_type）；r.metadata 只是关系表里的少量键值对，作为老记录的兜底。
    const meta = (d && d.metadata) || r.metadata || {};
    const labelMap = meta.label_map || {};
    const metaOrder = Object.keys(labelMap);
    const metaKeys = Object.keys(meta)
        .filter((k) => !META_CONTROL_KEYS.has(k) && meta[k] && typeof meta[k] !== 'object')
        .sort((a, b) => {
            const ia = metaOrder.indexOf(a), ib = metaOrder.indexOf(b);
            return (ia === -1 ? metaOrder.length : ia) - (ib === -1 ? metaOrder.length : ib);
        });
    if (metaKeys.length) {
        left.push(histSection('影像元数据', metaKeys.map((k) =>
            `<div class="hist-meta-row"><span>${escapeHtml(labelMap[k] || k)}</span><b>${escapeHtml(String(meta[k]))}</b></div>`).join('')));
    }

    // 右栏：库内病例的溯源与原始报告（入库时已固化，影像库离线也能看）
    const right = [];
    if (lib) {
        const rows = [
            ['教学库', lib.library_root],
            ['检查号', lib.accession_number],
            ['检查', lib.examination && `${lib.examination.modality || ''} ${lib.examination.study_description || ''}`.trim()],
            ['检查日期', lib.examination && lib.examination.examination_date],
            ['导入序列', lib.series_description ? `#${lib.series_number ?? ''} ${lib.series_description}` : ''],
            ['序列规模', lib.examination && `${lib.examination.series_count || '-'} 序列 / ${lib.examination.image_count || '-'} 张 / ${lib.examination.size_gb || '-'} GB`],
            ['分类', [p.level1, p.level2, p.level3].filter(Boolean).join(' / ')],
            ['疾病', p.disease_name],
            ['file_id', r.file_id],
        ].filter(([, v]) => v);
        right.push(histSection('影像溯源',
            rows.map(([k, v]) => `<div class="hist-meta-row"><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b></div>`).join('')));
    }
    if (lib?.reports?.length) {
        right.push(histSection(`原始报告（${lib.reports.length} 份）`,
            `<div class="lib-report-list">${renderReportItems(lib.reports)}</div>`));
    }
    if (!right.length) {
        // 外部导入的病例本就没有溯源；升级前的老记录同样没有
        right.push(histSection('影像溯源',
            `<div class="lib-empty">该记录没有院内影像库溯源信息（${sourceLabel(r.source)}）。</div>`));
    }

    body.innerHTML = `
        <div class="lib-drawer-col">${left.join('')}</div>
        <div class="lib-drawer-col">${right.join('')}</div>
    `;
}

function histSection(title, inner) {
    return `<div class="hist-section">
        <div class="lib-section-head"><h4>${escapeHtml(title)}</h4></div>
        ${inner}
    </div>`;
}

function histDiagnosisRows(diagnoses) {
    if (!diagnoses.length) return '<div class="lib-empty">未发现达到阈值的异常</div>';
    return diagnoses.map((x) => `
        <div class="hist-diag-row">
            <div class="hist-diag-head">
                <span class="hist-diag-organ">${escapeHtml(x.organ || '-')}</span>
                <span class="hist-diag-finding">${escapeHtml(x.finding || '-')}</span>
                <span class="hist-diag-sev sev-${escapeHtml(x.severity || 'low')}">${escapeHtml({ high: '高', medium: '中', low: '低' }[x.severity] || '-')}</span>
                ${x.confidence != null ? `<span class="hist-diag-conf">${(x.confidence * 100).toFixed(1)}%</span>` : ''}
            </div>
            ${x.evidence ? `<div class="hist-text muted">${escapeHtml(x.evidence)}</div>` : ''}
            ${x.recommendation ? `<div class="hist-text">${escapeHtml(x.recommendation)}</div>` : ''}
        </div>`).join('');
}

// ============ 批量处理 ============
document.getElementById('batchFileInput')?.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (files.length === 0) return;
    
    showLoading('批量上传中...');
    
    const formData = new FormData();
    for (let file of files) {
        formData.append('files', file);
    }
    
    try {
        const response = await fetch('/api/batch/upload', {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        if (data.success) {
            displayBatchResults(data.results);
            showToast(`批量上传完成: ${data.success_count}/${data.total}`, 'success');
        }
    } catch (error) {
        console.error('Batch upload error:', error);
        showToast('批量上传失败', 'error');
    } finally {
        hideLoading();
    }
});

function displayBatchResults(results) {
    const container = document.getElementById('batchResults');
    container.innerHTML = '<h4 style="margin: 1rem 0;">批量处理结果</h4>';
    
    results.forEach(result => {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.style.borderLeftColor = result.success ? 'var(--success)' : 'var(--error)';
        item.innerHTML = `
            <div><strong>${result.filename}</strong></div>
            <div style="color: var(--text-secondary);">
                ${result.success ? 
                    `格式: ${result.file_type} | 尺寸: ${result.shape.join(' × ')}` : 
                    `错误: ${result.message}`
                }
            </div>
        `;
        container.appendChild(item);
    });
}

// ============ 工具函数 ============
function showLoading(text = '加载中...') {
    const overlay = document.getElementById('loadingOverlay');
    const loadingText = document.getElementById('loadingText');
    loadingText.textContent = text;
    overlay.style.display = 'flex';
}

function hideLoading() {
    document.getElementById('loadingOverlay').style.display = 'none';
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}


/* ===== teaching-api: 教学系统接口基址 + 检查溯源补全 =====
   经主站 /radar 前缀访问时，同源垫片会给根绝对路径补 /radar 前缀，教学系统
   接口必须用带 origin 的绝对地址才不会被打回 RADAR 自身。仅有 file_id 的旧
   入口反查不到 examination_id，多检查病例读报告会 409，这里按当前序列 UID
   反查所属检查后重试。 */
function teachingApiBase() {
    return window.location.pathname.indexOf('/radar') === 0
        ? window.location.origin : 'http://127.0.0.1:8888';
}

async function resolveExaminationId(caseId, seriesUidHint) {
    if (!caseId) return null;
    const token = localStorage.getItem('token');
    if (!token) return null;
    let uid = seriesUidHint || null;
    if (!uid) {
        const fid = (typeof AppState !== 'undefined') ? AppState.currentFileId : null;
        if (!fid) return null;
        try {
            const r = await fetch('/api/case-context?file_id=' + encodeURIComponent(fid));
            const j = await r.json();
            if (j && j.success) uid = j.series_instance_uid || null;
        } catch (e) {
            return null;
        }
    }
    try {
        const r = await fetch(teachingApiBase() + '/api/cases/' + encodeURIComponent(caseId) + '/radar-series',
            { headers: { Authorization: 'Bearer ' + token } });
        if (!r.ok) return null;
        const j = await r.json();
        const items = (j && j.series) || [];
        const hit = items.find((s) => s.series_instance_uid && s.series_instance_uid === uid);
        if (hit && hit.examination_id) return hit.examination_id;
        const exams = [...new Set(items.map((s) => s.examination_id).filter(Boolean))];
        return exams.length === 1 ? exams[0] : null;
    } catch (e) {
        return null;
    }
}

/* ===== report-tab: 左列「控制面板 / 审核报告」Tab 与报告面板 =====
   报告正文不经过 RADAR 服务器：浏览器持教学系统登录态（localStorage.token）
   直连 8888 的 /api/cases/{case_id}/reports/detail（CORS 已放行 3003）。
   case 溯源优先取打开 URL 上的 case_id/examination_id（教学系统抽屉带入），
   缺失时回退 /api/case-context 按 file_id 反查注册表。 */
(function initSideReportTab() {
    // 经主站 /radar 前缀访问时，同源垫片会给根绝对路径补 /radar 前缀，
    // 教学系统接口必须用带 origin 的绝对地址才不会被打回 RADAR 自身。
    const TEACHING_API = (window.location.pathname.indexOf('/radar') === 0
        ? window.location.origin : 'http://127.0.0.1:8888');
    const tabControls = document.getElementById('sideTabControls');
    const tabReport = document.getElementById('sideTabReport');
    const paneControls = document.getElementById('sidePaneControls');
    const paneReport = document.getElementById('sidePaneReport');
    if (!tabControls || !tabReport || !paneControls || !paneReport) return;

    const modeRevisedBtn = document.getElementById('rptModeRevised');
    const modeOriginalBtn = document.getElementById('rptModeOriginal');
    const metaEl = document.getElementById('rptMeta');
    const bodyEl = document.getElementById('rptBody');

    const state = {
        ctx: null, ctxFileId: null, ctxErr: false,
        detail: null, detailKey: null,
        mode: 'revised', loading: false,
    };

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));

    function setTab(which) {
        const isReport = which === 'report';
        tabControls.classList.toggle('is-active', !isReport);
        tabReport.classList.toggle('is-active', isReport);
        tabControls.setAttribute('aria-selected', String(!isReport));
        tabReport.setAttribute('aria-selected', String(isReport));
        paneControls.hidden = isReport;
        paneReport.hidden = !isReport;
        // 上次溯源/拉取失败时允许重试点 Tab 重试
        if (isReport && !state.ctx) state.ctxFileId = null;
        if (isReport && !state.loading && state.detail === null && state.detailKey) {
            state.detailKey = null;
        }
        if (isReport) ensureReport();
    }
    tabControls.addEventListener('click', () => setTab('controls'));
    tabReport.addEventListener('click', () => setTab('report'));

    function setMode(mode) {
        if (state.mode === mode) return;
        state.mode = mode;
        modeRevisedBtn.classList.toggle('is-active', mode === 'revised');
        modeOriginalBtn.classList.toggle('is-active', mode === 'original');
        modeRevisedBtn.setAttribute('aria-selected', String(mode === 'revised'));
        modeOriginalBtn.setAttribute('aria-selected', String(mode === 'original'));
        render();
    }
    modeRevisedBtn.addEventListener('click', () => setMode('revised'));
    modeOriginalBtn.addEventListener('click', () => setMode('original'));

    function ctxKey(ctx) {
        return (ctx && ctx.case_id ? ctx.case_id : '') + '|' + (ctx && ctx.examination_id ? ctx.examination_id : '');
    }

    async function ensureContext() {
        const fid = AppState.currentFileId;
        if (!fid) return null;
        if (state.ctxFileId === fid) return state.ctx;
        state.ctxFileId = fid;
        state.ctx = null;
        const qs = new URLSearchParams(window.location.search);
        const urlCase = qs.get('case_id');
        if (urlCase) {
            state.ctx = { case_id: urlCase, examination_id: qs.get('examination_id') || null };
            return state.ctx;
        }
        try {
            const r = await fetch('/api/case-context?file_id=' + encodeURIComponent(fid));
            const j = await r.json();
            state.ctx = j && j.success ? j : null;
            state.ctxErr = false;
        } catch (e) {
            state.ctx = null;
            state.ctxErr = true;
        }
        return state.ctx;
    }

    async function ensureDetail(ctx) {
        const key = ctxKey(ctx);
        if (state.detailKey === key) return state.detail;
        state.detailKey = key;
        state.detail = null;
        const token = localStorage.getItem('token');
        if (!token) {
            state.detail = { __noauth: true };
            return state.detail;
        }
        const url = TEACHING_API + '/api/cases/' + encodeURIComponent(ctx.case_id) + '/reports/detail'
            + (ctx.examination_id ? '?examination_id=' + encodeURIComponent(ctx.examination_id) : '');
        try {
            const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
            if (r.status === 401) state.detail = { __noauth: true };
            else if (r.ok) state.detail = await r.json();
            else if (r.status === 409 && !ctx.examination_id) {
                const examId = await resolveExaminationId(ctx.case_id, ctx.series_instance_uid);
                if (examId) {
                    const r2 = await fetch(TEACHING_API + '/api/cases/' + encodeURIComponent(ctx.case_id)
                        + '/reports/detail?examination_id=' + encodeURIComponent(examId),
                        { headers: { Authorization: 'Bearer ' + token } });
                    if (r2.ok) state.detail = await r2.json();
                }
            }
        } catch (e) {
            state.detail = null;
        }
        return state.detail;
    }

    async function ensureReport() {
        const ctx = await ensureContext();
        if (!ctx || !ctx.case_id) {
            render();
            return;
        }
        if (state.detailKey !== ctxKey(ctx) && !state.loading) {
            state.loading = true;
            render();
            await ensureDetail(ctx);
            state.loading = false;
        }
        render();
    }

    const section = (title, text) => {
        const has = text && String(text).trim();
        return '<div class="rpt-sec"><h4>' + title + '</h4><p class="' + (has ? '' : 'rpt-none') + '">'
            + (has ? esc(text) : '（无）') + '</p></div>';
    };

    function render() {
        metaEl.style.display = '';
        const ctx = state.ctx;
        if (!ctx || !ctx.case_id) {
            metaEl.innerHTML = '';
            bodyEl.innerHTML = '<div class="rpt-empty">'
                + (state.ctxErr ? '溯源获取失败，请再点一次「审核报告」重试'
                    : '该序列无院内溯源（外部上传），暂无审核报告') + '</div>';
            return;
        }
        if (state.loading || state.detailKey !== ctxKey(ctx)) {
            metaEl.innerHTML = '';
            bodyEl.innerHTML = '<div class="rpt-empty">正在加载报告…</div>';
            return;
        }
        const d = state.detail;
        if (!d || d.__noauth) {
            metaEl.innerHTML = '';
            bodyEl.innerHTML = '<div class="rpt-empty">' + (d && d.__noauth
                ? '未检测到教学系统登录态：请先登录 http://127.0.0.1:3003 后回到本页重试'
                : '报告获取失败，请稍后重试') + '</div>';
            return;
        }
        const reviewed = !!d.is_reviewed;
        const who = d.reviewed_by || '';
        const when = d.reviewed_at ? String(d.reviewed_at).slice(0, 10) : '';
        // reporttab6: 不再显示「未审核」标记——未审核时整行元信息隐藏，
        // 省下的纵向空间由检查所见/检查结论块按 3:2 自动吸收
        if (reviewed) {
            metaEl.style.display = '';
            metaEl.innerHTML = '<span class="rpt-badge ok">已审核</span>'
                + (who ? '<span>审核人：' + esc(who) + '</span>' : '')
                + (when ? '<span>' + esc(when) + '</span>' : '');
        } else {
            metaEl.style.display = 'none';
            metaEl.innerHTML = '';
        }
        const revised = state.mode === 'revised';
        const findings = revised ? d.revised_findings : d.original_findings;
        const diagnosis = revised ? d.revised_diagnosis : d.original_diagnosis;
        const content = revised ? d.revised_report : d.original_report;
        const hasSections = (findings && String(findings).trim()) || (diagnosis && String(diagnosis).trim());
        if (!hasSections && content && String(content).trim()) {
            // 后端未给拆分字段时，从正文解析两段标记，保证审核报告同样
            // 以「检查所见 / 检查结论」两块呈现，而不是整坨正文
            const txt = String(content);
            const mF = txt.match(/(?:检查所见|影像所见)[：:]([\s\S]*?)(?=(?:检查结论|影像结论|检查诊断|影像诊断)[：:])/);
            const mD = txt.match(/(?:检查结论|影像结论|检查诊断|影像诊断)[：:]([\s\S]*)$/);
            if (mF && mD) {
                bodyEl.innerHTML = section('检查所见：', mF[1]) + section('检查结论：', mD[1]);
            } else {
                bodyEl.innerHTML = section(revised ? '审核报告' : '原始报告', content);
            }
            return;
        }
        bodyEl.innerHTML = section('检查所见：', findings) + section('检查结论：', diagnosis);
    }

    // 切换诊断序列后报告页若开着则自动刷新（轮询 file_id 变化，避免侵入主流程）
    setInterval(() => {
        if (paneReport.hidden || state.loading) return;
        const fid = AppState.currentFileId;
        if (fid && fid !== state.ctxFileId) ensureReport();
    }, 1500);
})();


/* ===== series-switch: 顶部序列切换下拉 =====
   数据合并：教学系统 /api/cases/{id}/radar-series（全集 + 星级评估 + host_path，
   浏览器持 token 直连 8888）× RADAR /api/case-series（uid → file_id + 已诊断）。
   只列推荐序列（verdict != unsuitable 且 score >= 0），按评分降序。
   切换流程：未注册先 import_path 零拷贝注册 → /api/session/load 装载 →
   结果恢复优先级 localStorage 缓存 → 服务器历史记录 → 确认弹窗新诊断。 */
(function initSeriesPicker() {
    // 经主站 /radar 前缀访问时，同源垫片会给根绝对路径补 /radar 前缀，
    // 教学系统接口必须用带 origin 的绝对地址才不会被打回 RADAR 自身。
    const TEACHING_API = (window.location.pathname.indexOf('/radar') === 0
        ? window.location.origin : 'http://127.0.0.1:8888');
    const picker = document.getElementById('seriesPicker');
    const select = document.getElementById('seriesSelect');
    // label-fix: 标题栏状态文案已移除；元素不存在时用游离节点承接写入，
    // 切换逻辑保持不变
    let stateEl = document.getElementById('seriesPickerState');
    if (!stateEl) stateEl = document.createElement('span');
    if (!picker || !select || !stateEl) return;

    const qs = new URLSearchParams(window.location.search);
    const caseId = qs.get('case_id');

    let teachSeries = [];
    let regItems = [];
    let switching = false;

    const stars = (a) => (!a || a.score == null || a.score < 0 || a.verdict === 'unsuitable')
        ? '' : (a.score >= 80 ? '★★★' : a.score >= 70 ? '★★' : '★');
    const regOf = (uid) => regItems.find((x) => x.series_instance_uid === uid) || null;
    const uidOfCurrent = () => (regItems.find((x) => x.file_id === AppState.currentFileId)
        || {}).series_instance_uid || null;
    const isDiagnosed = (reg) => Boolean(reg && (reg.diagnosed || loadDiagnosisCache(reg.file_id)));

    function renderOptions() {
        const curUid = uidOfCurrent();
        select.innerHTML = '';
        if (!teachSeries.length) {
            const opt = document.createElement('option');
            opt.textContent = caseId ? '本病例暂无推荐诊断序列' : '外部影像（未关联病例）';
            opt.value = '';
            select.appendChild(opt);
            select.disabled = true;
            return;
        }
        select.disabled = false;
        for (const s of teachSeries) {
            const reg = regOf(s.series_instance_uid);
            const opt = document.createElement('option');
            opt.value = s.series_instance_uid;
            opt.textContent = 'S' + (s.series_number != null ? s.series_number : '?')
                + ' · ' + (s.series_description || '未命名序列')
                + '　' + stars(s.assessment)
                + (isDiagnosed(reg) ? '　已诊断' : '');
            if (s.series_instance_uid === curUid) opt.selected = true;
            select.appendChild(opt);
        }
        if (curUid && !teachSeries.some((s) => s.series_instance_uid === curUid)) {
            const opt = document.createElement('option');
            opt.value = curUid;
            opt.textContent = '当前序列（不在推荐列表）';
            select.appendChild(opt);
            select.value = curUid;
        }
    }

    function updateState() {
        if (!caseId) {
            stateEl.textContent = '外部影像（未关联病例）';
            stateEl.className = 'series-picker-state';
            return;
        }
        const reg = regOf(select.value);
        if (!teachSeries.length) {
            stateEl.textContent = '';
            return;
        }
        if (isDiagnosed(reg)) {
            stateEl.textContent = '已诊断 · 切换将恢复历史记录';
            stateEl.className = 'series-picker-state is-done';
        } else {
            stateEl.textContent = '未诊断 · 切换后确认即开始 AI 诊断';
            stateEl.className = 'series-picker-state is-new';
        }
    }

    async function loadAll() {
        picker.hidden = false;
        if (!caseId) {
            renderOptions();
            updateState();
            return;
        }
        stateEl.textContent = '加载序列…';
        const token = localStorage.getItem('token');
        const [teach, reg] = await Promise.all([
            (async () => {
                if (!token) return [];
                try {
                    const r = await fetch(
                        TEACHING_API + '/api/cases/' + encodeURIComponent(caseId) + '/radar-series',
                        { headers: { Authorization: 'Bearer ' + token } });
                    if (!r.ok) return [];
                    const j = await r.json();
                    return j.series || [];
                } catch (e) { return []; }
            })(),
            (async () => {
                try {
                    const r = await fetch('/api/case-series?case_id=' + encodeURIComponent(caseId));
                    const j = await r.json();
                    return (j && j.success && j.items) || [];
                } catch (e) { return []; }
            })(),
        ]);
        teachSeries = teach
            .filter((s) => s.assessment && s.assessment.verdict !== 'unsuitable'
                && s.assessment.score >= 0)
            .sort((a, b) => b.assessment.score - a.assessment.score);
        regItems = reg;
        renderOptions();
        updateState();
    }

    function restoreResult(result, histCaseId, msg) {
        AppState.currentDiagnosis = result;
        AppState.currentHistoryCaseId = histCaseId || null;
        AppState.allDiagnoses = result.all_diagnoses || result.diagnoses || [];
        displayDiagnosisResult(result);
        showOverlayCardPending(result);
        initOverlayViewer(result);
        syncThresholdUi();
        setWorkflowStep('workflowDiagnosisStep');
        setWorkflowStep('workflowReportStep');
        setReportBtnEnabled(true);
        showToast(msg, 'success');
        document.getElementById('diagProgress').hidden = true;
    }

    async function fetchHistoryResult(fileId) {
        try {
            const r = await fetch('/api/history?limit=200');
            const j = await r.json();
            const rec = ((j && j.records) || []).find((x) => x.file_id === fileId);
            if (!rec) return null;
            const d = await fetch('/api/history/' + rec.id);
            const dj = await d.json();
            if (!dj.success || !dj.record || !dj.record.diagnosis) return null;
            return { result: dj.record.diagnosis, case_id: dj.record.id };
        } catch (e) { return null; }
    }

    async function switchTo(uid) {
        if (switching || !uid) return;
        const item = teachSeries.find((s) => s.series_instance_uid === uid);
        if (!item) return;
        let reg = regOf(uid);
        if (!reg) {
            if (!item.host_path) {
                showToast('该序列无宿主机路径，无法导入', 'error');
                return;
            }
            switching = true;
            stateEl.textContent = '注册序列…';
            try {
                const r = await fetch('/api/library/import_path', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ series_dir: item.host_path, study_dir: item.host_path }),
                });
                const j = await r.json();
                if (!j.success) {
                    showToast(j.message || '注册序列失败', 'error');
                    updateState();
                    return;
                }
                reg = {
                    series_instance_uid: uid,
                    file_id: j.file_id,
                    series_number: item.series_number,
                    series_description: item.series_description,
                    diagnosed: false,
                };
                regItems.push(reg);
                renderOptions();
                select.value = uid;
            } catch (e) {
                showToast('注册序列失败: ' + e.message, 'error');
                return;
            }
        }
        const fileId = reg.file_id;
        if (fileId === AppState.currentFileId) {
            updateState();
            return;
        }
        switching = true;
        stateEl.textContent = '切换序列…';
        select.blur();
        document.getElementById('diagnosis-page').classList.add('sw-switching');
        const fz = freezeLayout();
        try {
            const r = await fetch('/api/session/load', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_id: fileId }),
            });
            const data = await r.json();
            if (!data.success) {
                unfreezeLayout(fz);
                showToast(data.message || '加载序列失败', 'error');
                return;
            }
            AppState.currentFileId = data.file_id;
            AppState.currentFileInfo = data.info;
            displayFileInfo(data.info);
            showViewerSection();
            const cached = loadDiagnosisCache(fileId);
            if (cached && cached.result) {
                reg.diagnosed = true;
                restoreResult(cached.result, cached.case_id || null, '已恢复上次诊断结果');
                unfreezeLayout(fz);
            } else if (reg.diagnosed) {
                const hist = await fetchHistoryResult(fileId);
                if (hist) {
                    saveDiagnosisCache(fileId, hist.result, hist.case_id);
                    restoreResult(hist.result, hist.case_id, '已恢复历史诊断记录');
                    unfreezeLayout(fz);
                } else {
                    unfreezeLayout(fz);
                    openSeriesConfirmModal();
                }
            } else {
                unfreezeLayout(fz);
                openSeriesConfirmModal();
            }
            renderOptions();
            updateState();
        } catch (e) {
            unfreezeLayout(fz);
            showToast('切换序列失败: ' + e.message, 'error');
        } finally {
            switching = false;
        }
    }

    /* series-switch2/3: 切换期间冻结主区尺寸并钉住滚动位置，等新序列首帧
       渲染完成后单帧释放——中间态（发现列表清空/回填、警告卡显隐、canvas
       二次重排、浏览器追焦自动滚动）都不再产生可见抖动 */
    const FREEZE_TARGETS = ['#resultSection', '#overlayCard', '.overlay-body',
        '#overlayStage', '.overlay-side', '.overlay-findings-list'];

    function freezeLayout() {
        const saved = [];
        for (const sel of FREEZE_TARGETS) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const h = el.getBoundingClientRect().height;
            if (h > 40) {
                saved.push([el, el.style.minHeight]);
                el.style.minHeight = Math.round(h) + 'px';
            }
        }
        // 舞台定宽：canvas 按新序列宽高比重排只在舞台内部发生，
        // 发现列与卡片宽度不再横向收缩
        const stage = document.querySelector('#overlayStage');
        let stageLock = null;
        if (stage) {
            stageLock = [stage, stage.style.width, stage.style.flex];
            stage.style.width = Math.round(stage.getBoundingClientRect().width) + 'px';
            stage.style.flex = '0 0 auto';
        }
        // 显隐块钉在切换前状态：diagProgress 折叠/警告卡弹出都推迟到释放帧
        const visLocks = [];
        for (const sel of ['#diagProgress', '#inputWarnings']) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const vis = el.hidden !== true
                && getComputedStyle(el).display !== 'none';
            el.classList.add(vis ? 'sw-lock-show' : 'sw-lock-hide');
            visLocks.push(el);
        }
        const scrollY = window.scrollY;
        document.documentElement.classList.add('is-switching-series');
        const fz = { saved, scrollY, pin: true, raf: 0, stageLock, visLocks };
        // 钉住滚动：重排/追焦引发的自动滚动每帧被拉回，用户看不到跳屏
        const pinLoop = () => {
            if (!fz.pin) return;
            if (Math.abs(window.scrollY - fz.scrollY) > 1) {
                window.scrollTo(0, fz.scrollY);
            }
            fz.raf = requestAnimationFrame(pinLoop);
        };
        fz.raf = requestAnimationFrame(pinLoop);
        return fz;
    }

    function unfreezeLayout(fz) {
        if (!fz || fz.done) return;
        fz.done = true;
        const targetFid = AppState.currentFileId;
        const t0 = Date.now();
        const release = () => {
            fz.pin = false;
            cancelAnimationFrame(fz.raf);
            for (const [el, mh] of fz.saved) el.style.minHeight = mh;
            if (fz.stageLock) {
                const [st, w, fl] = fz.stageLock;
                st.style.width = w;
                st.style.flex = fl;
            }
            for (const el of (fz.visLocks || [])) {
                el.classList.remove('sw-lock-show', 'sw-lock-hide');
            }
            document.documentElement.classList.remove('is-switching-series');
            document.getElementById('diagnosis-page').classList.remove('sw-switching');
            if (Math.abs(window.scrollY - fz.scrollY) > 4) {
                window.scrollTo(0, fz.scrollY);
            }
        };
        // 等新序列首帧切片渲染完成（canvas 二次重排结束）再释放；2.5s 兜底
        const wait = () => {
            const ready = (typeof OverlayState !== 'undefined')
                && OverlayState.fileId === targetFid && OverlayState.current;
            if (ready || Date.now() - t0 > 2500) {
                requestAnimationFrame(release);
            } else {
                requestAnimationFrame(wait);
            }
        };
        requestAnimationFrame(wait);
    }

    select.addEventListener('change', () => switchTo(select.value));
    loadAll();
})();


/* ===== match-panel2: 诊断匹配分析（数值统计+紧凑病症列表） =====
   函数式术语匹配：AI 诊断病症（阈值过滤后、未被拒绝）× 报告检查结论。
   结论优先审核报告（revised_*），无审核则原始报告（original_*）；字段
   缺失时从正文解析「检查结论/影像结论/检查诊断/影像诊断」段。
   命中规则：病症名同义组扩展后在结论分句中包含命中。
   展示：头部命中率百分比 + 统计行（命中/未命中/共）+ 病症行（圆点表状态）。
   轮询 sig 去重重算：诊断刷新/阈值变化/序列切换/报告到达均自动更新。 */
(function initMatchPanel() {
    // 经主站 /radar 前缀访问时，同源垫片会给根绝对路径补 /radar 前缀，
    // 教学系统接口必须用带 origin 的绝对地址才不会被打回 RADAR 自身。
    const TEACHING_API = (window.location.pathname.indexOf('/radar') === 0
        ? window.location.origin : 'http://127.0.0.1:8888');
    const GROUPS = [
        ['扩张', '扩涨', '增宽'],
        ['结石', '石症'],
        ['积水', '积液性扩张'],
        ['囊肿', '囊性'],
        ['钙化', '钙化灶'],
        ['高密度影', '高密度灶', '致密影', '高密度'],
        ['积液', '积液中'],
        ['结节', '结节状'],
        ['肿块', '占位', '肿瘤'],
        ['增大', '肥大', '体积增大'],
        ['萎缩', '缩小'],
        ['炎', '炎症'],
        ['出血', '血肿'],
        ['狭窄', '变窄'],
        ['梗阻', '阻塞'],
    ];
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
    function keywords(finding) {
        const f = norm(finding);
        const kws = new Set([f]);
        for (const g of GROUPS) {
            if (g.some(m => f.includes(m))) g.forEach(m => kws.add(m));
        }
        return [...kws];
    }
    function splitConclusion(text) {
        return String(text == null ? '' : text)
            .split(/[\n\r；;。]+/)
            .map(s => s.trim())
            .filter(s => s.length >= 4);
    }
    function conclusionOf(d) {
        const revised = !!d.is_reviewed;
        let c = revised ? d.revised_diagnosis : d.original_diagnosis;
        if (!String(c == null ? '' : c).trim()) {
            const txt = String(revised ? d.revised_report : d.original_report) || '';
            const m = txt.match(/(?:检查结论|影像结论|检查诊断|影像诊断)[：:]([\s\S]*)$/);
            c = m ? m[1] : '';
        }
        return String(c == null ? '' : c);
    }
    const state = { ctx: undefined, ctxFid: null, detail: null, detailKey: null, sig: null };
    function ctxFromUrl() {
        const qs = new URLSearchParams(window.location.search);
        const c = qs.get('case_id');
        return c ? { case_id: c, examination_id: qs.get('examination_id') || null } : null;
    }
    async function ensureCtx() {
        const u = ctxFromUrl();
        if (u) return u;
        const fid = (typeof AppState !== 'undefined') ? AppState.currentFileId : null;
        // 影像尚未载入时不缓存 null：面板初始化早于换片时若把空值记住，
        // 后续诊断完成再刷新也永远拿不到病例溯源。
        if (!fid) return null;
        if (state.ctx !== undefined && state.ctxFid === fid) return state.ctx;
        state.ctxFid = fid;
        try {
            const r = await fetch('/api/case-context?file_id=' + encodeURIComponent(fid));
            const j = await r.json();
            state.ctx = (j && j.success) ? j : null;
        } catch (e) {
            // 反查失败不写空缓存，等下次刷新再试
        }
        return state.ctx;
    }
    async function ensureDetail(ctx) {
        const key = ctx.case_id + '|' + (ctx.examination_id || '');
        if (state.detailKey === key) return state.detail;
        state.detailKey = key;
        state.detail = null;
        const token = localStorage.getItem('token');
        if (!token) return null;
        const url = TEACHING_API + '/api/cases/' + encodeURIComponent(ctx.case_id)
            + '/reports/detail'
            + (ctx.examination_id ? '?examination_id=' + encodeURIComponent(ctx.examination_id) : '');
        try {
            const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
            if (r.ok) state.detail = await r.json();
            else if (r.status === 409 && !ctx.examination_id) {
                const examId = await resolveExaminationId(ctx.case_id, ctx.series_instance_uid);
                if (examId) {
                    const r2 = await fetch(TEACHING_API + '/api/cases/' + encodeURIComponent(ctx.case_id)
                        + '/reports/detail?examination_id=' + encodeURIComponent(examId),
                        { headers: { Authorization: 'Bearer ' + token } });
                    state.detail = r2.ok ? await r2.json() : null;
                } else {
                    state.detail = null;
                }
            } else {
                state.detail = null;
            }
        } catch (e) { state.detail = null; }
        return state.detail;
    }
    function findingsOf(d) {
        const revised = !!d.is_reviewed;
        let f = revised ? d.revised_findings : d.original_findings;
        if (!String(f == null ? '' : f).trim()) {
            const txt = String(revised ? (d.revised_report || '') : (d.original_report || ''));
            const m = txt.match(/(?:检查所见|影像所见|检查描述|影像描述)[：:]([\s\S]*?)(?=(?:检查结论|影像结论|检查诊断|影像诊断)[：:]|$)/);
            f = m ? m[1] : '';
        }
        return String(f == null ? '' : f);
    }
    function emptyNode(t) {
        const e = document.createElement('div');
        e.className = 'ovm-empty';
        e.textContent = t;
        return e;
    }
    async function refresh() {
        const listEl = document.getElementById('ovfMatchList');
        const rateEl = document.getElementById('ovfMatchRate');
        const statsEl = document.getElementById('ovfMatchStats');
        if (!listEl || !rateEl || !statsEl) return;
        const diagnoses = (((typeof AppState !== 'undefined' && AppState.currentDiagnosis)
            || {}).diagnoses || []).filter(d => !d.rejected);
        const ctx = await ensureCtx();
        const detail = ctx ? await ensureDetail(ctx) : null;
        const conclusion = detail ? conclusionOf(detail) : '';
        const findings = detail ? findingsOf(detail) : '';
        const sig = diagnoses.map(d => d.finding).join('|')
            + '#' + (ctx ? ctx.case_id : '-')
            + '#' + norm(conclusion) + '#' + norm(findings);
        if (state.sig === sig) return;
        state.sig = sig;
        listEl.innerHTML = '';
        statsEl.innerHTML = '';
        if (!diagnoses.length) {
            rateEl.textContent = '—';
            rateEl.className = 'ovf-match-rate';
            listEl.appendChild(emptyNode('暂无 AI 诊断项'));
            return;
        }
        if (!conclusion.trim() && !findings.trim()) {
            rateEl.textContent = '—';
            rateEl.className = 'ovf-match-rate';
            listEl.appendChild(emptyNode('暂无报告结论/所见可比对'));
            return;
        }
        const conclSegs = splitConclusion(conclusion);
        const findSegs = splitConclusion(findings);
        let hits = 0;
        const rows = [];
        for (const d of diagnoses) {
            const kws = keywords(d.finding);
            const inSegs = (sg) => sg.find(seg => {
                const n = norm(seg);
                return kws.some(k => n.includes(k));
            }) || null;
            const hitConcl = inSegs(conclSegs);
            const hitFind = hitConcl ? null : inSegs(findSegs);
            const hitSeg = hitConcl || hitFind;
            const src = hitConcl ? '结论' : (hitFind ? '所见' : '');
            if (hitSeg) hits++;
            const row = document.createElement('div');
            row.className = 'ovm-row ' + (hitConcl ? 'hit' : (hitFind ? 'hit-f' : 'miss'));
            const dot = document.createElement('span');
            dot.className = 'ovm-dot';
            const nm = document.createElement('span');
            nm.className = 'ovm-name';
            nm.textContent = (d.organ ? d.organ + ' - ' : '') + d.finding;
            nm.title = nm.textContent + (hitSeg ? '｜报告' + src + '：' + hitSeg : '｜报告未提及');
            const tag = document.createElement('span');
            tag.className = 'ovm-tag';
            tag.textContent = hitConcl ? '命中' : (hitFind ? '所见' : '未命中');
            row.appendChild(dot);
            row.appendChild(nm);
            row.appendChild(tag);
            rows.push(row);
        }
        rows.forEach(r => listEl.appendChild(r));
        statsEl.innerHTML = '<span class="s-hit">命中<b>' + hits + '</b></span>'
            + '<span class="s-miss">未命中<b>' + (diagnoses.length - hits) + '</b></span>'
            + '<span class="s-total">共<b>' + diagnoses.length + '</b></span>';
        const pct = Math.round(hits / diagnoses.length * 100);
        rateEl.textContent = pct + '%';
        rateEl.className = 'ovf-match-rate ' + (pct >= 60 ? 'r-high' : (pct >= 30 ? 'r-mid' : 'r-low'));
    }
    setInterval(refresh, 900);
    refresh();
})();

/* ===== matchpanel4: 结果列分带同步 =====
   把诊断匹配分析卡从影像学发现框内迁出，包进独立 result-col；再按左栏报告
   「检查所见/检查结论」两卡的实测像素，同步右列两卡高度与间隔，实现跨列
   同水平线对齐。报告栏隐藏（控制面板页签）或报告未到位时回退 65/35。 */
(function initResultCol() {
    function boot() {
        const find = document.getElementById('overlayFindings');
        const match = document.getElementById('ovfMatch');
        if (!find || !match) return;
        if (find.contains(match)) {
            const col = document.createElement('div');
            col.className = 'result-col';
            find.parentNode.insertBefore(col, find);
            col.appendChild(find);
            col.appendChild(match);
        }
        function syncBands() {
            const body = document.querySelector('.overlay-body');
            if (!body) return;
            const pane = document.getElementById('sidePaneReport');
            const secs = pane && !pane.hidden
                ? pane.querySelectorAll('.rpt-body > .rpt-sec') : [];
            const b = body.getBoundingClientRect();
            if (secs.length >= 2) {
                const s1 = secs[0].getBoundingClientRect();
                const s2 = secs[1].getBoundingClientRect();
                find.style.flex = '0 0 ' + Math.max(80, s1.bottom - b.top) + 'px';
                match.style.flex = '0 0 ' + Math.max(60, s2.height) + 'px';
                match.style.marginTop = Math.max(0, s2.top - s1.bottom) + 'px';
            } else {
                find.style.flex = '1 1 auto';
                match.style.flex = '0 0 35%';
                match.style.marginTop = '';
            }
        }
        setInterval(syncBands, 900);
        window.addEventListener('resize', syncBands);
        syncBands();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
