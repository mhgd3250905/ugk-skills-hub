#!/usr/bin/env python3
"""模拟真人日常刷知乎 — 浏览热榜/首页、阅读回答、点赞、划走

行为模式（模拟真人）：
1. 打开热榜或首页
2. 慢慢滚动浏览（不是一下子到底）
3. 随机点开几个感兴趣的问题
4. 阅读回答（停留随机时间）
5. 给觉得"不错"的回答点赞
6. 偶尔划走、关掉、再看别的
7. 随机浏览时长 5~20 分钟

用法：
  python3 simulate-browsing.py              # 默认热榜浏览 5~15 分钟
  python3 simulate-browsing.py --home        # 浏览首页推荐流
  python3 simulate-browsing.py --minutes 10  # 指定浏览时长（分钟）
  python3 simulate-browsing.py --dry-run     # 打印计划但不执行
"""

import subprocess
import json
import sys
import time
import random
import os
import argparse

# Scope env names matching browser-cleanup.ts and agent-run-scope.ts
_SCOPE_ENV_NAMES = ['CLAUDE_AGENT_ID', 'CLAUDE_HOOK_AGENT_ID', 'agent_id']

CDP_PROXY = "http://127.0.0.1:3456"

# 行为参数
MIN_BROWSE_SECONDS = 5 * 60      # 最短浏览 5 分钟
MAX_BROWSE_SECONDS = 20 * 60     # 最长浏览 20 分钟
SCROLL_INTERVAL = (2, 6)         # 每次滚动间隔 2~6 秒
SCROLL_DISTANCE = (200, 800)     # 每次滚动距离 200~800px
PAGE_READ_TIME = (10, 45)        # 打开一个问题页面后停留 10~45 秒
ANSWER_READ_TIME = (8, 30)       # 读一条回答 8~30 秒
LIKE_PROBABILITY = 0.3           # 看完一个回答后点赞的概率 30%
BROWSE_PROBABILITY = 0.4         # 滚动时随机点击问题的概率 40%


def _resolve_agent_scope(default_prefix='zhihu-browse'):
    for name in _SCOPE_ENV_NAMES:
        val = os.environ.get(name, '').strip()
        if val:
            return val
    return f"{default_prefix}-{int(time.time())}"


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


def curl_post(path: str, data: str = None, return_json=True):
    """发送请求到 cdp-proxy"""
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
    """随机等待，模拟真人行为"""
    delay = random.uniform(min_s, max_s)
    time.sleep(delay)
    return delay


def simulate_scroll(target_id: str, scope: str, count: int = None):
    """模拟真人滚动页面 — 慢慢划，不是一下子拉到底"""
    if count is None:
        count = random.randint(3, 8)  # 随机滚动 3~8 次

    print(f"  [scroll] 开始滚动，约 {count} 次...")
    for i in range(count):
        scroll_y = random.randint(*SCROLL_DISTANCE)
        _ = curl_post(f"/eval?target={target_id}&metaAgentScope={scope}",
                       f"window.scrollBy(0, {scroll_y})")
        delay = random_sleep(*SCROLL_INTERVAL)
        print(f"  [scroll] 第{i+1}次，滚动{scroll_y}px，停顿{delay:.1f}s")


def pick_random_questions(target_id: str, scope: str):
    """从当前页面提取问题链接，随机挑几个感兴趣的"""
    # 先执行 JS 获取页面上的问题链接
    js = '''
    (() => {
        const links = document.querySelectorAll('a[href*="/question/"]');
        const questions = [];
        const seen = new Set();
        links.forEach(a => {
            const m = a.href.match(/zhihu\\.com\\/question\\/(\\d+)/);
            if (m && !seen.has(m[1])) {
                seen.add(m[1]);
                questions.push({
                    id: m[1],
                    title: a.textContent?.trim()?.substring(0, 60) || '(无标题)',
                    url: a.href
                });
            }
        });
        return JSON.stringify(questions.slice(0, 20));
    })()
    '''
    result = curl_post(f"/eval?target={target_id}&metaAgentScope={scope}", js)
    if isinstance(result, dict) and 'raw' in result:
        return []
    try:
        questions = json.loads(result) if isinstance(result, str) else result
        if not questions:
            return []
        # 随机挑 1~3 个问题点进去看看
        pick_count = min(random.randint(1, 3), len(questions))
        picked = random.sample(questions, pick_count)
        return picked
    except:
        return []


