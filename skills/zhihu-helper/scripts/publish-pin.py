#!/usr/bin/env python3
"""发布知乎「想法」（Pin）— 像发朋友圈/微博一样发短内容

核心流程：
1. 打开知乎首页（或复用已有页面）
2. 找到"发想法"按钮并激活编辑器
3. 逐段输入想法内容（模拟真人打字）
4. 检查发布按钮状态 → 点击发布
5. ✅ 验证发布结果（编辑器清空 = 成功）
6. 记录发布到本地历史，防止重复

用法：
  python3 publish-pin.py --content "今天天气不错"            # 直接发
  python3 publish-pin.py --file /path/to/content.txt         # 从文件读
  python3 publish-pin.py --target-id xxx                     # 复用已有页面
  python3 publish-pin.py --check                             # 检查已发布记录
  python3 publish-pin.py --list                              # 列出已发布想法
  python3 publish-pin.py --dry-run                           # 测试不执行

返回格式：
  {"ok": true/false, "pinId": "xxx", "error": "原因"}
"""

import subprocess
import json
import sys
import time
import random
import os
import argparse
import hashlib
from datetime import datetime, timezone, timedelta

_SCOPE_ENV_NAMES = ['CLAUDE_AGENT_ID', 'CLAUDE_HOOK_AGENT_ID', 'agent_id']
CDP_PROXY = "http://127.0.0.1:3456"
MAX_RETRY = 3
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PIN_RECORDS_FILE = os.path.join(_SCRIPT_DIR, 'pin-records.json')
_BJT = timezone(timedelta(hours=8), 'Asia/Shanghai')


def _resolve_agent_scope(default_prefix='zhihu-pin'):
    for name in _SCOPE_ENV_NAMES:
        val = os.environ.get(name, '').strip()
        if val:
            return val
    return f"{default_prefix}-{int(time.time())}"


def curl_get(url: str) -> dict:
    result = subprocess.run(['curl', '-s', url], capture_output=True, text=True, timeout=15)
    try:
        return json.loads(result.stdout)
    except:
        return {"raw": result.stdout}


def curl_post(path: str, data: str = None, return_json=True):
    args = ['-s', '-X', 'POST', f'{CDP_PROXY}{path}']
    if data:
        args += ['--data-binary', data]
    result = subprocess.run(['curl'] + args, capture_output=True, text=True, timeout=30)
    if return_json:
        try:
            return json.loads(result.stdout)
        except:
            return {"raw": result.stdout}
    return result.stdout.strip()


def random_sleep(min_s, max_s):
    delay = random.uniform(min_s, max_s)
    time.sleep(delay)
    return delay


