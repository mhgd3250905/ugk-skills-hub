#!/usr/bin/env python3
"""
知乎发表回答脚本 v3（反AI检测增强版）

用法：
  # 浏览调研（不发布）—— 先看已有回答，确定风格调性
  python3 publish-answer.py --question-id <ID> --browse

  # 发表回答（推荐：内容写入文件）
  python3 publish-answer.py --question-id <ID> --file ./answer.md

  # 发表回答（直接内容）
  python3 publish-answer.py --question-id <ID> --content "回答内容"

  # 检查是否已回答
  python3 publish-answer.py --question-id <ID> --check

  # 列出所有已回答记录
  python3 publish-answer.py --list

  # 强制回答（跳过已答检查和每日上限）
  python3 publish-answer.py --question-id <ID> --file <文件> --force

v3 更新（2026-05-02）：
  - 每日回答上限（默认 10 条/天），超限自动拒绝
  - 发布前先浏览问题详情和已有回答，产出调研报告到 stderr
  - 逐段输入（模拟真人打字节奏），每段间随机延迟 2~5 秒
  - 所有固定等待改为随机延迟，打破行为指纹
  - --browse 模式：只调研不发布

v2 更新（2026-04-29）：
  - 增加页面滚动定位逻辑
  - 分步骤执行简单JS避免Uncaught错误
  - 增加多次重试机制（最多3次）
  - 添加状态检查和调试输出
  - 增加等待时间让页面稳定

v1 更新（2026-04-29）：
  - 改用 CDP /type 端点替代 execCommand，解决 Draft.js 状态同步问题
"""

import argparse
import subprocess
import json
import time
import sys
import os
import random
from datetime import datetime

# ============================================================
# 配置常量
# ============================================================

# 已回答记录文件路径
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ANSWERED_FILE = os.path.join(_SCRIPT_DIR, 'answered-questions.json')

# 每日回答上限（硬限制，超过此数自动拒绝）
MAX_DAILY_ANSWERS = int(os.environ.get("ZHIHU_DAILY_LIMIT", "10"))

# 最大发布重试次数（设为1防止反复点击触发知乎反作弊）
MAX_RETRY = 1

# 浏览时获取的已有回答数量（用于风格分析）
BROWSE_ANSWER_COUNT = 8

# 逐段输入时，段落间的随机延迟范围（秒）
PARAGRAPH_DELAY_MIN = 2.0
PARAGRAPH_DELAY_MAX = 5.0

# Scope 环境变量名称（与 browser-cleanup.ts 保持一致）
SCOPE_ENV_NAMES = ['CLAUDE_AGENT_ID', 'CLAUDE_HOOK_AGENT_ID', 'agent_id']

# ============================================================
# 人设池（发布时自动随机选择，避免全员"专家"）
# ============================================================
PERSONA_POOL = [
    "互联网行业观察者",
    "AI产品用户",
    "科技爱好者",
    "行业从业者",
    "产品设计师",
    "职场过来人",
    "生活探索者",
    "数码爱好者",
    "故事分享者",
    "知识科普爱好者",
]

# ============================================================
# 工具函数
# ============================================================

def resolve_agent_scope(default_scope: str = 'zhihu-publish') -> str:
    """从环境变量读取 scope，优先级高于默认值

    这样 conn worker 任务结束时，browser-cleanup.ts 能正确清理脚本创建的页面。
    """
    for name in SCOPE_ENV_NAMES:
        val = os.environ.get(name, '').strip()
        if val:
            return val
    return default_scope


def random_delay(lo: float = 0.5, hi: float = 2.0):
    """随机等待，模拟真人操作间隔"""
    delay = random.uniform(lo, hi)
    time.sleep(delay)


def load_answered_records():
    """加载已回答记录"""
    if os.path.exists(ANSWERED_FILE):
        with open(ANSWERED_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"description": "已回答的知乎问题记录，避免重复回答", "records": []}


def save_answered_records(records):
    """保存已回答记录"""
    with open(ANSWERED_FILE, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)


def check_already_answered(question_id: str):
    """检查是否已回答过某问题"""
    records = load_answered_records()
    for r in records.get("records", []):
        if r.get("questionId") == question_id:
            return r
    return None


def count_today_answers(records) -> int:
    """统计今天已经回答了多少条"""
    today_prefix = datetime.now().strftime("%Y-%m-%d")
    return sum(
        1 for r in records.get("records", [])
        if r.get("answeredAt", "").startswith(today_prefix)
    )


