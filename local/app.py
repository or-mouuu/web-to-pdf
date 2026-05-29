import io
import base64
import re
from flask import Flask, request, send_file, jsonify
from playwright.sync_api import sync_playwright

app = Flask(__name__)

# URL slug → 中文類別名稱
CATEGORY_MAP = {
    'focus':    'TAICCA聚焦',
    'research': '產業研究',
    'trace':    '事件追蹤',
    'data':     '數據觀點',
    'graphic':  '圖解趨勢',
}

def get_article_meta(url: str) -> tuple[str, str]:
    """從 URL 解析 (vol編號, 類別中文名)。
    例：/article/focus-17  → ('17', 'TAICCA聚焦')
        /article/research-17a → ('17', '產業研究')
    """
    m = re.search(r'/article/([a-z]+)-(\d+)', url)
    if not m:
        return '', ''
    key = m.group(1)
    vol = m.group(2)
    cat = CATEGORY_MAP.get(key, '')
    return vol, cat

FRONTEND = """<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>網頁轉 PDF 工具</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #f5f5f5; display: flex; justify-content: center;
         align-items: center; min-height: 100vh; padding: 20px; }
  .card { background: white; border-radius: 12px; padding: 36px 40px;
          width: 100%; max-width: 560px; box-shadow: 0 4px 24px rgba(0,0,0,0.1); }
  h1 { font-size: 1.4rem; color: #1a1a1a; margin-bottom: 6px; }
  .subtitle { color: #666; font-size: 0.9rem; margin-bottom: 28px; }
  label { display: block; font-size: 0.85rem; color: #444; margin-bottom: 6px; font-weight: 500; }
  input[type=url] {
    width: 100%; padding: 10px 14px; border: 1.5px solid #ddd;
    border-radius: 8px; font-size: 0.95rem; outline: none;
    transition: border-color .2s; margin-bottom: 20px;
  }
  input[type=url]:focus { border-color: #4f46e5; }
  .row { display: flex; gap: 24px; margin-bottom: 20px; }
  .field { flex: 1; }
  input[type=range] { width: 100%; accent-color: #4f46e5; cursor: pointer; }
  .range-labels { display: flex; justify-content: space-between;
                  font-size: 0.75rem; color: #999; margin-top: 2px; }
  select { width: 100%; padding: 8px 12px; border: 1.5px solid #ddd;
           border-radius: 8px; font-size: 0.9rem; background: white; }
  button {
    width: 100%; padding: 12px; background: #4f46e5; color: white;
    border: none; border-radius: 8px; font-size: 1rem; font-weight: 600;
    cursor: pointer; transition: background .2s;
  }
  button:hover:not(:disabled) { background: #4338ca; }
  button:disabled { background: #a5b4fc; cursor: not-allowed; }
  #status { margin-top: 16px; font-size: 0.9rem; color: #555; min-height: 1.4em; text-align: center; }
  .progress { display: none; margin-top: 10px; background: #e0e7ff;
              border-radius: 99px; height: 6px; overflow: hidden; }
  .progress-bar { height: 100%; background: #4f46e5; border-radius: 99px;
                  animation: indeterminate 1.5s ease-in-out infinite; width: 40%; }
  @keyframes indeterminate {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(350%); }
  }
  .error { color: #dc2626; }
  .success { color: #16a34a; }
</style>
</head>
<body>
<div class="card">
  <h1>網頁轉 A4 PDF</h1>
  <p class="subtitle">支援 Flourish 等互動式嵌入圖表，自動等待載入後截圖</p>

  <label for="url">文章網址</label>
  <input type="url" id="url" placeholder="https://example.com/article" autocomplete="off">

  <div class="row">
    <div class="field">
      <label>字體縮放：<strong id="scaleVal">1.2×</strong></label>
      <input type="range" id="fontScale" min="0.8" max="2.0" step="0.1" value="1.2"
             oninput="document.getElementById('scaleVal').textContent=this.value+'×'">
      <div class="range-labels"><span>0.8×</span><span>2.0×</span></div>
    </div>
    <div class="field">
      <label for="waitTime">等待時間（動態內容）</label>
      <select id="waitTime">
        <option value="5000">5 秒（一般頁面）</option>
        <option value="10000" selected>10 秒（含 Flourish）</option>
        <option value="20000">20 秒（較慢的頁面）</option>
      </select>
    </div>
  </div>

  <button id="btn" onclick="generatePdf()">產生並下載 PDF</button>
  <div id="status"></div>
  <div class="progress" id="progress"><div class="progress-bar"></div></div>
</div>

<script>
async function generatePdf() {
  const url = document.getElementById('url').value.trim();
  if (!url) { setStatus('請輸入網址', 'error'); return; }

  const btn = document.getElementById('btn');
  btn.disabled = true;
  setStatus('正在啟動瀏覽器，等待頁面與圖表載入⋯', '');
  document.getElementById('progress').style.display = 'block';

  try {
    const res = await fetch('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        font_scale: parseFloat(document.getElementById('fontScale').value),
        extra_wait: parseInt(document.getElementById('waitTime').value),
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || '未知錯誤');
    }

    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="(.+?)"/);
    const filename = match ? match[1] : 'article.pdf';

    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setStatus('✓ 下載完成！', 'success');
  } catch (e) {
    setStatus('錯誤：' + e.message, 'error');
  } finally {
    btn.disabled = false;
    document.getElementById('progress').style.display = 'none';
  }
}

function setStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = type;
}

document.getElementById('url').addEventListener('keydown', e => {
  if (e.key === 'Enter') generatePdf();
});
</script>
</body>
</html>"""


