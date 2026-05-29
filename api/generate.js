'use strict';

// ── 依賴 ──────────────────────────────────────────────────────────────────────
// 本機開發：npm install 後執行 npx playwright install chromium
// Vercel：  使用 @sparticuz/chromium（無頭 Chromium，適用 serverless 環境）
// -----------------------------------------------------------------
const { chromium } = require('playwright-core');

// ── 文章類別對照 ──────────────────────────────────────────────────────────────
const CATEGORY_MAP = {
  focus:    'TAICCA聚焦',
  research: '產業研究',
  trace:    '事件追蹤',
  data:     '數據觀點',
  graphic:  '圖解趨勢',
};

function getArticleMeta(url) {
  const m = url.match(/\/article\/([a-z]+)-(\d+)/);
  if (!m) return { vol: '', category: '' };
  return { vol: m[2], category: CATEGORY_MAP[m[1]] || '' };
}

function safeFilename(title) {
  const name = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  return (name || 'article') + '.pdf';
}

// ── 瀏覽器啟動設定（Vercel vs 本機） ──────────────────────────────────────────
async function getBrowserOptions() {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    // Vercel serverless：使用精簡版 Chromium
    const chromiumPkg = require('@sparticuz/chromium');
    return {
      args: chromiumPkg.args,
      executablePath: await chromiumPkg.executablePath(),
      headless: chromiumPkg.headless,
    };
  }
  // 本機：playwright install chromium 安裝的瀏覽器
  return {
    args: ['--disable-blink-features=AutomationControlled', '--disable-web-security'],
    headless: true,
  };
}

// ── 截圖 + 取代元素 ────────────────────────────────────────────────────────────
async function screenshotAndReplace(page, selector, label) {
  await page.evaluate(
    ({ sel, lbl }) => {
      document.querySelectorAll(sel).forEach((el, i) => {
        el.setAttribute('data-pdf-rep', `${lbl}-${i}`);
      });
    },
    { sel: selector, lbl: label }
  );

  const count = await page.evaluate(
    ({ sel }) => document.querySelectorAll(sel).length,
    { sel: selector }
  );

  for (let i = 0; i < count; i++) {
    const key = `${label}-${i}`;
    try {
      const el = page.locator(`[data-pdf-rep="${key}"]`).first();
      const box = await el.boundingBox();
      if (!box || box.width < 20 || box.height < 20) continue;

      await el.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);

      const shot = await el.screenshot({ type: 'png' });
      const b64  = shot.toString('base64');
      const w    = Math.round(box.width);

      await page.evaluate(
        ({ key, b64, w }) => {
          const el = document.querySelector(`[data-pdf-rep="${key}"]`);
          if (!el) return;
          const img = document.createElement('img');
          img.src = `data:image/png;base64,${b64}`;
          img.style.cssText = `width:${w}px;max-width:100%;height:auto;display:block;`;
          el.replaceWith(img);
        },
        { key, b64, w }
      );
    } catch (e) {
      console.log(`[${label} ${i}] 略過：${e.message}`);
    }
  }
}