def pick_persona(explicit_persona: str = None) -> str:
    """选择人设：如果显式指定了就用指定值，否则从池中随机选"""
    if explicit_persona and explicit_persona != "专家":
        return explicit_persona
    return random.choice(PERSONA_POOL)


def record_answer(question_id: str, question_title: str, answer_id: str,
                  answer_url: str, persona: str):
    """记录新回答"""
    records = load_answered_records()

    # 检查是否已存在（避免重复记录）
    for r in records.get("records", []):
        if r.get("questionId") == question_id:
            return

    records["records"].append({
        "questionId": question_id,
        "questionTitle": question_title,
        "answerId": answer_id,
        "answerUrl": answer_url,
        "answeredAt": datetime.now().isoformat(),
        "persona": persona,
    })
    save_answered_records(records)


# ============================================================
# HTTP / CDP 调用
# ============================================================

def curl_get(url):
    """GET 请求"""
    cmd = ["curl", "-s", url]
    result = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"raw": result.stdout, "error": "Invalid JSON"}


def curl_post(url, data=None, content_type="application/json"):
    """POST 请求"""
    cmd = ["curl", "-s", "-X", "POST",
           "-H", f"Content-Type: {content_type}"]
    if data:
        cmd.extend(["--data-binary", data])
    cmd.append(url)
    result = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"raw": result.stdout.strip('"').strip("'") if result.stdout else ""}


def curl_type(target_id: str, agent_scope: str, text: str) -> dict:
    """使用 CDP /type 端点输入文本（解决 Draft.js 状态同步问题）

    背景：execCommand('insertText') 无法正确触发 Draft.js/React 编辑器的状态同步，
    导致字数统计为 0、发布按钮 disabled。CDP Input.insertText 通过浏览器输入管道
    模拟真实键盘输入，能正确触发框架状态更新。
    """
    url = f"http://127.0.0.1:3456/type?target={target_id}&metaAgentScope={agent_scope}"
    cmd = ["curl", "-s", "-X", "POST",
           "-H", "Content-Type: text/plain",
           "--data-binary", text,
           url]
    result = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "error": f"Invalid JSON: {result.stdout[:200]}"}


def eval_simple(target_id: str, agent_scope: str, script: str):
    """执行 JS 并返回结果（避免复杂表达式导致 Uncaught）"""
    eval_url = f"http://127.0.0.1:3456/eval?target={target_id}&metaAgentScope={agent_scope}"
    resp = curl_post(eval_url, script)

    if isinstance(resp, dict):
        if resp.get("error") == "Uncaught":
            return {"ok": False, "error": "Uncaught", "raw": resp.get("raw", "")}
        return resp
    if isinstance(resp, str):
        return {"ok": True, "result": resp.strip('"').strip("'")}
    return resp


# ============================================================
# 浏览与调研
# ============================================================

def read_question_details(target_id: str, agent_scope: str) -> dict:
    """从已打开的问题页面提取标题、描述和标签"""
    # 获取标题
    script_title = '''(() => {
        const el = document.querySelector("h1.QuestionHeader-title");
        return el ? el.textContent.trim() : "";
    })()'''
    resp_title = eval_simple(target_id, agent_scope, script_title)
    title = resp_title.get("result", resp_title.get("raw", ""))

    # 获取描述
    script_desc = '''(() => {
        const el = document.querySelector(".QuestionHeader-detail .RichText");
        return el ? el.textContent.trim().substring(0, 600) : "";
    })()'''
    resp_desc = eval_simple(target_id, agent_scope, script_desc)
    desc = resp_desc.get("result", resp_desc.get("raw", ""))

    # 获取标签
    script_tags = '''(() => {
        return JSON.stringify(
            Array.from(document.querySelectorAll(".QuestionHeader-tags a, .QuestionHeader .TopicLink"))
                .map(a => a.textContent.trim())
        );
    })()'''
    resp_tags = eval_simple(target_id, agent_scope, script_tags)
    tags_raw = resp_tags.get("result", resp_tags.get("raw", "[]"))
    try:
        tags = json.loads(tags_raw) if isinstance(tags_raw, str) else tags_raw
    except (json.JSONDecodeError, TypeError):
        tags = []

    return {
        "title": title,
        "description": desc,
        "tags": tags,
    }


