# -*- coding: utf-8 -*-
"""RADAR 推理子进程 worker。

主进程（Flask）不再常驻模型权重，诊断时以独立子进程运行本脚本：
子进程独占系统内存加载模型并跑完整滑窗推理，结束后把结构化结果
（含 organs 列表、overlay 是否导出）写入 --result 指定的 JSON 文件，
主进程读取后原样返回。这样可把「模型常驻 4.7GB + 推理峰值 9.5GB」
的叠加隔离开，跑完即随进程退出释放，避免超出系统提交余量。

用法：
    python infer_worker.py --nifti <path> --result <path.json> \
        [--overlay <path.npz>] [--use-gpu]

约定：
  - 结果走 --result 文件（stdout 只打印一行 OK/ERROR 便于主进程判断）；
  - 日志与异常堆栈走 stderr，主进程转发到自己的 logger；
  - 退出码 0 表示成功，非 0 表示失败（result 文件里也带 error 字段）。
"""
import argparse
import json
import sys
import traceback


def wait_overlay_export(path, timeout=600):
    """等后台 overlay 导出线程把 npz 落盘再退出。

    inference_engine 把叠加数据导出放在 daemon 线程里（诊断接口不等它），
    本脚本是一次性子进程，main 返回后进程退出会直接强杀该线程。GPU 被
    vLLM/ollama 占满、守护进程 OOM 降级到本进程时，overlay.npz 因此永远
    不生成，前端取 /api/overlay/<id>/meta 一直 404、叠加影像显示不出来。
    导出端先写 .tmp.npz 再 os.replace，出现即完整，故只等最终文件。
    """
    import os
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(path) and os.path.getsize(path) > 0:
            return True
        time.sleep(0.5)
    print('[infer-worker] 等待 overlay 导出超时: %s' % path,
          file=sys.stderr, flush=True)
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--nifti', required=True, help='推理输入 NIfTI 路径')
    parser.add_argument('--result', required=True, help='结果 JSON 输出路径')
    parser.add_argument('--overlay', default=None, help='可选 overlay.npz 导出路径')
    parser.add_argument('--use-gpu', action='store_true', help='是否使用 GPU')
    args = parser.parse_args()

    def write_result(payload):
        with open(args.result, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False)

    try:
        # 与 app.py 相同的模块搜索路径，确保能 import inference_engine
        import os
        here = os.path.dirname(os.path.abspath(__file__))
        radar_web = os.path.join(here, '..', 'radar-web')
        sys.path.insert(0, os.path.join(radar_web, 'modules'))
        sys.path.insert(0, os.path.join(radar_web, 'utils'))

        from inference_engine import (
            RADARInferenceEngine, RADARInferenceError)

        engine = RADARInferenceEngine(use_gpu=args.use_gpu)
        engine.load_model()
        result = engine.infer(args.nifti, overlay_path=args.overlay)
        # 子进程退出即强杀后台导出线程，必须先等 npz 落盘再写结果
        if args.overlay:
            wait_overlay_export(args.overlay)
            if (result.get('overlay') or {}).get('pending'):
                result['overlay'] = {
                    'pending': not os.path.exists(args.overlay),
                }

        payload = {
            'success': True,
            'result': result,
            # organs 回传主进程缓存，供 overlay meta/mesh 路由显示器官名，
            # 主进程无需再常驻模型即可拿到这份硬编码列表。
            'organs': list(engine.organs),
            'device': str(engine.device),
        }
        write_result(payload)
        print('OK', flush=True)
    except RADARInferenceError as e:
        # 引擎的主动拦截（如「影像过大」），带明确中文说明
        write_result({'success': False, 'error': str(e), 'error_type': 'inference'})
        print(f'ERROR: {e}', file=sys.stderr, flush=True)
        sys.exit(2)
    except Exception as e:  # noqa: BLE001
        write_result({'success': False, 'error': str(e),
                      'traceback': traceback.format_exc()})
        print(f'ERROR: {type(e).__name__}: {e}', file=sys.stderr, flush=True)
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()