def navigate_and_read(target_id: str, scope: str, url: str, title: str):
    """导航到问题页面并假装阅读"""
    print(f"  [read] 打开问题：{title[:40]}...")
    curl_post(f"/navigate?target={target_id}&metaAgentScope={scope}&url={url}")
    read_time = random_sleep(*PAGE_READ_TIME)
    print(f"  [read] 阅读了 {read_time:.1f}s")

    # 滚动阅读回答
    simulate_scroll(target_id, scope, count=random.randint(2, 5))

    # 随机给某条回答点赞
    if random.random() < LIKE_PROBABILITY:
        like_random_answer(target_id, scope)
    
    # 阅读完毕，返回
    print(f"  [read] 看完，返回")


def like_random_answer(target_id: str, scope: str):
    """随机给当前页面某条回答点赞"""
    js = '''
    (() => {
        // 找到所有点赞按钮
        const voteBtns = document.querySelectorAll('.VoteButton[aria-label*="赞"], button.VoteButton:not(.is-active)');
        if (voteBtns.length === 0) return JSON.stringify({success: false, reason: "no_vote_buttons"});
        // 随机选一个
        const idx = Math.floor(Math.random() * voteBtns.length);
        const btn = voteBtns[idx];
        btn.click();
        return JSON.stringify({success: true, index: idx});
    })()
    '''
    result = curl_post(f"/eval?target={target_id}&metaAgentScope={scope}", js)
    delay = random_sleep(1.0, 3.0)
    try:
        data = json.loads(result) if isinstance(result, str) else result
        if isinstance(data, dict) and data.get('success'):
            print(f"  [like] 👍 点了个赞 (延迟{delay:.1f}s)")
        else:
            print(f"  [like] 没找到可点赞的按钮")
    except:
        print(f"  [like] 尝试点赞")


def browse_hotlist(scope: str, minutes: int = None, existing_target: str = None,
                   keep_open: bool = False):
    """浏览知乎热榜（复用页面或新建页面）"""
    print("\n🔥 开始浏览知乎热榜...")
    
    should_close = False
    if existing_target:
        target_id = existing_target
        curl_post(f"/navigate?target={target_id}&metaAgentScope={scope}&url=https://www.zhihu.com/hot")
        print(f"  [session] 复用已有页面: {target_id}")
    else:
        target_info = curl_post(f"/new?url=https://www.zhihu.com/hot&metaAgentScope={scope}")
        target_id = target_info.get('targetId')
        should_close = not keep_open
    
    if not target_id:
        print("[browse] 无法打开热榜页面")
        return {"ok": False, "targetId": None}
    
    try:
        random_sleep(2, 4)
        print("[browse] 页面已加载，开始滚动浏览...")
        
        total_seconds = minutes * 60 if minutes else random.randint(MIN_BROWSE_SECONDS, MAX_BROWSE_SECONDS)
        print(f"  [info] 计划浏览 {total_seconds//60} 分钟")
        
        start_time = time.time()
        elapsed = 0
        
        while elapsed < total_seconds:
            simulate_scroll(target_id, scope)
            
            if random.random() < BROWSE_PROBABILITY:
                questions = pick_random_questions(target_id, scope)
                if questions:
                    for q in questions:
                        q_url = q['url'] if q['url'].startswith('http') else f"https://www.zhihu.com/question/{q['id']}"
                        navigate_and_read(target_id, scope, q_url, q['title'])
                        curl_post(f"/navigate?target={target_id}&metaAgentScope={scope}&url=https://www.zhihu.com/hot")
                        random_sleep(2, 4)
                        elapsed = time.time() - start_time
                        if elapsed >= total_seconds:
                            break
            
            elapsed = time.time() - start_time
            remaining = total_seconds - elapsed
            if remaining > 60:
                print(f"  [info] 已刷 {int(elapsed//60)} 分钟，还剩约 {int(remaining//60)} 分钟")
            elif remaining > 0:
                print(f"  [info] 快结束了，再刷 {int(remaining)} 秒")
        
        print(f"\n✅ 热榜浏览结束，共 {int(elapsed//60)} 分钟")
        return {"ok": True, "targetId": target_id, "elapsed": elapsed}
        
    finally:
        if should_close:
            curl_post(f"/close?target={target_id}&metaAgentScope={scope}")
            print("[browse] 页面已关闭")