def read_existing_answers(target_id: str, agent_scope: str,
                          question_id: str, limit: int = 8) -> list:
    """通过浏览器内 API 获取已有回答，分析风格分布"""
    script = f'''(async () => {{
        try {{
            const resp = await fetch(
                "https://www.zhihu.com/api/v4/questions/{question_id}/answers?limit={limit}&offset=0&sort_by=votes&include=data[*].voteup_count,comment_count,content,author.name,created_time",
                {{ credentials: "include" }}
            );
            const data = await resp.json();
            const items = (data.data || []).map(a => ({{
                author: a.author?.name || "匿名",
                votes: a.voteup_count,
                comments: a.comment_count,
                length: (a.content || "").replace(/<[^>]+>/g, "").length,
                excerpt: (a.content || "").replace(/<[^>]+>/g, "").substring(0, 120),
                created: a.created_time || 0,
            }}));
            return JSON.stringify({{ total: data.paging?.totals || 0, items }});
        }} catch(e) {{
            return JSON.stringify({{ total: 0, items: [] }});
        }}
    }})()'''
    resp = eval_simple(target_id, agent_scope, script)
    raw = resp.get("result", resp.get("raw", "{}"))
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
        return parsed.get("items", [])
    except (json.JSONDecodeError, TypeError):
        return []


def analyze_answer_styles(answers: list) -> dict:
    """分析已有回答的风格分布

    根据长度、赞数等粗略判断风格偏向。
    """
    short = 0   # <= 100 字
    medium = 0  # 100~300 字
    long_ = 0   # > 300 字

    for a in answers:
        l = a.get("length", 0)
        if l <= 100:
            short += 1
        elif l <= 300:
            medium += 1
        else:
            long_ += 1

    return {
        "short_answers": short,
        "medium_answers": medium,
        "long_answers": long_,
        "total": len(answers),
    }


def suggest_style(style_analysis: dict) -> str:
    """根据已有回答的风格分布，推荐差异化方向"""
    s = style_analysis
    total = s["total"]
    if total == 0:
        return "无已有回答，自由发挥"

    short_ratio = s["short_answers"] / total if total else 0
    long_ratio = s["long_answers"] / total if total else 0

    if short_ratio > 0.6:
        return "已有回答以短评为主，建议写一条中等长度（100~300字）的有观点回答"
    elif long_ratio > 0.6:
        return "已有回答以长文为主，建议用简短（<100字）或插科打诨/抖机灵做差异化"
    elif s["medium_answers"] >= s["short_answers"] + s["long_answers"]:
        return "已有回答以中等长度为主，建议选抖机灵或讲故事风格做差异化"
    else:
        return "风格分布较均匀，建议选冷门风格（讲故事/反问式/情绪流）"


def browse_and_report(target_id: str, agent_scope: str,
                      question_id: str, question_title: str) -> dict:
    """浏览问题页面并输出调研报告到 stderr"""
    import sys

    print("\n═══════════════════════════════════════", file=sys.stderr)
    print("  问题调研报告", file=sys.stderr)
    print("═══════════════════════════════════════", file=sys.stderr)

    # 1. 阅读问题详情
    print("[浏览] 阅读问题详情...", file=sys.stderr)
    details = read_question_details(target_id, agent_scope)
    title = details.get("title") or question_title
    desc = details.get("description", "")
    tags = details.get("tags", [])

    print(f"  标题: {title}", file=sys.stderr)
    if desc:
        print(f"  描述: {desc[:200]}{'...' if len(desc) > 200 else ''}", file=sys.stderr)
    if tags:
        print(f"  标签: {', '.join(tags)}", file=sys.stderr)

    # 模拟阅读时间（真人在看帖子）
    read_time = random.uniform(2.0, 5.0)
    time.sleep(read_time)

    # 2. 获取已有回答
    print(f"[浏览] 获取已有回答（前 {BROWSE_ANSWER_COUNT} 条）...", file=sys.stderr)
    answers = read_existing_answers(target_id, agent_scope, question_id, BROWSE_ANSWER_COUNT)

    if answers:
        style_analysis = analyze_answer_styles(answers)
        print(f"\n  已有回答数量: {style_analysis['total']} 条（问题总回答数可能更多）", file=sys.stderr)
        print(f"  长度分布:", file=sys.stderr)
        print(f"    - 短回答（≤100字）: {style_analysis['short_answers']} 条", file=sys.stderr)
        print(f"    - 中等（100~300字）: {style_analysis['medium_answers']} 条", file=sys.stderr)
        print(f"    - 长文（>300字）: {style_analysis['long_answers']} 条", file=sys.stderr)
        print(f"\n  💡 风格建议: {suggest_style(style_analysis)}", file=sys.stderr)

        # 列出前几条的热门回答摘要（帮助了解调性）
        print(f"\n  热门回答摘要:", file=sys.stderr)
        for i, a in enumerate(answers[:3], 1):
            excerpt = a.get("excerpt", "")[:80]
            print(f"    {i}. [{a.get('votes', 0)}赞] {a.get('author', '匿名')}: {excerpt}", file=sys.stderr)
            time.sleep(random.uniform(0.3, 0.8))  # 模拟阅读每条回答的时间
    else:
        print("  暂无已有的回答数据（可能刚发布的问题）", file=sys.stderr)

    # 模拟总共的浏览时间（随机 3~10 秒，让行为更像真人）
    total_browse_time = random.uniform(3.0, 8.0)
    time.sleep(total_browse_time)

    print("───────────────────────────────────────", file=sys.stderr)
    print(f"  浏览完成，准备发布回答", file=sys.stderr)
    print("═══════════════════════════════════════\n", file=sys.stderr)

    return {
        "title": title,
        "description": desc,
        "tags": tags,
        "existing_answers": answers,
        "style_analysis": analyze_answer_styles(answers) if answers else {},
    }


