# -*- coding: utf-8 -*-
"""腹部疾病报告专业撰写 Agent（LLM 接入层）。

在医生采纳 AI 发现（可附影像所见）后，调用 OpenAI 兼容的大模型接口，
把「AI 阳性发现 + 医生采纳意见」整理成专业的影像所见与诊断结论，
供 PDF 报告渲染。模型不可用时返回 None，由调用方回退模板文案，
保证报告生成永不因 LLM 失败而中断。
"""
import json
import logging
import os
import re
import time
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

# 环境变量可覆盖（部署时按需调整）
DEFAULT_BASE_URL = os.environ.get('REPORT_LLM_BASE_URL', 'http://14.22.86.97:11001/v1')
DEFAULT_MODEL = os.environ.get('REPORT_LLM_MODEL', 'qwen38-27b-awq-int4')
DEFAULT_API_KEY = os.environ.get('REPORT_LLM_API_KEY', 'EMPTY')
DEFAULT_TIMEOUT = float(os.environ.get('REPORT_LLM_TIMEOUT', '120'))

# 统一 AI 配置接入：清华平台「AI 配置」保存的模型连接与报告生成提示词。
# RADAR 与平台后端同机部署，后端容器内 /app/data 即宿主机 runtime-config，
# 通过 nginx /api 反代到后端；内部端点需携带 RADAR_INTERNAL_TOKEN。
QINHUA_AI_CONFIG_URL = os.environ.get(
    'QINHUA_AI_CONFIG_URL', 'http://127.0.0.1:11002/api/llm/internal/config')
QINHUA_AI_TOKEN = os.environ.get('RADAR_INTERNAL_TOKEN', '')
_CONFIG_TTL = float(os.environ.get('QINHUA_AI_CONFIG_TTL', '30'))

SYSTEM_PROMPT = (
    '你是一位资深腹部CT影像诊断报告撰写医师，拥有20年三甲医院放射科报告经验。'
    '你的任务：根据AI辅助诊断系统检出的阳性发现、以及放射科医师逐项采纳时填写的影像所见，'
    '撰写一份规范、专业的腹部CT影像学报告文字。\n'
    '撰写要求：\n'
    '1. 使用放射科报告的标准术语与句式（如「肝脏体积形态如常」「见类圆形低密度影，边界清楚」'
    '「双肾对称，实质密度未见异常」等），客观描述病灶部位、大小（如提供）、密度/信号、边界、'
    '数目及毗邻关系，避免口语化。\n'
    '2. 医师填写的影像所见（doctor_note）是人工核对原始影像后的权威意见，必须优先采信并融入描述；'
    'AI 发现（organ/finding/confidence）作为补充线索，二者冲突时以医师所见为准。\n'
    '3. 若提供 clinical_context（患者基本信息、主诉和病史、院内原始报告），须结合临床背景撰写：'
    '病史中与本次影像相关的线索（如血尿、腹痛、既往结石/手术史）应自然融入所见与印象的论证；'
    '院内原始报告仅作对照参考，与当前 AI+医师意见一致时可互相印证，冲突时以当前医师意见为准，'
    '不得照抄原始报告原文，也不得引入原始报告中未被当前发现支持的病灶。\n'
    '4. 诊断印象（impression）应给出影像学诊断倾向，按临床重要性排序；对不能定性者用'
    '「考虑」「可能」「不除外」等审慎表述，并注明建议进一步检查方式。\n'
    '5. 随访建议（recommendations）须具体可执行（复查方式、间隔、专科），合并同类项、去重。\n'
    '6. 严禁编造输入中不存在的病灶、量化数值或病史；无阳性发现时如实书写阴性报告。\n'
    '7. 输出严格JSON（无markdown代码块、无多余文字），结构如下：\n'
    '{"findings": [{"index": 1, "description": "该项的专业影像学所见描述（60-150字）"}],\n'
    ' "impression": "影像学诊断印象（一段话，100-250字）",\n'
    ' "conclusion": "总体结论（一段话，60-150字，综合AI检出与医师意见的整体评估）",\n'
    ' "recommendations": ["建议1", "建议2"]}\n'
    'findings 的 index 与输入 findings 的 index 一一对应。'
)

_SEV_LABELS = {'high': '高风险', 'medium': '中风险', 'low': '低风险'}

# 统一 AI 配置缓存：(拉取时间, 配置dict)；失败时保留旧值，TTL 内不重试
_UNIFIED_CACHE = {'ts': 0.0, 'cfg': None}


