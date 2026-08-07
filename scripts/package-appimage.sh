#!/usr/bin/env bash
#
# package-appimage.sh — 打包 Linux AppImage
#
# 流程：构建全部工作区（protocol → daemon → ui → desktop）
#      → 把 daemon 产物+运行时依赖、UI 产物 stage 到 packages/desktop/staging/
#      → electron-builder 产出 AppImage
#
# 用法: bash scripts/package-appimage.sh   （或直接 ./scripts/package-appimage.sh）
#
set -euo pipefail

# 定位仓库根目录（无论从哪调用，都回到脚本所在仓库）
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
desktop_dir="$repo_root/packages/desktop"
electron_builder="$repo_root/node_modules/.bin/electron-builder"

cd "$repo_root"

echo "==> [1/3] 构建全部工作区（protocol / daemon / ui / desktop）"
npm run build

echo "==> [2/3] stage daemon + UI 产物到 packages/desktop/staging/"
npm run stage -w @agent-console/desktop

echo "==> [3/3] electron-builder 打包 AppImage (linux x64)"
if [[ ! -x "$electron_builder" ]]; then
  echo "错误: 找不到 electron-builder: $electron_builder" >&2
  echo "      请先 npm install" >&2
  exit 1
fi

# electron-builder 以 desktop 包目录为项目根（读取其 electron-builder.yml + package.json）
"$electron_builder" --projectDir "$desktop_dir" --linux AppImage --x64 --config.npmRebuild=false

echo "==> 完成"
ls -lh "$desktop_dir"/dist-app/*.AppImage