# ============================================================
# 模拟打字：逐段输入
# ============================================================

def type_content_like_human(target_id: str, agent_scope: str, content: str) -> bool:
    """模拟人类打字节奏：逐段输入，每段间随机延迟

    知乎 Draft.js 编辑器将回车解释为新段落，所以每段间插入 \n\n。
    短内容（< 80 字）直接一次输入，不分段。
    """
    if len(content) < 80:
        resp = curl_type(target_id, agent_scope, content)
        return resp.get("ok", False)

    # 按空行分割段落，保留非空段
    paragraphs = [p.strip() for p in content.split("\n") if p.strip()]
    if not paragraphs:
        paragraphs = [content]

    print(f"    [逐段输入] 共 {len(paragraphs)} 段，逐段模拟打字...")
    for i, para in enumerate(paragraphs):
        # 段间随机等待（模拟思考/打字间隙）
        if i > 0:
            delay = random.uniform(PARAGRAPH_DELAY_MIN, PARAGRAPH_DELAY_MAX)
            time.sleep(delay)

        # 输入本段内容
        resp = curl_type(target_id, agent_scope, para)
        if not resp.get("ok"):
            print(f"    ⚠️ 第 {i+1} 段输入异常: {resp.get('error', '')}")
            return False

        # 段落间加换行（模拟真人回车换段）
        if i < len(paragraphs) - 1:
            curl_type(target_id, agent_scope, "\n\n")

        # 短段落输入后稍微停顿（模拟打字速度）
        if len(para) < 30:
            random_delay(0.3, 1.0)
        elif len(para) < 80:
            random_delay(0.5, 1.5)

    print(f"    [逐段输入完成]")
    return True


# ============================================================
# 发布流程（页面操作）
# ============================================================

def scroll_to_write_answer_area(target_id: str, agent_scope: str):
    """滚动页面到写回答区域"""
    eval_simple(target_id, agent_scope, "window.scrollTo(0, 0)")
    random_delay(0.5, 2.0)

    eval_simple(target_id, agent_scope,
        "document.querySelector('.QuestionHeader')?.scrollIntoView({block: 'end'})")
    random_delay(0.5, 2.0)

    script = '''(() => {
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
            if (btn.textContent.includes("写回答")) {
                btn.scrollIntoView({block: "center"});
                return "found";
            }
        }
        return "not_found";
    })()'''
    resp = eval_simple(target_id, agent_scope, script)
    return resp.get("result") == "found" or resp.get("ok")


def find_and_click_write_answer(target_id: str, agent_scope: str) -> bool:
    """查找并点击"写回答"按钮（多重选择器 + 等待）"""
    # 方法1: 按钮文本匹配
    script1 = '''(() => {
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
            const text = btn.textContent || "";
            if (text.includes("写回答") || text.includes("编辑回答")) {
                btn.click();
                return "clicked";
            }
        }
        return "not_found";
    })()'''
    resp1 = eval_simple(target_id, agent_scope, script1)
    if resp1.get("result") == "clicked":
        return True

    # 方法2: WriteAnswer class
    script2 = '''(() => {
        const areas = document.querySelectorAll('[class*="WriteAnswer"]');
        for (const area of areas) {
            const btn = area.querySelector("button") || area;
            if (btn && (btn.textContent || "").includes("写")) {
                btn.click();
                return "clicked";
            }
        }
        return "not_found";
    })()'''
    resp2 = eval_simple(target_id, agent_scope, script2)
    if resp2.get("result") == "clicked":
        return True

    # 方法3: 可编辑区域直接点击
    script3 = '''(() => {
        const input = document.querySelector(".WriteAnswer-input");
        if (input) {
            input.click();
            return "clicked_input";
        }
        return "not_found";
    })()'''
    resp3 = eval_simple(target_id, agent_scope, script3)
    if resp3.get("result") in ["clicked", "clicked_input"]:
        return True

    return False