def browse_home_feed(scope: str, minutes: int = None, existing_target: str = None,
                     keep_open: bool = False):
    """浏览知乎首页推荐流（复用页面或新建页面）"""
    print("\n🏠 开始浏览知乎首页推荐流...")
    
    should_close = False
    if existing_target:
        target_id = existing_target
        curl_post(f"/navigate?target={target_id}&metaAgentScope={scope}&url=https://www.zhihu.com")
        print(f"  [session] 复用已有页面: {target_id}")
    else:
        target_info = curl_post(f"/new?url=https://www.zhihu.com&metaAgentScope={scope}")
        target_id = target_info.get('targetId')
        should_close = not keep_open
    
    if not target_id:
        print("[browse] 无法打开首页")
        return {"ok": False, "targetId": None}
    
    try:
        random_sleep(2, 4)
        print("[browse] 首页已加载，开始刷推荐流...")
        
        total_seconds = minutes * 60 if minutes else random.randint(MIN_BROWSE_SECONDS, MAX_BROWSE_SECONDS)
        print(f"  [info] 计划浏览 {total_seconds//60} 分钟")
        
        start_time = time.time()
        
        while time.time() - start_time < total_seconds:
            simulate_scroll(target_id, scope, count=random.randint(2, 6))
            
            if random.random() < BROWSE_PROBABILITY:
                questions = pick_random_questions(target_id, scope)
                if questions:
                    for q in questions:
                        q_url = q['url'] if q['url'].startswith('http') else f"https://www.zhihu.com/question/{q['id']}"
                        navigate_and_read(target_id, scope, q_url, q['title'])
                        curl_post(f"/navigate?target={target_id}&metaAgentScope={scope}&url=https://www.zhihu.com")
                        random_sleep(2, 4)
                        elapsed = time.time() - start_time
                        if elapsed >= total_seconds:
                            break
            
            elapsed = time.time() - start_time
            remaining = total_seconds - elapsed
            if remaining > 60:
                print(f"  [info] 已刷 {int(elapsed//60)} 分钟，还剩约 {int(remaining//60)} 分钟")
        
        elapsed_total = time.time() - start_time
        print(f"\n✅ 首页浏览结束，共 {int(elapsed_total//60)} 分钟")
        return {"ok": True, "targetId": target_id, "elapsed": elapsed_total}
        
    finally:
        if should_close:
            curl_post(f"/close?target={target_id}&metaAgentScope={scope}")
            print("[browse] 页面已关闭")