def _fetch_unified_ai_config() -> Optional[Dict]:
    """从清华平台「AI 配置」拉取模型连接与报告生成提示词。

    30s TTL 缓存；token 未配置或平台不可达时返回 None，调用方回退
    环境变量/内置默认，保证报告生成永不因配置通道失败而中断。
    """
    now = time.time()
    if _UNIFIED_CACHE['cfg'] is not None and now - _UNIFIED_CACHE['ts'] < _CONFIG_TTL:
        return _UNIFIED_CACHE['cfg']
    cfg = _UNIFIED_CACHE['cfg']
    if not QINHUA_AI_TOKEN:
        return cfg
    try:
        resp = requests.get(
            QINHUA_AI_CONFIG_URL,
            headers={'X-Radar-Token': QINHUA_AI_TOKEN},
            timeout=5)
        resp.raise_for_status()
        data = resp.json()
        if data.get('base_url') and data.get('model_name'):
            cfg = {
                'base_url': data['base_url'].rstrip('/'),
                'model': data['model_name'],
                'api_key': data.get('api_key') or 'EMPTY',
                'prompt': (data.get('report_compose_prompt') or '').strip(),
            }
            _UNIFIED_CACHE['ts'] = now
            _UNIFIED_CACHE['cfg'] = cfg
    except Exception as exc:  # noqa: BLE001 - 配置通道失败回退本地默认
        logger.debug('[report-agent] 拉取统一AI配置失败，回退本地配置: %s', exc)
    return cfg


