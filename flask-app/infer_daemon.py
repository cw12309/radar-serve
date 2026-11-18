# -*- coding: utf-8 -*-
"""RADAR 常驻推理守护进程。

模型权重只加载一次并常驻本进程，主进程（Flask）通过 Unix socket 以
JSON 行协议提交推理任务，避免「每次诊断都重新加载 4.7GB 权重」的
分钟级开销。与旧的「一次性子进程」模式（infer_worker.py）相比：

  - 首次启动：加载权重（数十秒），之后所有诊断复用同一份权重；
  - 崩溃自愈：主进程发现连接断开/任务失败时自动重新拉起本进程，
    下一次诊断走一次性子进程兜底，服务不中断；
  - 内存隔离：权重仍不占用 Flask 主进程内存（主进程 RSS 不变），
    只是从「每次诊断一个短命进程」变成「一个长命进程」。

协议（单连接单任务，UTF-8 JSON 行）：
  请求：{"nifti": ..., "overlay": ..., "use_gpu": bool}\\n
  响应：{"success": bool, "result": ..., "organs": [...], "device": ...}
        或 {"success": false, "error": ...}\\n

用法：
    python infer_daemon.py --socket /tmp/radar_infer.sock [--use-gpu]
"""
import argparse
import gc
import json
import os
import socket
import sys
import traceback


def log(msg):
    print('[infer-daemon] %s' % msg, file=sys.stderr, flush=True)


def release_gpu():
    """把本次推理的显存（滑窗激活 + 缓存分配器预留块）归还给驱动。

    PyTorch 缓存分配器默认把峰值 reserved（实测约 3.3GB）长期攥在进程里
    不还给驱动；本机 GPU 被 vLLM/ollama 等多进程共用，攥住的下一次大块
    连续分配（或其他服务）就会 OOM。每次推理结束（无论成败）显式
    empty_cache 一次，让两次诊断之间显存真正释放、下一次从头申请。
    """
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001 - CPU 模式或无 torch 时直接跳过
        pass


def handle_conn(conn, engine):
    buf = b''
    while True:
        chunk = conn.recv(65536)
        if not chunk:
            return
        buf += chunk
        if b'\n' in buf:
            break
    line, buf = buf.split(b'\n', 1)
    task = json.loads(line.decode('utf-8'))
    result = engine.infer(task['nifti'], overlay_path=task.get('overlay'))
    payload = {
        'success': True,
        'result': result,
        'organs': list(engine.organs),
        'device': str(engine.device),
    }
    conn.sendall((json.dumps(payload, ensure_ascii=False) + '\n').encode('utf-8'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--socket', required=True, help='Unix socket 路径')
    parser.add_argument('--use-gpu', action='store_true', help='是否使用 GPU')
    args = parser.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    radar_web = os.path.join(here, '..', 'radar-web')
    sys.path.insert(0, os.path.join(radar_web, 'modules'))
    sys.path.insert(0, os.path.join(radar_web, 'utils'))

    from inference_engine import RADARInferenceEngine

    # 权重只加载一次；加载失败直接退出，由主进程降级到一次性子进程模式。
    engine = RADARInferenceEngine(use_gpu=args.use_gpu)
    engine.load_model()
    log('模型加载完成 device=%s，开始监听 %s' % (engine.device, args.socket))

    if os.path.exists(args.socket):
        os.remove(args.socket)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(args.socket)
    os.chmod(args.socket, 0o600)
    srv.listen(4)
    while True:
        conn, _ = srv.accept()
        with conn:
            # 异常响应必须在 with conn 内发送：此前 except 在 with 之外，
            # socket 已关闭导致 sendall 必失败，客户端只看到「连接提前关闭」
            # 而拿不到真实错误（如 CUDA OOM），无法做针对性降级。
            try:
                handle_conn(conn, engine)
            except Exception as exc:  # noqa: BLE001 - 单任务失败不应拖垮常驻进程
                log('任务异常: %r' % (exc,))
                try:
                    conn.sendall((json.dumps(
                        {'success': False, 'error': str(exc)},
                        ensure_ascii=False) + '\n').encode('utf-8'))
                except OSError:
                    pass
            finally:
                # 推理结束即释放本次影像/激活显存，下一次诊断从干净显存重新申请
                release_gpu()


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        log('致命错误退出: %r' % (exc,))
        sys.exit(1)