def ensure_proxy():
    result = subprocess.run(['curl', '-s', f'{CDP_PROXY}/health'],
                            capture_output=True, text=True, timeout=2)
    if result.returncode != 0 or '"status": "ok"' not in result.stdout:
        print("[proxy] 启动 cdp-proxy...")
        subprocess.Popen(['node', '/app/runtime/skills-user/web-access/scripts/cdp-proxy.mjs'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(15):
            time.sleep(0.5)
            result = subprocess.run(['curl', '-s', f'{CDP_PROXY}/health'],
                                    capture_output=True, text=True, timeout=2)
            if '"status": "ok"' in result.stdout:
                print("[proxy] cdp-proxy 就绪")
                return True
        print("[proxy] 启动失败")
        return False
    print("[proxy] cdp-proxy 已在运行")
    return True


# ============================================================
# 持久化记录（防止重复发布）
# ============================================================

def load_pin_records() -> list:
    if os.path.exists(PIN_RECORDS_FILE):
        try:
            with open(PIN_RECORDS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except:
            return []
    return []


def save_pin_records(records: list):
    os.makedirs(os.path.dirname(PIN_RECORDS_FILE), exist_ok=True)
    with open(PIN_RECORDS_FILE, "w", encoding="utf-8") as f:
        json.dump(records[-200:], f, ensure_ascii=False, indent=2)  # 只保留最近200条


def content_hash(content: str) -> str:
    return hashlib.md5(content.encode('utf-8')).hexdigest()[:16]


def check_already_posted(content: str) -> bool:
    """检查是否已经发过相同内容（基于内容 hash）"""
    h = content_hash(content)
    records = load_pin_records()
    for r in records:
        if r.get("contentHash") == h:
            return True
    return False


def record_pin(content: str, result_info: dict):
    """记录已发布的想法的"""
    records = load_pin_records()
    records.append({
        "contentHash": content_hash(content),
        "content": content[:100],
        "timestamp": datetime.now(_BJT).strftime("%Y-%m-%d %H:%M:%S"),
        "result": result_info,
    })
    save_pin_records(records)
    print(f"    [记录] 已保存到 {PIN_RECORDS_FILE}")


def count_today_pins() -> int:
    """今日已发想法数"""
    today = datetime.now(_BJT).strftime("%Y-%m-%d")
    records = load_pin_records()
    return sum(1 for r in records if r.get("timestamp", "").startswith(today))


# ============================================================
# 浏览器操作
# ============================================================

def check_pin_editor_state(target_id: str, agent_scope: str) -> dict:
    """检查想法编辑器状态 — 是否可见、是否已激活"""
    js = '''
    (() => {
        const editor = document.querySelector('.public-DraftEditor-content');
        if (!editor) return JSON.stringify({active: false, reason: 'editor_not_found'});
        
        const parent = editor.closest('.WritePinV2-Form');
        const isVisible = parent ? parent.style.display !== 'none' : true;
        
        // 检查编辑器里有没有内容
        const text = editor.textContent || '';
        
        return JSON.stringify({
            active: true,
            visible: isVisible,
            hasContent: text.length > 0,
            textLength: text.length,
        });
    })()
    '''
    result = curl_post(f"/eval?target={target_id}&metaAgentScope={agent_scope}", js)
    try:
        data = json.loads(result) if isinstance(result, str) else result
        if isinstance(data, dict):
            return data
        return {"active": False, "reason": "parse_error"}
    except:
        return {"active": False, "reason": "js_error"}


def activate_pin_editor(target_id: str, agent_scope: str) -> bool:
    """激活想法编辑器 — 找到并点击"发想法"按钮"""
    js = '''
    (() => {
        const allBtns = Array.from(document.querySelectorAll('button'));
        const pinBtn = allBtns.find(b => b.textContent.trim().includes('发想法'));
        if (pinBtn) {
            pinBtn.click();
            return JSON.stringify({ok: true});
        }
        // 可能已经激活了编辑器
        const editor = document.querySelector('.public-DraftEditor-content');
        if (editor) {
            return JSON.stringify({ok: true, editorAlreadyActive: true});
        }
        return JSON.stringify({ok: false, error: 'pin_button_not_found'});
    })()
    '''
    result = curl_post(f"/eval?target={target_id}&metaAgentScope={agent_scope}", js)
    try:
        data = json.loads(result) if isinstance(result, str) else result
        return data.get('ok', False)
    except:
        return False


def verify_content_in_editor(target_id: str, agent_scope: str, expected: str) -> bool:
    """✅ 验证：编辑器内容是否已成功输入"""
    state = check_pin_editor_state(target_id, agent_scope)
    if state.get("active") and state.get("textLength", 0) >= len(expected) * 0.7:
        # 内容长度达到预期的70%就算成功（可能有换行差异）
        return True
    print(f"    ⚠️ 内容输入验证: 期望 {len(expected)} 字, 实际 {state.get('textLength', 0)} 字")
    return False


def check_publish_button_enabled(target_id: str, agent_scope: str) -> dict:
    """✅ 验证：发布按钮是否可用"""
    js = '''
    (() => {
        const allBtns = Array.from(document.querySelectorAll('button'));
        // 找想法编辑器区域内的发布按钮
        const publishBtn = allBtns.find(b => 
            b.textContent.trim() === '发布' && b.closest('.WritePinV2-Form')
        );
        if (publishBtn) {
            return JSON.stringify({
                found: true,
                disabled: publishBtn.disabled || publishBtn.classList.contains('is-disabled'),
                text: publishBtn.textContent.trim()
            });
        }
        // 兜底：找任何"发布"按钮
        const fallback = allBtns.find(b => b.textContent.trim() === '发布');
        if (fallback) {
            return JSON.stringify({
                found: true,
                disabled: fallback.disabled || fallback.classList.contains('is-disabled'),
                text: fallback.textContent.trim(),
                fallback: true
            });
        }
        return JSON.stringify({found: false, error: 'publish_button_not_found'});
    })()
    '''
    result = curl_post(f"/eval?target={target_id}&metaAgentScope={agent_scope}", js)
    try:
        data = json.loads(result) if isinstance(result, str) else result
        if isinstance(data, dict):
            return data
        return {"found": False, "error": "parse_error"}
    except:
        return {"found": False, "error": "js_error"}


def click_publish(target_id: str, agent_scope: str) -> bool:
    """点击发布按钮"""
    js = '''
    (() => {
        const allBtns = Array.from(document.querySelectorAll('button'));
        const publishBtn = allBtns.find(b => 
            b.textContent.trim() === '发布' && b.closest('.WritePinV2-Form')
        );
        if (publishBtn && !publishBtn.disabled) {
            publishBtn.click();
            return JSON.stringify({ok: true});
        }
        const fallback = allBtns.find(b => b.textContent.trim() === '发布');
        if (fallback && !fallback.disabled) {
            fallback.click();
            return JSON.stringify({ok: true, fallback: true});
        }
        return JSON.stringify({ok: false, error: 'publish_button_not_found_or_disabled'});
    })()
    '''
    result = curl_post(f"/eval?target={target_id}&metaAgentScope={agent_scope}", js)
    try:
        data = json.loads(result) if isinstance(result, str) else result
        return data.get('ok', False)
    except:
        return False


def verify_publish_success(target_id: str, agent_scope: str) -> dict:
    """✅ 验证：想法是否发布成功
    
    验证策略：
    1. 编辑器内容是否已清空（成功发布后编辑器会重置）
    2. 页面是否出现了刚发布的想法的（通过内容片段检测）
    """
    random_sleep(2.0, 4.0)
    
    # 策略1：编辑器是否已清空
    state = check_pin_editor_state(target_id, agent_scope)
    editor_cleared = state.get("active") and state.get("textLength", 99) == 0
    
    # 策略2：检查页面中是否有刚发布的想法的提示
    js_check = '''
    (() => {
        // 检查是否有发布成功的提示
        const body = document.body.textContent || '';
        const hasSuccess = body.includes('想法发布成功') || body.includes('发布成功');
        
        // 检查编辑器是否重置为占位符状态
        const editor = document.querySelector('.public-DraftEditor-content');
        const editorReset = editor && (!editor.textContent || editor.textContent.trim() === '');
        
        return JSON.stringify({
            successIndicator: hasSuccess,
            editorReset: editorReset
        });
    })()
    '''
    check_result = curl_post(f"/eval?target={target_id}&metaAgentScope={agent_scope}", js_check)
    try:
        check_data = json.loads(check_result) if isinstance(check_result, str) else check_result
    except:
        check_data = {}
    
    if editor_cleared or check_data.get('editorReset') or check_data.get('successIndicator'):
        return {"ok": True, "editorCleared": editor_cleared, "checkData": check_data}
    
    return {"ok": False, "editorCleared": editor_cleared, "checkData": check_data, 
            "reason": "editor_not_cleared_no_success_indicator"}


def type_pin_content(target_id: str, agent_scope: str, content: str) -> bool:
    """逐段输入想法内容（模拟真人打字）"""
    if not content:
        return False

    paragraphs = [p for p in content.split('\n') if p.strip()]
    if not paragraphs:
        return False

    for i, para in enumerate(paragraphs):
        url = f"/type?target={target_id}&metaAgentScope={agent_scope}"
        curl_post(url, para.strip(), return_json=False)
        
        if i < len(paragraphs) - 1:
            curl_post(url, "\n", return_json=False)
            random_sleep(1.0, 3.0)
    
    random_sleep(0.5, 1.5)
    return True


# ============================================================
# 发布主流程
# ============================================================

def publish_pin_single_attempt(target_id: str, agent_scope: str,
                                content: str, attempt: int) -> dict:
    """单次尝试发布想法"""
    
    print(f"\n--- 尝试 #{attempt} ---")
    
    try:
        # 1. 激活编辑器
        if not activate_pin_editor(target_id, agent_scope):
            return {"ok": False, "error": "无法激活想法编辑器"}
        random_sleep(1.0, 2.5)
        
        # 2. 输入内容
        if not type_pin_content(target_id, agent_scope, content):
            return {"ok": False, "error": "内容输入失败"}
        
        # 3. ✅ 验证内容是否已输入
        if not verify_content_in_editor(target_id, agent_scope, content):
            print("    ⚠️ 内容输入可能不完整，继续尝试发布...")
        
        random_sleep(1.0, 3.0)
        
        # 4. ✅ 检查发布按钮状态
        btn_state = check_publish_button_enabled(target_id, agent_scope)
        print(f"    发布按钮: {'可用' if btn_state.get('found') and not btn_state.get('disabled') else '不可用'}")
        if not btn_state.get("found"):
            return {"ok": False, "error": "发布按钮未找到"}
        if btn_state.get("disabled"):
            print("    ⚠️ 发布按钮 disabled（可能 Draft.js 状态未同步）")
        
        # 5. 点击发布
        if not click_publish(target_id, agent_scope):
            return {"ok": False, "error": "发布按钮点击失败"}
        
        # 6. ✅ 验证发布结果
        verify_result = verify_publish_success(target_id, agent_scope)
        if verify_result.get("ok"):
            return {"ok": True, "verification": verify_result}
        else:
            return {"ok": False, "error": "发布后验证失败", "verification": verify_result}
    
    except Exception as e:
        return {"ok": False, "error": str(e)}


def publish_pin(content: str, agent_scope: str = None,
                existing_target: str = None, no_close: bool = False,
                force: bool = False) -> dict:
    """发布想法的主函数（含重试和验证）"""
    if agent_scope is None:
        agent_scope = _resolve_agent_scope()

    # ---- 已发布检查 ----
    if not force and check_already_posted(content):
        return {"ok": False, "alreadyPosted": True, 
                "message": "该内容已发布过，避免重复"}

    start_time = time.time()
    should_close = False
    target_id = existing_target

    try:
        # 打开或复用页面
        if not target_id:
            print("[打开页面] 知乎首页")
            resp = curl_get(f"{CDP_PROXY}/new?url=https://www.zhihu.com&metaAgentScope={agent_scope}")
            target_id = resp.get("targetId", "")
            if not target_id:
                return {"ok": False, "error": "无法创建浏览器页面"}
            should_close = True
        else:
            print(f"[复用页面] 导航到知乎首页 (target: {target_id})")
            curl_get(f"{CDP_PROXY}/navigate?target={target_id}&metaAgentScope={agent_scope}&url=https://www.zhihu.com")

        random_sleep(3.0, 6.0)
        print(f"    TARGET_ID: {target_id}")

        # 多次尝试
        last_error = None
        for attempt in range(1, MAX_RETRY + 1):
            result = publish_pin_single_attempt(target_id, agent_scope, content, attempt)
            
            if result.get("ok"):
                elapsed = round(time.time() - start_time, 2)
                print(f"\n✅ 想法发布成功！耗时 {elapsed}s")
                
                # 记录发布
                record_pin(content, {"ok": True, "targetId": target_id})
                
                return {
                    "ok": True,
                    "targetId": target_id,
                    "elapsed": f"{elapsed}s",
                    "content": content[:50] + ("..." if len(content) > 50 else ""),
                    "attempts": attempt,
                }
            
            last_error = result
            print(f"    尝试 #{attempt} 失败: {result.get('error')}")
            
            if attempt < MAX_RETRY:
                random_sleep(2.0, 4.0)
                # 刷新页面重试
                if target_id:
                    print("    [刷新页面]")
                    curl_get(f"{CDP_PROXY}/close?target={target_id}&metaAgentScope={agent_scope}")
                    random_sleep(1.0, 2.0)
                    resp = curl_get(f"{CDP_PROXY}/new?url=https://www.zhihu.com&metaAgentScope={agent_scope}")
                    target_id = resp.get("targetId", "")
                    random_sleep(3.0, 5.0)

        elapsed = round(time.time() - start_time, 2)
        return {
            "ok": False,
            "error": f"发布失败（尝试 {MAX_RETRY} 次）",
            "lastError": last_error,
            "targetId": target_id,
            "elapsed": f"{elapsed}s",
        }

    finally:
        if target_id and should_close and not no_close:
            curl_get(f"{CDP_PROXY}/close?target={target_id}&metaAgentScope={agent_scope}")
            print("\n[关闭页面]")


# ============================================================
# CLI 入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="发布知乎想法（Pin）v2")
    parser.add_argument("--content", help="想法内容（纯文字，不用Markdown）")
    parser.add_argument("--file", help="想法内容文件路径")
    parser.add_argument("--target-id", default=None, help="复用已有浏览器页面")
    parser.add_argument("--no-close", action="store_true", help="发布后不关闭页面")
    parser.add_argument("--dry-run", action="store_true", help="仅测试不执行")
    parser.add_argument("--force", action="store_true", help="强制发布（跳过重复检查）")
    parser.add_argument("--check", action="store_true", help="检查内容是否已发布")
    parser.add_argument("--list", action="store_true", help="列出已发布的想法")
    parser.add_argument("--today", action="store_true", help="查看今日已发布数量")
    args = parser.parse_args()

    # ---------- --list ----------
    if args.list:
        records = load_pin_records()
        if records:
            print(f"📋 已发布想法记录（共 {len(records)} 条）:")
            for r in records[-10:]:
                print(f"  {r.get('timestamp','?')} | {r.get('content','?')[:50]}")
        else:
            print("暂无发布记录")
        return

    # ---------- --today ----------
    if args.today:
        count = count_today_pins()
        print(f"今日已发布想法: {count} 条")
        return

    # ---------- --check ----------
    if args.check:
        if not args.content and not args.file:
            print("错误: --check 需要 --content 或 --file")
            sys.exit(1)
        content = None
        if args.file:
            with open(args.file, "r") as f:
                content = f.read().strip()
        elif args.content:
            content = args.content.strip()
        if check_already_posted(content):
            print("⚠️ 该内容已发布过")
        else:
            print("✅ 该内容未发布过")
        return

    # 获取内容
    content = None
    if args.file:
        with open(args.file, "r", encoding="utf-8") as f:
            content = f.read().strip()
    elif args.content:
        content = args.content.strip()

    if not content and not args.dry_run:
        print("错误: 需要提供 --content 或 --file")
        sys.exit(1)

    if args.dry_run:
        print("📋 想法发布计划:")
        print(f"  页面：{'复用已有' if args.target_id else '新建首页'}")
        print(f"  内容：{(content or '(无)')[:60]}")
        print(f"  页面管理：{'保持打开' if args.no_close else '关闭'}")
        print(f"  重复检查：{'跳过(force)' if args.force else '开启'}")
        print(f"\n  验证步骤:")
        print(f"    1. 激活编辑器 → 检查编辑器是否可见")
        print(f"    2. 输入内容   → 验证内容长度")
        print(f"    3. 检查发布按钮状态 → 是否可用")
        print(f"    4. 点击发布   → 验证编辑器是否清空")
        print(f"    5. 记录到本地 → {PIN_RECORDS_FILE}")
        return

    if not ensure_proxy():
        print("[error] cdp-proxy 不可用")
        sys.exit(1)

    scope = _resolve_agent_scope()
    result = publish_pin(content, scope, existing_target=args.target_id,
                         no_close=args.no_close, force=args.force)
    
    print("\n=== 结果 ===")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    
    if not result.get("ok"):
        sys.exit(1)


if __name__ == "__main__":
    main()