class ReportAgent:
    """大模型报告撰写 Agent（OpenAI 兼容 chat/completions）。"""

    def __init__(self,
                 base_url: str = DEFAULT_BASE_URL,
                 model: str = DEFAULT_MODEL,
                 api_key: str = DEFAULT_API_KEY,
                 timeout: float = DEFAULT_TIMEOUT):
        self.base_url = base_url.rstrip('/')
        self.model = model
        self.api_key = api_key
        self.timeout = timeout

    # ------------------------------------------------------------------ #
    # 对外主入口
    # ------------------------------------------------------------------ #
    def effective_config(self) -> Dict[str, str]:
        """生效的模型连接与撰写提示词。

        优先取清华平台「AI 配置」的统一配置（模型连接 + 报告生成提示词），
        通道不可达或未配置 token 时回退实例初始化值（环境变量/内置默认）。
        """
        cfg = _fetch_unified_ai_config() or {}
        return {
            'base_url': cfg.get('base_url') or self.base_url,
            'model': cfg.get('model') or self.model,
            'api_key': cfg.get('api_key') or self.api_key,
            'prompt': cfg.get('prompt') or SYSTEM_PROMPT,
        }

    def compose(self,
                diagnosis_result: Dict,
                patient_info: Optional[Dict] = None) -> Optional[Dict]:
        """生成专业报告文字。

        Returns:
            {'findings': [{index, description}], 'impression': str,
             'conclusion': str, 'recommendations': [str]}；失败返回 None。
        """
        payload = self._build_payload(diagnosis_result, patient_info or {})
        try:
            raw = self._chat(payload, self.effective_config())
            parsed = self._parse_json(raw)
            return self._validate(parsed)
        except Exception as exc:  # noqa: BLE001 - 任何失败都回退模板
            logger.warning('[report-agent] LLM 撰写失败，回退模板: %s', exc)
            return None

    # ------------------------------------------------------------------ #
    # 提示词构造
    # ------------------------------------------------------------------ #
    def _build_payload(self, diagnosis_result: Dict, patient_info: Dict) -> str:
        diagnoses: List[Dict] = diagnosis_result.get('diagnoses') or []
        meta = diagnosis_result.get('metadata') or patient_info or {}

        # 患者与检查信息（只带非空字段）
        pinfo = {}
        for key in ('patient_id', 'patient_age', 'patient_sex', 'study_date',
                    'modality', 'body_part', 'institution', 'slice_thickness'):
            v = meta.get(key) or patient_info.get(key)
            if v not in (None, ''):
                pinfo[key] = v

        findings = []
        for i, d in enumerate(diagnoses, 1):
            item = {
                'index': i,
                'organ': d.get('organ', ''),
                'finding': d.get('finding', ''),
                'finding_en': d.get('finding_en', ''),
                'confidence': float(d.get('confidence') or 0),
                'severity': _SEV_LABELS.get(d.get('severity'), d.get('severity', '')),
                'recommendation': d.get('recommendation', ''),
            }
            note = (d.get('note') or '').strip()
            if note:
                item['doctor_note'] = note
            findings.append(item)

        threshold = (diagnosis_result.get('settings') or {}).get('confidence_threshold')
        user = {
            'task': '撰写腹部CT影像学报告',
            'patient_info': pinfo,
            'clinical_context': self._build_clinical_context(patient_info),
            'confidence_threshold': threshold,
            'findings': findings,
            'note': ('findings 为放射科医师已逐项采纳的阳性发现；doctor_note 为医师采纳时'
                     '填写的影像所见（可能为空）。请按系统要求输出严格JSON。'
                     if findings else
                     'findings 为空表示未检出被采纳的阳性发现，请如实撰写阴性报告。'),
        }
        return json.dumps(user, ensure_ascii=False, indent=1)

    # ------------------------------------------------------------------ #
    # 临床背景（清华教学库：患者信息 + 主诉病史 + 原始报告对照）
    # ------------------------------------------------------------------ #
    @staticmethod
    def _build_clinical_context(patient_info: Dict) -> Optional[Dict]:
        """从 patient_info 的临床字段组装 LLM 临床背景；无内容返回 None。

        字段由 app.py 从院内影像库溯源快照（library_context）映射而来：
        患者姓名/性别/年龄/病历号、主诉和病史（clinical_history）、
        院内原始报告（original_report，仅取所见/印象/正文，截断防爆 token）。
        """
        ctx: Dict[str, Any] = {}
        patient = {
            'name': patient_info.get('patient_name'),
            'sex': patient_info.get('gender') or patient_info.get('patient_sex'),
            'age': patient_info.get('age') or patient_info.get('patient_age'),
            'medical_record_no': patient_info.get('medical_record_no'),
        }
        patient = {k: v for k, v in patient.items() if v not in (None, '')}
        if patient:
            ctx['patient'] = patient

        history = (patient_info.get('clinical_history') or '').strip()
        if history:
            ctx['clinical_history'] = history[:2000]

        report = (patient_info.get('original_report') or '').strip()
        if report:
            ctx['original_report'] = report[:3000]

        return ctx or None

    # ------------------------------------------------------------------ #
    # LLM 调用与解析
    # ------------------------------------------------------------------ #
    def _chat(self, user_payload: str, eff: Dict[str, str]) -> str:
        resp = requests.post(
            f'{eff["base_url"]}/chat/completions',
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {eff["api_key"]}',
            },
            json={
                'model': eff['model'],
                'messages': [
                    {'role': 'system', 'content': eff['prompt']},
                    {'role': 'user', 'content': user_payload},
                ],
                'temperature': 0.3,
                'max_tokens': 4096,
            },
            timeout=self.timeout,
        )
        resp.raise_for_status()
        data = resp.json()
        content = (data.get('choices') or [{}])[0].get('message', {}).get('content', '')
        # qwen3 思考模式：reasoning 可能混入 content，剥离思考段
        content = re.sub(r'<think>.*?</think>', '', content, flags=re.S)
        content = content.replace('</think>', '')
        return content.strip()

    @staticmethod
    def _parse_json(text: str) -> Any:
        """从模型输出中容错提取 JSON 对象。"""
        text = text.strip()
        # 去掉 markdown 代码围栏
        fence = re.search(r'```(?:json)?\s*(.*?)```', text, flags=re.S)
        if fence:
            text = fence.group(1).strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass
        # 截取首个 { 到末个 }
        start, end = text.find('{'), text.rfind('}')
        if start != -1 and end > start:
            return json.loads(text[start:end + 1])
        raise ValueError('模型输出中未找到合法JSON')

    @staticmethod
    def _validate(obj: Any) -> Optional[Dict]:
        """校验并规整 LLM 输出，字段不合法返回 None。"""
        if not isinstance(obj, dict):
            return None
        findings = []
        for f in obj.get('findings') or []:
            if isinstance(f, dict) and str(f.get('description', '')).strip():
                findings.append({
                    'index': f.get('index'),
                    'description': str(f['description']).strip(),
                })
        impression = str(obj.get('impression') or '').strip()
        conclusion = str(obj.get('conclusion') or '').strip()
        recs = [str(r).strip() for r in (obj.get('recommendations') or [])
                if str(r or '').strip()]
        if not (findings or impression or conclusion or recs):
            return None
        return {
            'findings': findings,
            'impression': impression,
            'conclusion': conclusion,
            'recommendations': recs,
        }