def safe_filename(title: str) -> str:
    name = re.sub(r'[\\/:*?"<>|]', '_', title)
    return (name[:80] or 'article') + '.pdf'


def _screenshot_and_replace(page, selector: str, label: str):
    """
    通用：找到所有符合 selector 的元素，截圖後用 <img> 取代。
    attr_name 用來標記元素避免取代後 index 位移。
    """
    attr = 'data-pdf-rep'
    page.evaluate(f"""() => {{
        document.querySelectorAll('{selector}').forEach(function(el, i) {{
            el.setAttribute('{attr}', '{label}-' + i);
        }});
    }}""")
    count = page.evaluate(f"() => document.querySelectorAll('{selector}').length")

    for i in range(count):
        key = f'{label}-{i}'
        try:
            el = page.query_selector(f'[{attr}="{key}"]')
            if not el:
                continue
            box = el.bounding_box()
            if not box or box['width'] < 20 or box['height'] < 20:
                continue
            el.scroll_into_view_if_needed()
            page.wait_for_timeout(300)
            shot = el.screenshot(type='png')
            b64 = base64.b64encode(shot).decode()
            w = int(box['width'])
            page.evaluate(f"""() => {{
                const el = document.querySelector('[{attr}="{key}"]');
                if (!el) return;
                const img = document.createElement('img');
                img.src = 'data:image/png;base64,{b64}';
                img.style.cssText = 'width:{w}px;max-width:100%;height:auto;display:block;';
                el.replaceWith(img);
            }}""")
        except Exception as exc:
            print(f'[{label} {i}] 略過：{exc}')


def replace_embeds_and_iframes(page):
    """
    1. 優先截圖整個自訂 embed 容器（.w-embed.w-iframe），保留並排版型
    2. 再截圖其餘個別 iframe
    """
    # Step 1: 自訂 HTML embed 容器（如並排 Flourish），整體截一張圖
    _screenshot_and_replace(page, '.w-embed.w-iframe', 'wembed')

    # Step 2: 剩餘獨立 iframe（標準 Flourish embed、YouTube 等）
    _screenshot_and_replace(page, 'iframe', 'iframe')


