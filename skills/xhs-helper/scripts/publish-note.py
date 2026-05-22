#!/usr/bin/env python3
"""
小红书笔记发布脚本（2026-04-29 实测优化版）

用法:
  python3 publish-note.py --title "标题" --content "正文内容" --style 光影
  python3 publish-note.py --title "标题" --content-file /tmp/note.txt --style 简约
  python3 publish-note.py --list  # 列出已发布笔记
  python3 publish-note.py --check --title "标题关键词"  # 检查是否已发布

依赖: web-access 浏览器 sidecar

关键优化（2026-04-29 实测）:
  - 按钮选择器：精确匹配 button.d-button，避免点击父元素
  - 等待时间：页面8秒、编辑器轮询、图片生成30秒
  - 发布验证：URL 跳转到 /publish/success
"""

import argparse
import json
import subprocess
import time
import os
from pathlib import Path

# Scope env names matching browser-cleanup.ts and agent-run-scope.ts
_SCOPE_ENV_NAMES = ['CLAUDE_AGENT_ID', 'CLAUDE_HOOK_AGENT_ID', 'agent_id']

def _resolve_agent_scope(default_prefix='xhs-publish'):
    """Read env scope first so conn cleanup can close pages."""
    for name in _SCOPE_ENV_NAMES:
        val = os.environ.get(name, '').strip()
        if val:
            return val
    return f"{default_prefix}-{int(time.time())}"

# 配置
PROXY_URL = "http://127.0.0.1:3456"
PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish?source=official&from=menu&target=image"
SKILL_DIR = Path(__file__).parent.parent
PUBLISHED_FILE = SKILL_DIR / "published-notes.json"

# 可选风格
STYLES = ["光影", "简约", "备忘", "边框", "便签"]


def load_published_notes():
    """加载已发布记录"""
    if PUBLISHED_FILE.exists():
        return json.loads(PUBLISHED_FILE.read_text())
    return {"notes": [], "meta": {"created": time.strftime("%Y-%m-%d"), "totalNotes": 0}}


def save_published_notes(data):
    """保存已发布记录"""
    data["meta"]["lastUpdated"] = time.strftime("%Y-%m-%dT%H:%M:%S+08:00")
    data["meta"]["totalNotes"] = len(data["notes"])
    PUBLISHED_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False))


MAX_CHARS_PER_PAGE = 108  # 实测：每张卡片最多12行×9字，超出行会被截断或缩小
MAX_LINES_PER_PAGE = 12   # 包括空行（段落间隔）


def split_content_to_pages(content, max_chars=MAX_CHARS_PER_PAGE, max_lines=MAX_LINES_PER_PAGE):
    """智能分页：同时考虑字数上限和行数上限
    
    每张卡片限制：最多 12 行 × 9 字 = 108 字
    每个段落是一行，空行也占一行。任一上限触发就分页。
    
    策略（优先级从高到低）：
    1. 显式分隔符 --- 或连续空行 → 用户手动分页
    2. 按段落累积，超过 max_chars 或 max_lines 时分页
    3. 单个超长段落 → 按句号/问号/感叹号断句
    """
    import re
    
    # 1) 显式分隔符优先
    parts = re.split(r'\n---\n|\n\n\n', content)
    parts = [p.strip() for p in parts if p.strip()]
    if len(parts) > 1:
        return parts
    
    # 2) 单页不超长直接返回
    text = parts[0] if parts else content.strip()
    paragraphs = text.split('\n')
    # 计算行数：每个非空段1行，空行也占1行
    def count_lines(paras):
        return sum(1 for p in paras if p.strip()) + sum(1 for p in paras if not p.strip())
    total_lines = count_lines(paragraphs)
    if len(text) <= max_chars and total_lines <= max_lines:
        return [text]
    
    # 3) 按段落累计，字数或行数任一超限即分页
    pages = []
    current_paras = []
    current_chars = 0
    current_lines = 0
    
    for para in paragraphs:
        para_stripped = para.strip()
        para_lines = 1 if para_stripped else 1  # 空行占1行
        para_chars = len(para_stripped)
        
        # 单个段落本身超长 → 断句
        if para_chars > max_chars:
            if current_paras:
                pages.append('\n'.join(current_paras))
                current_paras, current_chars, current_lines = [], 0, 0
            sentences = re.split(r'(?<=[。！？.!?])\s*', para_stripped)
            for sent in sentences:
                sent = sent.strip()
                if not sent:
                    continue
                sent_len = len(sent)
                if current_chars + sent_len > max_chars or current_lines + 1 > max_lines:
                    if current_paras:
                        pages.append('\n'.join(current_paras))
                        current_paras, current_chars, current_lines = [], 0, 0
                    # 单句仍然超标，强行截断
                    if sent_len > max_chars:
                        for i in range(0, sent_len, max_chars):
                            chunk = sent[i:i+max_chars].strip()
                            if chunk:
                                pages.append(chunk)
                        continue
                current_paras.append(sent)
                current_chars += sent_len
                current_lines += 1
            continue
        
        # 正常段落：检查加入后是否超限
        new_chars = current_chars + para_chars + (1 if current_paras else 0)  # +1 for \n
        new_lines = current_lines + para_lines
        if new_chars > max_chars or new_lines > max_lines:
            if current_paras:
                pages.append('\n'.join(current_paras))
            current_paras = [para_stripped] if para_stripped else []
            current_chars = para_chars
            current_lines = para_lines
        else:
            if para_stripped:
                current_paras.append(para_stripped)
            current_chars = new_chars
            current_lines = new_lines
    
    if current_paras:
        pages.append('\n'.join(current_paras))
    
    return pages if pages else [text]



