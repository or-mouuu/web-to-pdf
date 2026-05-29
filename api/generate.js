'use strict';

// ── 瀏覽器策略 ─────────────────────────────────────────────────────────────────
// Vercel serverless：puppeteer-core + @sparticuz/chromium（官方測試的組合）
// 本機開發：      playwright（已有 Chromium，API 大致相同）
// ──────────────────────────────────────────────────────────────────────────────

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
  return (title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'article') + '.pdf';
}

// ── 瀏覽器啟動 ────────────────────────────────────────────────────────────────
async function launchBrowser() {
  const IS_SERVERLESS =
    !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

  if (IS_SERVERLESS) {
    // Vercel：puppeteer-core + @sparticuz/chromium（相容性最好的組合）
    const puppeteer   = require('puppeteer-core');
    const chromiumPkg = require('@sparticuz/chromium');
    return {
      browser: await puppeteer.launch({
        args:           chromiumPkg.args,
        executablePath: await chromiumPkg.executablePath(),
        headless:       true,
        defaultViewport: { width: 1280, height: 900 },
      }),
      isPuppeteer: true,
    };
  }

  // 本機：playwright（已由 npx playwright install chromium 安裝）
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    args:    ['--disable-blink-features=AutomationControlled', '--disable-web-security'],
    headless: true,
  });
  return { browser, isPuppeteer: false };
}

// ── 建立 page 物件（統一 viewport + userAgent） ────────────────────────────────
async function newPage(browser, isPuppeteer) {
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  if (isPuppeteer) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(UA);
    return page;
  }

  // Playwright
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: UA });
  return await context.newPage();
}

// ── 等待 network idle（跨框架相容） ──────────────────────────────────────────
async function waitNetworkIdle(page, isPuppeteer) {
  try {
    if (isPuppeteer) {
      await page.waitForNetworkIdle({ timeout: 10000 });
    } else {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    }
  } catch {
    // timeout 不影響流程
  }
}

// ── 等待毫秒（跨框架相容） ────────────────────────────────────────────────────
async function sleep(page, isPuppeteer, ms) {
  if (isPuppeteer) {
    await new Promise(r => setTimeout(r, ms));
  } else {
    await page.waitForTimeout(ms);
  }
}