// ── 核心：生成 PDF ─────────────────────────────────────────────────────────────
async function generatePdf(url, fontScale = 1.2, extraWait = 10000) {
  const opts    = await getBrowserOptions();
  const browser = await chromium.launch(opts);

  try {
    const context = await browser.newContext({
      viewport:  { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // 1. 導航
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });

    // 2. 緩慢滾動，觸發 lazy-load iframe
    await page.evaluate(async () => {
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
    });

    // 3. 等待動態內容（Flourish 等）
    await page.waitForTimeout(extraWait);
    await page.waitForLoadState('networkidle');

    // 4. 取得頁面標題（用於檔名）
    const pageTitle = await page.title();

    // 5. 截圖自訂 embed 容器（並排 Flourish）→ 再截剩餘 iframe
    await screenshotAndReplace(page, '.w-embed.w-iframe', 'wembed');
    await screenshotAndReplace(page, 'iframe', 'iframe');

    // 6. 在隱藏任何元素前，先從 DOM 取得文章標題
    const articleTitle = await page.evaluate(() => {
      for (const h1 of document.querySelectorAll('h1')) {
        if (h1.offsetHeight > 0) {
          return h1.innerText.trim().replace(/\s+/g, ' ');
        }
      }
      return document.title.split('|')[0].split('｜')[0].trim();
    });

    // 7. DOM 清理 + 注入自製標題
    const { vol, category } = getArticleMeta(url);
    const label = vol && category ? `vol.${vol} ｜ ${category}` : category;

    await page.evaluate(
      ({ label, articleTitle, fontScale }) => {
        // A. 隱藏所有 fixed / sticky 元素
        Array.from(document.querySelectorAll('*')).forEach(el => {
          const pos = window.getComputedStyle(el).position;
          if (pos === 'fixed' || pos === 'sticky') {
            el.style.setProperty('display', 'none', 'important');
          }
        });

        // B. 隱藏語意化 header / nav
        document.querySelectorAll('header, nav, [role="banner"], [role="navigation"]')
          .forEach(el => el.style.setProperty('display', 'none', 'important'));

        // C. author-section 後面的全部隱藏（readmore、footer…）
        const authorSection = document.querySelector('.author-section');
        if (authorSection) {
          let sib = authorSection.nextElementSibling;
          while (sib) {
            sib.style.setProperty('display', 'none', 'important');
            sib = sib.nextElementSibling;
          }
        }
        document.querySelectorAll(
          'footer, [class*="footer"], [class*="Footer"], ' +
          '.readmore-section, .focus-readmore-section, .focus-readdata-section'
        ).forEach(el => el.style.setProperty('display', 'none', 'important'));

        // D. 隱藏所有原始標題元素（h1、heading-wrapper、類別標籤…）
        document.querySelectorAll(
          '.focus-heading-wrapper, .heading-wrapper, ' +
          'h1, [class*="group-heading-bg"], [class*="heading1"], .div-block-145'
        ).forEach(el => el.style.setProperty('display', 'none', 'important'));

        // E. 隱藏高度為 0 的 cover 佔位元素
        document.querySelectorAll('.focus-cover-img-wrapper, .cover-img-wrapper')
          .forEach(el => {
            if (el.offsetHeight === 0) el.style.setProperty('display', 'none', 'important');
          });

        // F. 注入自製標題（類別 + 大標題）
        const cs = document.querySelector('.content-section');
        if (cs) {
          const wrapper = document.createElement('div');
          wrapper.style.cssText = 'padding:24px 0 20px 0; border-bottom:2px solid #222; margin-bottom:0;';

          if (label) {
            const catEl = document.createElement('p');
            catEl.textContent = label;
            catEl.style.cssText = 'font-size:14px;font-weight:600;color:#555;margin:0 0 10px 0;letter-spacing:0.08em;font-family:inherit;';
            wrapper.appendChild(catEl);
          }

          const titleEl = document.createElement('h1');
          titleEl.textContent = articleTitle;
          titleEl.style.cssText = 'font-size:34px;font-weight:700;color:#111;line-height:1.35;margin:0;letter-spacing:0.02em;font-family:inherit;';
          wrapper.appendChild(titleEl);

          cs.insertBefore(wrapper, cs.firstChild);
        }

        // G. 縮小 content-section 大 padding
        document.querySelectorAll('.content-section').forEach(el => {
          el.style.setProperty('padding-top',    '16px', 'important');
          el.style.setProperty('padding-bottom', '10px', 'important');
        });

        // H. 強制白底（body 背景為黑色）
        document.documentElement.style.setProperty('background-color', 'white', 'important');
        document.body.style.setProperty('background-color', 'white', 'important');

        // I. 字體縮放：讀 computed px 值後倍乘（適用 px 固定單位網站）
        if (Math.abs(fontScale - 1.0) > 0.05) {
          document.querySelectorAll('.content-text, .w-richtext, .content, .author-section')
            .forEach(root => {
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
              let node;
              while ((node = walker.nextNode())) {
                const fs = parseFloat(window.getComputedStyle(node).fontSize);
                if (!isNaN(fs) && fs >= 8) {
                  node.style.setProperty('font-size', `${fs * fontScale}px`, 'important');
                }
              }
            });
        }
      },
      { label, articleTitle, fontScale }
    );

    // 8. 基本列印 CSS
    await page.addStyleTag({
      content: 'img{max-width:100%!important;height:auto!important}a{color:inherit!important;text-decoration:none!important}',
    });

    // 9. 輸出 A4 PDF
    const pdfBytes = await page.pdf({
      format:             'A4',
      margin:             { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' },
      printBackground:    true,
      preferCSSPageSize:  false,
    });

    return { pdfBytes, filename: safeFilename(pageTitle) };
  } finally {
    await browser.close();
  }
}

// ── Vercel serverless handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url, font_scale = 1.2, extra_wait = 10000 } = req.body || {};
  if (!url) return res.status(400).json({ error: '請提供網址' });

  try {
    const { pdfBytes, filename } = await generatePdf(
      String(url).trim(),
      parseFloat(font_scale),
      parseInt(extra_wait)
    );
    const encodedName = encodeURIComponent(filename);
    res.setHeader('Content-Type', 'application/pdf');
    // RFC 5987：filename= 給舊用戶端，filename*= 給支援 UTF-8 的用戶端
    res.setHeader('Content-Disposition',
      `attachment; filename="article.pdf"; filename*=UTF-8''${encodedName}`);
    res.end(Buffer.from(pdfBytes));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
};