def wait_for_editor(target_id: str, agent_scope: str, max_wait: int = 10) -> bool:
    """等待编辑器出现"""
    for _ in range(max_wait):
        script = '''(() => {
            const editors = document.querySelectorAll('[contenteditable="true"]');
            return editors.length > 0 ? "found" : "waiting";
        })()'''
        resp = eval_simple(target_id, agent_scope, script)
        if resp.get("result") == "found":
            return True
        time.sleep(1)
    return False


def focus_editor(target_id: str, agent_scope: str) -> bool:
    """聚焦编辑器"""
    script = '''(() => {
        const editor = document.querySelector('[contenteditable="true"]');
        if (editor) {
            editor.focus();
            return "focused";
        }
        return "not_found";
    })()'''
    resp = eval_simple(target_id, agent_scope, script)
    return resp.get("result") == "focused"


def clear_editor(target_id: str, agent_scope: str) -> bool:
    """清空编辑器"""
    script = '''(() => {
        try {
            const editor = document.querySelector('[contenteditable="true"]');
            if (editor) {
                document.execCommand("selectAll", false, null);
                document.execCommand("delete", false, null);
                return "cleared";
            }
        } catch(e) {}
        return "skip";
    })()'''
    resp = eval_simple(target_id, agent_scope, script)
    return True


def check_publish_button_enabled(target_id: str, agent_scope: str) -> dict:
    """检查发布按钮状态"""
    script = '''(() => {
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
            const text = btn.textContent || "";
            if (text.includes("发布回答") && !text.includes("设置")) {
                return JSON.stringify({
                    found: true,
                    disabled: btn.disabled,
                    text: text.trim().substring(0, 20),
                });
            }
        }
        return JSON.stringify({found: false});
    })()'''
    resp = eval_simple(target_id, agent_scope, script)
    try:
        result_str = resp.get("result", resp.get("raw", "{}"))
        return json.loads(result_str) if isinstance(result_str, str) else result_str
    except (json.JSONDecodeError, TypeError):
        return {"found": False}


def click_publish_button(target_id: str, agent_scope: str) -> bool:
    """点击发布回答按钮"""
    script = '''(() => {
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
            const text = btn.textContent || "";
            if (text.includes("发布回答") && !text.includes("设置")) {
                btn.click();
                return "clicked";
            }
        }
        return "not_found";
    })()'''
    resp = eval_simple(target_id, agent_scope, script)
    return resp.get("result") == "clicked"


def click_smart_publish(target_id: str, agent_scope: str) -> bool:
    """点击智能发布按钮"""
    script = '''(() => {
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
            if ((btn.textContent || "").includes("智能发布")) {
                btn.click();
                return "clicked";
            }
        }
        return "not_found";
    })()'''
    resp = eval_simple(target_id, agent_scope, script)
    return resp.get("result") == "clicked"


def get_current_url(target_id: str, agent_scope: str) -> str:
    """获取当前 URL"""
    resp = eval_simple(target_id, agent_scope, "window.location.href")
    return resp.get("result", resp.get("raw", ""))


def get_answer_id_from_url(url: str) -> str:
    """从 URL 提取 answerId"""
    import re
    match = re.search(r'answer/(\d+)', url)
    return match.group(1) if match else ""


def get_question_title(target_id: str, agent_scope: str) -> str:
    """获取问题标题"""
    script = '''(() => {
        const title = document.querySelector("h1.QuestionHeader-title");
        return title ? title.textContent.trim() : "";
    })()'''
    resp = eval_simple(target_id, agent_scope, script)
    return resp.get("result", resp.get("raw", ""))[:100]


# ============================================================
# 单次发布尝试
# ============================================================

