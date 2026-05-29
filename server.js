/**
 * 本機開發伺服器（Node.js + Express）
 * 使用方式：
 *   npm install
 *   npx playwright install chromium
 *   node server.js   （或 npm start）
 * 然後開啟 http://127.0.0.1:5001
 */
'use strict';

const express = require('express');
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// 唯一的 API 路由，與 Vercel 共用同一個 handler
app.post('/api/generate', require('./api/generate'));

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`啟動中，請用瀏覽器開啟 http://127.0.0.1:${PORT}`);
});