def eval_js(target_id: str, agent_scope: str, code: str):
    """执行 JavaScript 并返回结果
    
    注意：proxy 的 /eval 返回的是 JSON.stringify 的值，
    字符串会带外层引号如 "clicked"，Python 的 json.loads 能正确解析。
    """
    cmd = [
        "curl", "-s", "-X", "POST",
        f"{PROXY_URL}/eval?target={target_id}&metaAgentScope={agent_scope}",
        "-H", "Content-Type: application/json",
        "-d", code
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    raw = result.stdout.strip()
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        # 可能是裸字符串或 HTML/错误，直接返回原始文本
        return raw


def create_page(url: str, agent_scope: str) -> str:
    """创建新页面并返回 targetId"""
    cmd = ["curl", "-s", f"{PROXY_URL}/new?url={url}&metaAgentScope={agent_scope}"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    data = json.loads(result.stdout)
    return data.get("targetId", "")


def close_page(target_id: str, agent_scope: str):
    """关闭页面"""
    subprocess.run([
        "curl", "-s", "-X", "DELETE",
        f"{PROXY_URL}/close?target={target_id}&metaAgentScope={agent_scope}"
    ], capture_output=True)


def click_button(target_id: str, agent_scope: str, text: str) -> bool:
    """点击包含指定文本的可点击元素
    
    优先匹配 button.d-button（旧版小红书 UI），
    找不到时扩展到所有 button / span / div / a 元素。
    """
    code = f'''(() => {{
        // 1) 先找 button.d-button
        const dbtns = Array.from(document.querySelectorAll("button.d-button"));
        let el = dbtns.find(b => b.textContent?.trim() === "{text}" || b.textContent?.includes("{text}"));
        // 2) 找不到则扩展到任意可点击元素
        if (!el) {{
            const all = Array.from(document.querySelectorAll("button, span, div[role=button], a"));
            el = all.find(e => e.textContent?.trim() === "{text}" || e.textContent?.includes("{text}"));
        }}
        if (el) {{
            // 如果本身不是 clickable 的，找最近的可点击父元素
            const clickable = el.closest("button, a, [role=button], span[class*=click]");
            (clickable || el).click();
            return {{ clicked: true }};
        }}
        return {{ clicked: false }};
    }})()'''
    result = eval_js(target_id, agent_scope, code)
    return result.get("clicked", False)


def wait_for_editor(target_id: str, agent_scope: str, max_wait: int = 10) -> bool:
    """等待编辑器加载完成（2026-04-29 实测：点击文字配图后需轮询检测）"""
    code = '''(() => {
        const editors = document.querySelectorAll("[contenteditable=true], .ProseMirror");
        return { editorCount: editors.length };
    })()'''
    
    for i in range(max_wait // 2):
        time.sleep(2)
        result = eval_js(target_id, agent_scope, code)
        if result.get("editorCount", 0) > 0:
            print(f"  ✅ 编辑器已加载")
            return True
        print(f"  等待编辑器... {(i+1)*2}s")
    return False


def add_page(target_id: str, agent_scope: str) -> bool:
    """点击"再写一张"添加新页，并强制切到新页"""
    # 先记录当前 slide 数量
    count_before = eval_js(target_id, agent_scope,
        '(()=>document.querySelectorAll(".swiper-slide").length)()')
    
    code = '''(() => {
        const btn = document.querySelector("span.add-text-item-button-text");
        if (btn && btn.textContent?.trim() === "再写一张") {
            btn.parentElement.click();
            return "clicked";
        }
        return "not found";
    })()'''
    result = eval_js(target_id, agent_scope, code)
    if result != "clicked":
        return False
    
    # 等新 slide 出现，然后点击它（强制切到新页）
    for _ in range(10):
        time.sleep(0.5)
        new_count = eval_js(target_id, agent_scope,
            '(()=>document.querySelectorAll(".swiper-slide").length)()')
        if isinstance(new_count, int) and new_count > count_before:
            # 点击最后一个 slide 使其 active
            switched = eval_js(target_id, agent_scope,
                f'(()=>{{const slides=document.querySelectorAll(".swiper-slide");const last=slides[slides.length-1];if(last){{last.click();return"switched"}}return"no slide"}})()')
            return switched == "switched"
    return False


def _type_lines_into_editor(editor_focus_js: str, target_id: str, agent_scope: str, content: str) -> bool:
    """
    通用：通过 CDP Input.insertText + dispatchKeyEvent Enter 模拟逐行输入。
    替换原先的 execCommand('insertHTML')，解决多页 ProseMirror 换行丢失问题。

    editor_focus_js: 一段 JavaScript 表达式（不含 ``），用于 focus 编辑器并清除内容，
                     返回值须包含 .ok 布尔值。
    """
    # 1) 聚焦编辑器 + 清除旧内容
    focus_result = eval_js(target_id, agent_scope, editor_focus_js)
    if isinstance(focus_result, dict) and not focus_result.get("ok"):
        return False

    # 2) 逐行输入
    clean = content.replace('\r', '')
    lines = clean.split('\n')

    for i, line in enumerate(lines):
        # 输入当前行文本（通过 CDP Input.insertText）
        if line:
            subprocess.run([
                "curl", "-s", "-X", "POST",
                f"{PROXY_URL}/type?target={target_id}&metaAgentScope={agent_scope}",
                "-H", "Content-Type: text/plain",
                "-d", line
            ], capture_output=True)
            time.sleep(0.05)

        # 非最后一行 → 发送 Enter 键（CDP dispatchKeyEvent）
        if i < len(lines) - 1:
            enter_cmd = [
                "curl", "-s", "-X", "POST",
                f"{PROXY_URL}/enter?target={target_id}&metaAgentScope={agent_scope}"
            ]
            subprocess.run(enter_cmd, capture_output=True)
            time.sleep(0.05)

    return True


def fill_current_editor(target_id: str, agent_scope: str, content: str) -> bool:
    """填充当前激活页面（swiper-slide-active）的 ProseMirror 编辑器 — CDP 逐行打字"""
    focus_js = '''(() => {
        const activeSlide = document.querySelector(".swiper-slide-active");
        if (!activeSlide) return { error: "no active slide" };
        const editor = activeSlide.querySelector(".ProseMirror");
        if (!editor) return { error: "editor not found" };
        editor.focus();
        document.execCommand("selectAll", false, null);
        document.execCommand("delete", false, null);
        return { ok: true };
    })()'''
    return _type_lines_into_editor(focus_js, target_id, agent_scope, content)


def switch_to_slide(target_id: str, agent_scope: str, direction: str = "next") -> bool:
    """切换到上一页/下一页（通过 Swiper 导航按钮）"""
    selector = ".swiper-button-next" if direction == "next" else ".swiper-button-prev"
    code = f'''(() => {{
        const btn = document.querySelector("{selector}");
        if (btn && !btn.classList.contains("swiper-button-disabled")) {{
            btn.click();
            return "clicked";
        }}
        return "disabled or not found";
    }})()'''
    result = eval_js(target_id, agent_scope, code)
    return result == "clicked"


def fill_editor(target_id: str, agent_scope: str, content: str) -> bool:
    """填充封面 ProseMirror 编辑器 — CDP 逐行打字（替代 insertHTML）
    
    使用 CDP Input.insertText + dispatchKeyEvent Enter，
    模拟真实键盘输入。解决多页 ProseMirror 中 insertHTML 换行丢失的问题。
    """
    focus_js = '''(() => {
        const editor = document.querySelector(".ProseMirror");
        if (!editor) return { error: "editor not found" };
        editor.focus();
        document.execCommand("selectAll", false, null);
        document.execCommand("delete", false, null);
        return { ok: true };
    })()'''
    return _type_lines_into_editor(focus_js, target_id, agent_scope, content)


def fill_title(target_id: str, agent_scope: str, title: str) -> bool:
    """填充标题 — 通过原生 value setter 触发 Vue v-model，轮询等输入框"""
    # 先等输入框出现（最多5秒，新版页面切换较慢）
    for _ in range(5):
        r = eval_js(target_id, agent_scope,
            "(()=>{const i=document.querySelector('input[placeholder*=\"标题\"]');return i?'found':'waiting'})()")
        if r == "found":
            break
        time.sleep(1)
    escaped = json.dumps(title)
    code = f"""(() => {{
        const input = document.querySelector('input[placeholder*="标题"]');
        if (input) {{
            input.focus();
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, "value"
            ).set;
            nativeSetter.call(input, {escaped});
            input.dispatchEvent(new Event("input", {{ bubbles: true }}));
            return "filled";
        }}
        return "not found";
    }})()"""
    result = eval_js(target_id, agent_scope, code)
    return result == "filled"


def select_style(target_id: str, agent_scope: str, style: str) -> bool:
    """选择风格"""
    code = f'''(() => {{
        const allElements = Array.from(document.querySelectorAll("div, span, button"));
        const styleBtn = allElements.find(el => el.textContent?.trim() === "{style}");
        if (styleBtn) {{ styleBtn.click(); return "clicked"; }}
        return "not found";
    }})()'''
    result = eval_js(target_id, agent_scope, code)
    return result == "clicked"


def wait_for_image_generation(target_id: str, agent_scope: str, max_wait: int = 30):
    """等待图片生成完成（新版小红书按钮也是 span 了）"""
    code = '''(() => {
        const btn = Array.from(document.querySelectorAll("button,span")).find(b => 
            b.textContent?.trim() === "下一步"
        );
        return { hasNextBtn: !!btn };
    })()'''
    
    for i in range(max_wait // 5):
        time.sleep(5)
        result = eval_js(target_id, agent_scope, code)
        if result.get("hasNextBtn"):
            return True
        print(f"  等待生成中... {i+1}/{max_wait//5}")
    return False


def check_published(target_id: str, agent_scope: str) -> dict:
    """检查是否发布成功（2026-04-29 实测：URL跳转到/publish/success）"""
    code = '''(() => ({
        url: window.location.href,
        published: window.location.href.includes("success") || 
                   document.body.textContent?.includes("发布成功")
    }))()'''
    return eval_js(target_id, agent_scope, code)


def publish_note(title: str, content: str, style: str = None, description: str = None) -> dict:
    """发布小红书笔记 — 智能分页（每页 ≤450 字），支持换行排版"""
    start_time = time.time()
    agent_scope = _resolve_agent_scope()
    target_id = ''
    
    print(f"[发布笔记] 标题: {title}")
    print(f"[发布笔记] 内容长度: {len(content)} 字")
    if style:
        print(f"[发布笔记] 风格: {style}")
    
    try:
        # 1. 创建页面（实测：需要8秒）
        print("\n[1/9] 打开发布页面...")
        target_id = create_page(PUBLISH_URL, agent_scope)
        if not target_id:
            return {"ok": False, "error": "无法创建页面"}
        print(f"  targetId: {target_id}")
        time.sleep(8)  # 之前4秒不够
        
        # 2. 点击"上传图文"（实测：需要5秒切换）
        print("\n[2/9] 点击上传图文...")
        if not click_button(target_id, agent_scope, "上传图文"):
            return {"ok": False, "error": "未找到上传图文按钮"}
        time.sleep(5)  # 之前2秒不够
        
        # 3. 点击"文字配图"（精确匹配 button.d-button）
        print("\n[3/9] 点击文字配图...")
        if not click_button(target_id, agent_scope, "文字配图"):
            return {"ok": False, "error": "未找到文字配图按钮"}
        time.sleep(5)
        
        # 3.5 等待编辑器加载（新增：需要轮询检测）
        print("\n[检查] 等待编辑器加载...")
        if not wait_for_editor(target_id, agent_scope):
            return {"ok": False, "error": "编辑器加载超时"}
        
        # 4. 填写正文（智能分页：每页最多 450 字，优先显式分隔符）
        print("\n[4/9] 填写正文...")
        pages = split_content_to_pages(content)
        print(f"  共 {len(pages)} 页")
        
        # 填写封面（第一页）
        print(f"  封面: {len(pages[0])} 字")
        if not fill_editor(target_id, agent_scope, pages[0]):
            return {"ok": False, "error": "无法填写封面"}
        time.sleep(1)
        
        # 填写后续页
        for i, page_content in enumerate(pages[1:], start=2):
            print(f"\n  [4.{i}] 添加第 {i} 页: {len(page_content)} 字...")
            if not add_page(target_id, agent_scope):
                return {"ok": False, "error": f"无法添加第 {i} 页"}
            time.sleep(2)
            # 等待新页编辑器加载
            for _ in range(5):
                r = eval_js(target_id, agent_scope,
                    '(()=>{const s=document.querySelector(".swiper-slide-active");return s&&s.querySelector(".ProseMirror")?"found":"waiting"})()')
                if r == "found":
                    break
                time.sleep(1)
            if not fill_current_editor(target_id, agent_scope, page_content):
                return {"ok": False, "error": f"无法填写第 {i} 页"}
            time.sleep(1)
        
        # 5. 点击"生成图片"（新版小红书是 span，不是 button）
        print("\n[5/9] 点击生成图片...")
        code = '''(() => {
            const el = Array.from(document.querySelectorAll("span,button")).find(s => 
                s.textContent?.trim() === "生成图片" || s.textContent?.includes("生成图片")
            );
            if (el) {
                el.click();
                return "clicked";
            }
            return "not found";
        })()'''
        result = eval_js(target_id, agent_scope, code)
        if result != "clicked":
            return {"ok": False, "error": "未找到生成图片按钮"}
        
        # 6. 等待生成完成（实测：需要30秒）
        print("\n[6/9] 等待图片生成...")
        if not wait_for_image_generation(target_id, agent_scope):
            return {"ok": False, "error": "图片生成超时"}
        
        # 7. 选择风格（可选）
        if style:
            print(f"\n[7/9] 选择风格: {style}...")
            select_style(target_id, agent_scope, style)
            time.sleep(2)
        else:
            print("\n[7/9] 使用默认风格...")
        
        # 8. 点击"下一步"
        print("\n[8/9] 点击下一步...")
        if not click_button(target_id, agent_scope, "下一步"):
            return {"ok": False, "error": "未找到下一步按钮"}
        time.sleep(5)  # 等标题输入框出现（新版页面较慢）
        
        # 9. 填写标题
        print("\n[9/9] 填写标题...")
        if not fill_title(target_id, agent_scope, title):
            return {"ok": False, "error": "无法填写标题"}
        time.sleep(1)
        
        # 9.5 填写独立正文（如果有 description）
        if description:
            print("\n[9.5/9] 填写独立正文...")
            if not fill_description(target_id, agent_scope, description):
                print("  ⚠️ 未找到独立正文编辑器，跳过")
            time.sleep(1)
        
        # 10. 点击发布
        print("\n[10/9] 点击发布...")
        if not click_button(target_id, agent_scope, "发布"):
            return {"ok": False, "error": "未找到发布按钮"}
        time.sleep(5)
        
        # 检查结果
        result = check_published(target_id, agent_scope)
        elapsed = time.time() - start_time
        
        if result.get("published"):
            # 记录发布
            data = load_published_notes()
            data["notes"].append({
                "title": title,
                "publishedAt": time.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
                "style": style or "默认",
                "contentPreview": content[:50] + "..." if len(content) > 50 else content,
                "method": "文字配图",
                "url": result.get("url", "")
            })
            save_published_notes(data)
            
            print(f"\n✅ 发布成功!")
            print(f"   耗时: {elapsed:.1f} 秒")
            
            return {
                "ok": True,
                "published": True,
                "elapsed": elapsed,
                "url": result.get("url", "")
            }
        else:
            return {"ok": False, "error": "发布失败", "url": result.get("url", "")}
    finally:
        # 无论成功或失败，都确保关闭页面
        if target_id:
            close_page(target_id, agent_scope)


def list_notes():
    """列出已发布笔记"""
    data = load_published_notes()
    notes = data.get("notes", [])
    
    print(f"\n已发布笔记 ({len(notes)} 篇):\n")
    for i, note in enumerate(notes, 1):
        print(f"  {i}. {note['title']}")
        print(f"     发布时间: {note['publishedAt']}")
        print(f"     风格: {note['style']}")
        print()


def fill_description(target_id: str, agent_scope: str, description: str) -> bool:
    """填充发布预览页面的独立正文（tiptap ProseMirror 编辑器）
    
    先清除原有的图片配文拼接内容，再写入完整的读后感正文。
    如果页面没有独立正文编辑器（非文字配图模式），返回 False。
    """
    # 等正文编辑器出现
    for _ in range(5):
        r = eval_js(target_id, agent_scope,
            "(()=>{const e=document.querySelector('.tiptap.ProseMirror');return e?'found':'waiting'})()")
        if r == "found":
            break
        time.sleep(1)
    
    # 清除旧内容并填入新正文
    focus_js = '''(() => {
        const editor = document.querySelector(".tiptap.ProseMirror");
        if (!editor) return { error: "tiptap editor not found" };
        editor.focus();
        document.execCommand("selectAll", false, null);
        document.execCommand("delete", false, null);
        return { ok: true };
    })()'''
    return _type_lines_into_editor(focus_js, target_id, agent_scope, description)


def check_published_title(title_keyword: str):
    """检查标题是否已发布"""
    data = load_published_notes()
    notes = data.get("notes", [])
    
    for note in notes:
        if title_keyword.lower() in note["title"].lower():
            print(f"\n⚠️ 可能已发布类似内容:")
            print(f"   标题: {note['title']}")
            print(f"   发布时间: {note['publishedAt']}")
            return {"alreadyPublished": True, "note": note}
    
    print(f"\n✅ 未找到类似已发布内容")
    return {"alreadyPublished": False}


def main():
    parser = argparse.ArgumentParser(description="小红书笔记发布脚本（2026-04-29 优化版）")
    parser.add_argument("--title", help="笔记标题")
    parser.add_argument("--content", help="笔记正文（图片配文内容）")
    parser.add_argument("--content-file", help="正文文件路径（图片配文内容）")
    parser.add_argument("--description", help="笔记正文（完整读后感，发布预览页面填写）")
    parser.add_argument("--description-file", help="正文文件路径（发布预览页面填写）")
    parser.add_argument("--style", choices=STYLES, help="配图风格")
    parser.add_argument("--list", action="store_true", help="列出已发布笔记")
    parser.add_argument("--check", action="store_true", help="检查是否已发布")
    
    args = parser.parse_args()
    
    if args.list:
        list_notes()
        return
    
    if args.check:
        if not args.title:
            print("请使用 --title 指定检查关键词")
            return
        check_published_title(args.title)
        return
    
    if not args.title:
        print("请使用 --title 指定标题")
        parser.print_help()
        return
    
    content = args.content
    if args.content_file:
        content = Path(args.content_file).read_text()
    
    if not content:
        print("请使用 --content 或 --content-file 指定正文")
        parser.print_help()
        return
    
    description = args.description
    if args.description_file:
        description = Path(args.description_file).read_text()
    
    result = publish_note(args.title, content, args.style, description)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()