def publish_answer_single_attempt(question_id: str, content: str,
                                  agent_scope: str, target_id: str,
                                  attempt: int) -> dict:
    """单次发布尝试（带逐段输入）"""
    print(f"\n=== 尝试 #{attempt} ===")

    try:
        # 1. 滚动到写回答区域
        print("[1] 滚动到写回答区域")
        scroll_to_write_answer_area(target_id, agent_scope)
        random_delay(1.5, 4.0)

        # 2. 点击写回答按钮
        print("[2] 点击写回答按钮")
        if not find_and_click_write_answer(target_id, agent_scope):
            print("    ⚠️ 写回答按钮未找到，尝试继续...")
        random_delay(2.0, 5.0)

        # 3. 等待编辑器出现
        print("[3] 等待编辑器")
        if not wait_for_editor(target_id, agent_scope, max_wait=8):
            print("    ❌ 编辑器未出现")
            return {"ok": False, "error": "editor_not_found", "attempt": attempt}
        print("    ✅ 编辑器已出现")
        random_delay(0.5, 2.0)

        # 4. 聚焦编辑器
        print("[4] 聚焦编辑器")
        focus_editor(target_id, agent_scope)
        random_delay(0.5, 1.5)

        # 5. 清空编辑器
        print("[5] 清空编辑器")
        clear_editor(target_id, agent_scope)
        random_delay(0.5, 1.5)

        # 6. 逐段输入回答内容（模拟真人打字）
        print("[6] 输入回答内容（逐段模拟打字）")
        if not type_content_like_human(target_id, agent_scope, content):
            print("    ❌ 逐段输入失败")
            return {"ok": False, "error": "type_failed", "attempt": attempt}
        random_delay(1.0, 3.0)

        # 7. 检查发布按钮状态
        print("[7] 检查发布按钮状态")
        btn_state = check_publish_button_enabled(target_id, agent_scope)
        print(f"    发布按钮: {btn_state}")
        if not btn_state.get("found"):
            print("    ⚠️ 发布按钮未找到")
        elif btn_state.get("disabled"):
            print("    ⚠️ 发布按钮可能 disabled（Draft.js 状态问题）")
        random_delay(0.5, 2.0)

        # 8. 点击发布回答（只点一次，不点智能发布，防止触犯知乎频率限制）
        print("[8] 点击发布回答")
        publish_clicked = click_publish_button(target_id, agent_scope)
        if not publish_clicked:
            print("    ⚠️ 发布按钮点击失败，跳过智能发布（避免重复点击触发反作弊）")
        else:
            print("    ✅ 发布按钮已点击")
        random_delay(5.0, 10.0)

        # 9. 检查结果（等待页面跳转后检查 URL）
        print("[9] 检查发布结果")
        url = get_current_url(target_id, agent_scope)
        answer_id = get_answer_id_from_url(url)

        if answer_id:
            print(f"    ✅ 发布成功! Answer ID: {answer_id}")
            return {"ok": True, "answerId": answer_id, "answerUrl": url}
        else:
            print(f"    ⚠️ 未检测到 answerId，URL: {url}")
            return {"ok": False, "error": "no_answer_id", "url": url, "attempt": attempt}

    except Exception as e:
        return {"ok": False, "error": str(e), "attempt": attempt}


# ============================================================
# 主流程
# ============================================================

def browse_only(question_id: str, agent_scope: str = None, existing_target: str = None) -> dict:
    """仅浏览调研，不发布

    Args:
        question_id: 知乎问题 ID
        agent_scope: Agent scope
        existing_target: 复用已有浏览器页面 target_id（为 None 则新建页面）
    """
    if agent_scope is None:
        agent_scope = resolve_agent_scope()

    should_close = False
    target_id = existing_target
    try:
        if not target_id:
            new_url = f"http://127.0.0.1:3456/new?url=https://www.zhihu.com/question/{question_id}&metaAgentScope={agent_scope}"
            resp = curl_get(new_url)
            target_id = resp.get("targetId", "")
            if not target_id:
                return {"ok": False, "error": "无法创建浏览器页面"}
            should_close = True
        else:
            # 复用已有页面，直接导航
            curl_get(f"http://127.0.0.1:3456/navigate?target={target_id}&metaAgentScope={agent_scope}&url=https://www.zhihu.com/question/{question_id}")

        print(f"    浏览 TARGET_ID: {target_id}")
        random_delay(3.0, 6.0)

        question_title = get_question_title(target_id, agent_scope)
        report = browse_and_report(target_id, agent_scope, question_id, question_title)

        return {
            "ok": True,
            "targetId": target_id,
            "report": report,
        }
    finally:
        if target_id and should_close:
            curl_get(f"http://127.0.0.1:3456/close?target={target_id}&metaAgentScope={agent_scope}")
            print("\n[关闭页面]")
        elif target_id and not should_close and existing_target is None:
            # 新建页面但不需要关闭（no_close模式）
            pass