// ── 截圖 + 取代元素 ────────────────────────────────────────────────────────────
async function screenshotAndReplace(page, isPuppeteer, selector, label) {
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
      let el, box;

      if (isPuppeteer) {
        el  = await page.$(`[data-pdf-rep="${key}"]`);
        if (!el) continue;
        box = await el.boundingBox();
      } else {
        el  = page.locator(`[data-pdf-rep="${key}"]`).first();
        box = await el.boundingBox();
      }

      if (!box || box.width < 20 || box.height < 20) continue;

      // 滾動到元素位置
      await page.evaluate(
        ({ key }) => {
          const el = document.querySelector(`[data-pdf-rep="${key}"]`);
          if (el) el.scrollIntoView({ block: 'center' });
        },
        { key }
      );
      await sleep(page, isPuppeteer, 400);

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
  const { browser, isPuppeteer } = await launchBrowser();

  try {
    const page = await newPage(browser, isPuppeteer);

    // 1. 導航
    await page.goto(url, {
      waitUntil: isPuppeteer ? 'networkidle2' : 'networkidle',
      timeout: 90000,
    });

    // 2. 緩慢滾動觸發 lazy-load
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
    await sleep(page, isPuppeteer, extraWait);
    await waitNetworkIdle(page, isPuppeteer);

    // 4. 頁面標題（用於檔名）
    const pageTitle = await page.title();

    // 5. 截圖 embed 容器 & iframe
    await screenshotAndReplace(page, isPuppeteer, '.w-embed.w-iframe', 'wembed');
    await screenshotAndReplace(page, isPuppeteer, 'iframe', 'iframe');

    // 6. 取得文章標題（在隱藏 DOM 前）
    const articleTitle = await page.evaluate(() => {
      for (const h1 of document.querySelectorAll('h1')) {
        if (h1.offsetHeight > 0) return h1.innerText.trim().replace(/\s+/g, ' ');
      }
      return document.title.split('|')[0].split('｜')[0].trim();
    });

    // 7. 解析 URL 取類別
    const { vol, category } = getArticleMeta(url);
    const label = vol && category ? `vol.${vol} ｜ ${category}` : category;

    // 8. DOM 清理 + 注入自製標題
    await page.evaluate(
      ({ label, articleTitle, fontScale }) => {
        // A. fixed / sticky 元素全部隱藏
        Array.from(document.querySelectorAll('*')).forEach(el => {
          const pos = window.getComputedStyle(el).position;
          if (pos === 'fixed' || pos === 'sticky')
            el.style.setProperty('display', 'none', 'important');
        });

        // B. header / nav
        document.querySelectorAll('header, nav, [role="banner"], [role="navigation"]')
          .forEach(el => el.style.setProperty('display', 'none', 'important'));

        // C. author-section 之後全部隱藏
        const authorSection = document.querySelector('.author-section');
        if (authorSection) {
          let sib = authorSection.nextElementSibling;
          while (sib) { sib.style.setProperty('display', 'none', 'important'); sib = sib.nextElementSibling; }
        }
        document.querySelectorAll(
          'footer,[class*="footer"],[class*="Footer"],' +
          '.readmore-section,.focus-readmore-section,.focus-readdata-section'
        ).forEach(el => el.style.setProperty('display', 'none', 'important'));

        // D. 隱藏所有原始標題元素
        document.querySelectorAll(
          '.focus-heading-wrapper,.heading-wrapper,h1,' +
          '[class*="group-heading-bg"],[class*="heading1"],.div-block-145'
        ).forEach(el => el.style.setProperty('display', 'none', 'important'));

        // E. 隱藏高度 0 的 cover 佔位
        document.querySelectorAll('.focus-cover-img-wrapper,.cover-img-wrapper')
          .forEach(el => {
            if (el.offsetHeight === 0) el.style.setProperty('display', 'none', 'important');
          });

        // F. 注入自製標題
        const cs = document.querySelector('.content-section');
        if (cs) {
          const wrapper = document.createElement('div');
          wrapper.style.cssText = 'padding:24px 0 20px 0;border-bottom:2px solid #222;margin-bottom:0;';
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

        // G. 縮小 content-section padding
        document.querySelectorAll('.content-section').forEach(el => {
          el.style.setProperty('padding-top',    '16px', 'important');
          el.style.setProperty('padding-bottom', '10px', 'important');
        });

        // H. 強制白底
        document.documentElement.style.setProperty('background-color', 'white', 'important');
        document.body.style.setProperty('background-color', 'white', 'important');

        // I. 字體縮放
        if (Math.abs(fontScale - 1.0) > 0.05) {
          document.querySelectorAll('.content-text,.w-richtext,.content,.author-section')
            .forEach(root => {
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
              let node;
              while ((node = walker.nextNode())) {
                const fs = parseFloat(window.getComputedStyle(node).fontSize);
                if (!isNaN(fs) && fs >= 8)
                  node.style.setProperty('font-size', `${fs * fontScale}px`, 'important');
              }
            });
        }
      },
      { label, articleTitle, fontScale }
    );

    // 9. 列印 CSS
    await page.addStyleTag({
      content: 'img{max-width:100%!important;height:auto!important}a{color:inherit!important;text-decoration:none!important}',
    });

    // 10. 輸出 PDF
    const pdfBytes = await page.pdf({
      format:            'A4',
      margin:            { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' },
      printBackground:   true,
      preferCSSPageSize: false,
    });

    return { pdfBytes, filename: safeFilename(pageTitle) };
  } finally {
    await browser.close();
  }
}

// ── Vercel / Express handler ───────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url, font_scale = 1.2, extra_wait = 10000 } = req.body || {};
  if (!url) return res.status(400).json({ error: '請提供網址' });

  try {
    const { pdfBytes, filename } = await generatePdf(
      String(url).trim(),
      parseFloat(font_scale),
      parseInt(extra_wait)
    );
    const encoded = encodeURIComponent(filename);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="article.pdf"; filename*=UTF-8''${encoded}`);
    res.end(Buffer.from(pdfBytes));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
};
