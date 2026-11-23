#!/bin/sh
# 試聴ページを作って GitHub Pages（gh-pages ブランチ）に置く。作業中のブランチは切り替えない
set -eu
cd "$(dirname "$0")"
npm test
npm run build
url=$(git remote get-url origin)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -R dist/. "$tmp/"
touch "$tmp/.nojekyll"
cd "$tmp"
git init -q
git checkout -q -b gh-pages
git add -A
git -c user.name="$(git -C "$OLDPWD" config user.name)" -c user.email="$(git -C "$OLDPWD" config user.email)" commit -q -m "試聴ページを公開"
git push -q -f "$url" gh-pages
echo "公開しました：https://takumawatanabe3110-tech.github.io/podcast-editor/ （反映まで1〜2分）"