def publish_answer(question_id: str, content: str, agent_scope: str = None,
                   persona: str = "专家", force: bool = False,
                   skip_daily_limit: bool = False,
                   existing_target: str = None,
                   no_close: bool = False) -> dict:
    """发表知乎回答（v3 防检测版）

    流程：
    1. 检查每日上限（除非 skip_daily_limit 或 force）
    2. 检查是否已回答（除非 force）
    3. 打开问题页面（或复用 existing_target）
    4. 浏览调研（阅读已有回答，输出报告到 stderr）
    5. 多次尝试发布（最多 MAX_RETRY 次，逐段输入）
    6. 记录成功结果

    Args:
        question_id: 知乎问题 ID
        content: 回答内容
        agent_scope: Agent scope
        persona: 回答人设
        force: 强制发布
        skip_daily_limit: 跳过每日上限
        existing_target: 复用已有浏览器页面 target_id（为 None 则新建页面）
        no_close: 发布后不关闭页面（用于同一会话中继续操作）

    Scope 优先级：
    1. 显式传入的 agent_scope 参数
    2. 环境变量 CLAUDE_AGENT_ID / CLAUDE_HOOK_AGENT_ID / agent_id
    3. 默认值 'zhihu-publish'
    """
    if agent_scope is None:
        agent_scope = resolve_agent_scope()

    # 随机选择人设（避免全员"专家"）
    effective_persona = pick_persona(persona)
    print(f"[人设] 本次回答人设: {effective_persona}")

    # ---- 每日上限检查 ----
    if not force and not skip_daily_limit:
        records = load_answered_records()
        today_count = count_today_answers(records)
        if today_count >= MAX_DAILY_ANSWERS:
            msg = (f"❌ 今日已回答 {today_count} 条，已达上限 {MAX_DAILY_ANSWERS} 条/天。"
                   f"如需强制发布请加 --force 或设置环境变量 ZHIHU_DAILY_LIMIT")
            print(msg)
            return {
                "ok": False,
                "error": "daily_limit_reached",
                "todayCount": today_count,
                "maxDaily": MAX_DAILY_ANSWERS,
                "message": msg,
            }
        print(f"[每日上限] 今日已答 {today_count}/{MAX_DAILY_ANSWERS}")

    # ---- 已回答检查 ----
    if not force:
        existing = check_already_answered(question_id)
        if existing:
            return {
                "ok": False,
                "alreadyAnswered": True,
                "message": "该问题已回答过，避免重复",
                "previousAnswer": existing,
            }

    start_time = time.time()
    should_close = False
    target_id = existing_target

    try:
        # 打开问题页面（或复用已有页面）
        if not target_id:
            print(f"\n[打开页面] 问题 ID: {question_id}")
            new_url = f"http://127.0.0.1:3456/new?url=https://www.zhihu.com/question/{question_id}&metaAgentScope={agent_scope}"
            resp = curl_get(new_url)
            target_id = resp.get("targetId", "")
            if not target_id:
                return {"ok": False, "error": "无法创建浏览器页面"}
            should_close = True
        else:
            print(f"\n[复用页面] 导航到问题 {question_id}")
            curl_get(f"http://127.0.0.1:3456/navigate?target={target_id}&metaAgentScope={agent_scope}&url=https://www.zhihu.com/question/{question_id}")

        print(f"    TARGET_ID: {target_id}")
        random_delay(3.0, 6.0)

        # 获取问题标题
        question_title = get_question_title(target_id, agent_scope)
        print(f"    问题标题: {question_title}")

        # ---- 浏览调研（阅读已有回答，输出到 stderr） ----
        print("\n--- 开始浏览问题（阅读已有回答，分析风格） ---")
        browse_and_report(target_id, agent_scope, question_id, question_title)

        # ---- 多次尝试发布 ----
        last_error = None
        for attempt in range(1, MAX_RETRY + 1):
            result = publish_answer_single_attempt(
                question_id, content, agent_scope, target_id, attempt
            )

            if result.get("ok"):
                answer_id = result.get("answerId")
                answer_url = result.get("answerUrl")

                record_answer(question_id, question_title,
                              answer_id, answer_url, effective_persona)

                elapsed = round(time.time() - start_time, 2)
                return {
                    "ok": True,
                    "answerId": answer_id,
                    "answerUrl": answer_url,
                    "questionTitle": question_title,
                    "targetId": target_id,
                    "persona": effective_persona,
                    "attempts": attempt,
                    "elapsed": f"{elapsed}s",
                }

            last_error = result
            print(f"\n尝试 #{attempt} 失败: {result.get('error')}")

            if result.get("error") == "editor_not_found":
                print("    刷新页面...")
                curl_get(f"http://127.0.0.1:3456/close?target={target_id}&metaAgentScope={agent_scope}")
                random_delay(2.0, 4.0)
                resp = curl_get(new_url)
                target_id = resp.get("targetId", "")
                random_delay(3.0, 6.0)

        elapsed = round(time.time() - start_time, 2)
        return {
            "ok": False,
            "error": f"发布失败（尝试 {MAX_RETRY} 次）",
            "lastError": last_error,
            "questionTitle": question_title,
            "targetId": target_id,
            "elapsed": f"{elapsed}s",
        }

    finally:
        if target_id and should_close and not no_close:
            curl_get(f"http://127.0.0.1:3456/close?target={target_id}&metaAgentScope={agent_scope}")
            print("\n[关闭页面]")
        elif target_id and not should_close and no_close:
            print("\n[保持页面打开] 同一会话继续使用")
        elif target_id and not no_close:
            curl_get(f"http://127.0.0.1:3456/close?target={target_id}&metaAgentScope={agent_scope}")
            print("\n[关闭页面]")
        else:
            print("\n[保持页面打开] 由调用方管理")