def write_answer_in_session(target_id: str, scope: str, question_id: str,
                            content: str):
    """在同一个会话中发表回答（复用已有浏览器页面）
    
    调用 publish-answer.py 的 publish_answer 函数，传入 existing_target
    """
    print(f"\n✍️  在同一会话中回答问题 {question_id}...")
    
    # 导航到问题页面
    curl_post(f"/navigate?target={target_id}&metaAgentScope={scope}&url=https://www.zhihu.com/question/{question_id}")
    random_sleep(3, 6)
    
    # 调用 publish_answer 的核心函数，复用当前 target
    # （通过 subprocess 调用自身，把 target_id 传进去）
    publish_script = os.path.join(os.path.dirname(__file__), "publish-answer.py")
    cmd = [
        sys.executable, publish_script,
        "--question-id", str(question_id),
        "--content", content,
        "--scope", scope,
        "--target-id", target_id,
        "--no-close",
    ]
    
    print(f"  [answer] 调用: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    
    # 打印输出
    if result.stdout:
        print(result.stdout[-2000:] if len(result.stdout) > 2000 else result.stdout)
    if result.stderr:
        print(f"[stderr] {result.stderr[-1000:]}")
    
    # 解析结果
    try:
        # 从 stdout 中找到 JSON 结果
        lines = result.stdout.split('\n')
        for i, line in enumerate(lines):
            if '"ok"' in line or '"answerId"' in line or '"alreadyAnswered"' in line:
                json_str = '\n'.join(lines[i:])
                return json.loads(json_str)
    except:
        pass
    
    return {"ok": False, "error": "parse_failed", "stdout": result.stdout[-500:]}


def main():
    parser = argparse.ArgumentParser(description="模拟真人刷知乎（持久会话模式）")
    parser.add_argument("--home", action="store_true", help="浏览首页推荐流（默认热榜）")
    parser.add_argument("--minutes", type=int, default=None, help="浏览时长（分钟）")
    parser.add_argument("--dry-run", action="store_true", help="只打印计划不执行")
    parser.add_argument("--keep-open", action="store_true",
                        help="浏览结束后不关闭页面，保留target_id以供复用")
    parser.add_argument("--target-id", default=None,
                        help="复用已有浏览器页面（不新建页面）")
    parser.add_argument("--answer", type=str, default=None,
                        help="浏览结束后在同一会话中回答问题（格式：question_id:回答内容或@文件名）")
    args = parser.parse_args()

    if not ensure_proxy():
        print("[error] cdp-proxy 不可用，退出")
        sys.exit(1)

    scope = _resolve_agent_scope()

    if args.dry_run:
        minutes = args.minutes if args.minutes else f"{MIN_BROWSE_SECONDS//60}~{MAX_BROWSE_SECONDS//60}"
        page = "首页推荐流" if args.home else "热榜"
        print(f"📋 浏览计划:")
        print(f"  页面：知乎{page}")
        print(f"  时长：{minutes} 分钟")
        print(f"  页面管理：{'保持打开' if args.keep_open else '关闭'}")
        print(f"  复用页面：{args.target_id or '新建'}")
        print(f"  行为：滚动浏览 → 随机点开问题 → 阅读回答 → 点赞(30%概率)")
        if args.answer:
            print(f"  浏览后回答：{args.answer[:60]}...")
        return

    # 同一个会话：一个页面干所有事
    target_id = args.target_id
    
    if target_id:
        print(f"[session] 复用已有页面: {target_id}")
    
    if args.home:
        result = browse_home_feed(scope, args.minutes, existing_target=target_id,
                                  keep_open=args.keep_open or bool(args.answer))
    else:
        result = browse_hotlist(scope, args.minutes, existing_target=target_id,
                                keep_open=args.keep_open or bool(args.answer))
    
    session_target = result.get("targetId")
    
    # 如果需要在同一会话中回答问题
    if args.answer and session_target:
        print("\n" + "="*50)
        print("📝 浏览结束，在同一会话中回答问题...")
        print("="*50)
        
        # 解析 --answer 参数
        answer_arg = args.answer
        if ":" in answer_arg:
            qid, content = answer_arg.split(":", 1)
            qid = qid.strip()
            content = content.strip()
        elif answer_arg.startswith("@"):
            # 从文件读取
            filepath = answer_arg[1:]
            with open(filepath, "r", encoding="utf-8") as f:
                lines = f.read().strip().split("\n", 1)
                qid = lines[0].strip()
                content = lines[1].strip() if len(lines) > 1 else ""
        else:
            print(f"[error] --answer 格式错误，应为 'question_id:内容' 或 '@文件名'")
            # 返回 target_id 以供手动使用
            print(f"[session] 页面保持打开，TARGET_ID={session_target}")
            print(f"[session] 可使用 python3 publish-answer.py --target-id {session_target} --question-id <ID> --file <FILE> --no-close")
            return
        
        write_answer_in_session(session_target, scope, qid.strip(), content.strip())
        
        # 写完回答，如果没要求 keep_open，关闭页面
        if not args.keep_open:
            curl_post(f"/close?target={session_target}&metaAgentScope={scope}")
            print("[session] 页面已关闭")
        else:
            print(f"\n[session] 🔵 页面保持打开，TARGET_ID={session_target}")
            print(f"[session] 可继续操作：")
            print(f"  python3 publish-answer.py --target-id {session_target} --question-id <ID> --file <FILE> --no-close")
            print(f"  python3 simulate-browsing.py --target-id {session_target}")
    elif not args.keep_open and session_target and not target_id:
        # 没有回答任务，且没有--keep-open，且是新建的页面 -> 在browse_*的finally中已关闭
        pass
    elif args.keep_open and session_target:
        print(f"\n[session] 🔵 页面保持打开，TARGET_ID={session_target}")
        print(f"[session] 可继续操作：")
        print(f"  python3 publish-answer.py --target-id {session_target} --question-id <ID> --file <FILE> --no-close")
        print(f"  python3 simulate-browsing.py --target-id {session_target}")


if __name__ == "__main__":
    main()