def generate_pdf(url: str, font_scale: float = 1.2, extra_wait: int = 10000) -> tuple[bytes, str]:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            args=['--disable-blink-features=AutomationControlled',
                  '--disable-web-security']   # 允許跨域截圖
        )
        ctx = browser.new_context(
            viewport={'width': 1280, 'height': 900},
            user_agent=(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/124.0.0.0 Safari/537.36'
            ),
        )
        page = ctx.new_page()

        # 導航並等待主要資源載入
        page.goto(url, wait_until='networkidle', timeout=90_000)

        # 緩慢滾動以觸發 lazy-load（Flourish iframe 常見）
        page.evaluate("""async () => {
            await new Promise(resolve => {
                let h = 0;
                const step = 400;
                const t = setInterval(() => {
                    window.scrollBy(0, step);
                    h += step;
                    if (h >= document.body.scrollHeight) {
                        clearInterval(t);
                        window.scrollTo(0, 0);
                        resolve();
                    }
                }, 120);
            });
        }""")

        # 等待動態內容（Flourish 圖表渲染）
        page.wait_for_timeout(extra_wait)
        page.wait_for_load_state('networkidle')

        # 取得頁面標題作為檔名
        title = page.title()

        # ── Step 1: 截圖 embed 容器 & iframe ──────────────────────────────
        replace_embeds_and_iframes(page)

        # ── Step 2: 在隱藏 DOM 前，先從頁面取得文章標題（避免隱藏後取不到）──
        article_title = page.evaluate("""() => {
            // 依優先順序找可見的 h1
            var candidates = document.querySelectorAll('h1');
            for (var i = 0; i < candidates.length; i++) {
                var el = candidates[i];
                if (el.offsetHeight > 0) {
                    return el.innerText.trim().replace(/\\s+/g, ' ');
                }
            }
            // fallback: 頁面 <title>，去掉網站名稱
            return document.title.split('|')[0].split('｜')[0].trim();
        }""")

        # ── Step 3: DOM 清理 + 注入自製標題 ────────────────────────────────
        vol, cat_name = get_article_meta(url)
        label = f'vol.{vol} ｜ {cat_name}' if vol and cat_name else cat_name

        page.evaluate("""(args) => {
            var label       = args.label;
            var articleTitle = args.articleTitle;

            // A. fixed / sticky 元素全部隱藏（nav、浮動按鈕等）
            Array.from(document.querySelectorAll('*')).forEach(function(el) {
                var pos = window.getComputedStyle(el).position;
                if (pos === 'fixed' || pos === 'sticky') {
                    el.style.setProperty('display', 'none', 'important');
                }
            });

            // B. 語意化 header / nav
            document.querySelectorAll(
                'header, nav, [role="banner"], [role="navigation"]'
            ).forEach(function(el) {
                el.style.setProperty('display', 'none', 'important');
            });

            // C. author-section 後面的全部隱藏（readmore、footer 等）
            var authorSection = document.querySelector('.author-section');
            if (authorSection) {
                var sib = authorSection.nextElementSibling;
                while (sib) {
                    sib.style.setProperty('display', 'none', 'important');
                    sib = sib.nextElementSibling;
                }
            }
            document.querySelectorAll(
                'footer, [class*="footer"], [class*="Footer"], ' +
                '.readmore-section, .focus-readmore-section, .focus-readdata-section'
            ).forEach(function(el) {
                el.style.setProperty('display', 'none', 'important');
            });

            // D. 隱藏所有原始標題元素
            //    （focus-heading-wrapper、heading-wrapper、h1、類別標籤、收錄於區塊）
            document.querySelectorAll(
                '.focus-heading-wrapper, .heading-wrapper, ' +
                'h1, ' +
                '[class*="group-heading-bg"], ' +
                '[class*="heading1"], ' +
                '.div-block-145'
            ).forEach(function(el) {
                el.style.setProperty('display', 'none', 'important');
            });

            // E. 隱藏空的 cover 佔位元素
            document.querySelectorAll(
                '.focus-cover-img-wrapper, .cover-img-wrapper'
            ).forEach(function(el) {
                if (el.offsetHeight === 0) {
                    el.style.setProperty('display', 'none', 'important');
                }
            });

            // F. 注入自製標題（類別 + 大標），插在 content-section 最前面
            var cs = document.querySelector('.content-section');
            if (cs) {
                var wrapper = document.createElement('div');
                wrapper.style.cssText = [
                    'padding: 24px 0 20px 0',
                    'margin-bottom: 0',
                    'border-bottom: 2px solid #222',
                ].join('; ');

                if (label) {
                    var catEl = document.createElement('p');
                    catEl.textContent = label;
                    catEl.style.cssText = [
                        'font-size: 14px',
                        'font-weight: 600',
                        'color: #555',
                        'margin: 0 0 10px 0',
                        'letter-spacing: 0.08em',
                        'font-family: inherit',
                    ].join('; ');
                    wrapper.appendChild(catEl);
                }

                var titleEl = document.createElement('h1');
                titleEl.textContent = articleTitle;
                titleEl.style.cssText = [
                    'font-size: 34px',
                    'font-weight: 700',
                    'color: #111',
                    'line-height: 1.35',
                    'margin: 0',
                    'letter-spacing: 0.02em',
                    'font-family: inherit',
                ].join('; ');
                wrapper.appendChild(titleEl);

                cs.insertBefore(wrapper, cs.firstChild);
            }

            // G. 縮小 content-section padding
            document.querySelectorAll('.content-section').forEach(function(el) {
                el.style.setProperty('padding-top',    '16px', 'important');
                el.style.setProperty('padding-bottom', '10px', 'important');
            });

            // H. 強制白底（body 背景為黑色，隱藏後會透出）
            document.documentElement.style.setProperty('background-color', 'white', 'important');
            document.body.style.setProperty('background-color', 'white', 'important');
        }""", {'label': label, 'articleTitle': article_title})

        # ── Step 3: 字體縮放（JS 讀 computed px 值再倍乘，適用 px 固定單位網站）──
        # 只縮放文章內文區域，標題 / 圖片不影響
        if abs(font_scale - 1.0) > 0.05:   # 偏差 >5% 才執行，避免不必要的 DOM 操作
            page.evaluate(f"""() => {{
                const scale = {font_scale};
                // 目標：文章 richtext 內所有文字元素
                const roots = document.querySelectorAll(
                    '.content-text, .w-richtext, .content, .author-section'
                );
                roots.forEach(function(root) {{
                    var walker = document.createTreeWalker(root, 0x1 /* SHOW_ELEMENT */);
                    var node;
                    while ((node = walker.nextNode())) {{
                        var fs = parseFloat(window.getComputedStyle(node).fontSize);
                        if (!isNaN(fs) && fs >= 8) {{
                            node.style.setProperty('font-size', (fs * scale) + 'px', 'important');
                        }}
                    }}
                }});
            }}""")

        # ── Step 4: 其餘列印 CSS ────────────────────────────────────────────
        page.add_style_tag(content="""
            img { max-width: 100% !important; height: auto !important; }
            a   { color: inherit !important; text-decoration: none !important; }
        """)

        pdf = page.pdf(
            format='A4',
            margin={'top': '15mm', 'bottom': '15mm',
                    'left': '15mm', 'right': '15mm'},
            print_background=True,
            prefer_css_page_size=False,
        )
        browser.close()

    return pdf, safe_filename(title)


@app.route('/')
def index():
    return FRONTEND


@app.route('/generate', methods=['POST'])
def generate():
    data = request.get_json(force=True)
    url = (data.get('url') or '').strip()
    if not url:
        return jsonify({'error': '請提供網址'}), 400

    font_scale = float(data.get('font_scale', 1.2))
    extra_wait = int(data.get('extra_wait', 10_000))

    try:
        pdf_bytes, filename = generate_pdf(url, font_scale, extra_wait)
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500

    return send_file(
        io.BytesIO(pdf_bytes),
        mimetype='application/pdf',
        as_attachment=True,
        download_name=filename,
    )


if __name__ == '__main__':
    print('啟動中，請用瀏覽器開啟 http://127.0.0.1:5001')
    app.run(port=5001, debug=False)
