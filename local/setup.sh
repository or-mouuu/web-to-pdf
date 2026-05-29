#!/bin/bash
# 首次使用執行一次即可
set -e
cd "$(dirname "$0")"

python3 -m venv .venv
source .venv/bin/activate
pip install -q -r requirements.txt
playwright install chromium
echo ""
echo "✓ 安裝完成！執行 ./run.sh 啟動工具"