# ============================================================
# CLI 入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="知乎发表回答 v3（反AI检测增强版）")
    parser.add_argument("--question-id", help="知乎问题 ID")
    parser.add_argument("--content", help="回答内容")
    parser.add_argument("--file", help="回答内容文件路径")
    parser.add_argument("--scope", default=None,
                        help="Agent scope（默认从环境变量 CLAUDE_AGENT_ID 继承）")
    parser.add_argument("--persona", default=None,
                        help="回答人设（留空则从人设池随机选择）")
    parser.add_argument("--check", action="store_true",
                        help="仅检查是否已回答")
    parser.add_argument("--list", action="store_true",
                        help="列出所有已回答问题")
    parser.add_argument("--force", action="store_true",
                        help="强制回答（忽略已答检查和每日上限）")
    parser.add_argument("--skip-daily-limit", action="store_true",
                        help="跳过每日上限检查（不跳过已答检查）")
    parser.add_argument("--browse", action="store_true",
                        help="仅浏览调研（不发布），输出问题详情和已有回答分析")
    parser.add_argument("--target-id", default=None,
                        help="复用已有浏览器页面 target_id（不新建页面）")
    parser.add_argument("--no-close", action="store_true",
                        help="发布后不关闭浏览器页面（同一会话继续使用）")
    parser.add_argument("--daily-limit", type=int, default=None,
                        help="设置每日上限（覆盖默认 10 条和环境变量）")

    args = parser.parse_args()

    # 动态修改每日上限
    global MAX_DAILY_ANSWERS
    if args.daily_limit is not None:
        MAX_DAILY_ANSWERS = args.daily_limit

    # ---------- --list ----------
    if args.list:
        records = load_answered_records()
        print(json.dumps(records, ensure_ascii=False, indent=2))
        return

    if not args.question_id:
        parser.print_help()
        print("\n错误: 需要提供 --question-id")
        sys.exit(1)

    # ---------- --check ----------
    if args.check:
        existing = check_already_answered(args.question_id)
        if existing:
            print(json.dumps({
                "alreadyAnswered": True,
                "record": existing,
            }, ensure_ascii=False, indent=2))
        else:
            print(json.dumps({
                "alreadyAnswered": False,
                "message": "该问题尚未回答",
            }, ensure_ascii=False, indent=2))
        return

    # ---------- --browse ----------
    if args.browse:
        result = browse_only(args.question_id, args.scope, existing_target=args.target_id)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if not result.get("ok"):
            sys.exit(1)
        return

    # ---------- 发表模式 ----------
    if args.file:
        with open(args.file, "r", encoding="utf-8") as f:
            content = f.read()
    elif args.content:
        content = args.content
    else:
        print("错误: 需要提供 --content、--file 或 --browse")
        sys.exit(1)

    scope = args.scope if args.scope else resolve_agent_scope()
    result = publish_answer(
        args.question_id,
        content,
        scope,
        persona=args.persona,
        force=args.force,
        skip_daily_limit=args.skip_daily_limit,
        existing_target=args.target_id,
        no_close=args.no_close,
    )

    print("\n=== 最终结果 ===")
    print(json.dumps(result, ensure_ascii=False, indent=2))

    if not result.get("ok") and not result.get("alreadyAnswered"):
        sys.exit(1)


if __name__ == "__main__":
    main()
