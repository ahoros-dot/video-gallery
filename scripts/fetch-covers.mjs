/**
 * data/videos.json を読み、Instagram のカバー画像を covers/<shortcode>.jpg に取り込む。
 *
 * ブラウザから直接 Instagram の画像を読むことはできない。CDN が
 * cross-origin-resource-policy: same-origin を返すため、他オリジンの <img> は必ず失敗する。
 * サーバー側（GitHub Actions）にはこの制約が効かないので、ここで取得して自分のリポジトリに置く。
 *
 * 取得済みのファイルは再取得しない。削除すれば次回の実行で取り直す。
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SHORTCODE = /instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function main() {
  let raw;
  try {
    raw = await readFile('data/videos.json', 'utf8');
  } catch {
    console.log('data/videos.json がないので何もしません');
    return;
  }

  const data = JSON.parse(raw);
  const items = Array.isArray(data) ? data : (data.items ?? []);

  // 同じ投稿が複数登録されていても 1 回だけ取得する
  const codes = [...new Set(
    items.map((it) => String(it.url || '').match(SHORTCODE)?.[1]).filter(Boolean),
  )];

  if (codes.length === 0) {
    console.log('Instagram の項目はありません');
    return;
  }
  await mkdir('covers', { recursive: true });

  let saved = 0;
  let failed = 0;

  for (const code of codes) {
    const out = `covers/${code}.jpg`;
    if (await exists(out)) {
      console.log(`skip   ${code}（取得済み）`);
      continue;
    }

    // reel/tv でも必ず /p/ を使う。/reel/<code>/media/ は 500 を返す。
    const url = `https://www.instagram.com/p/${code}/media/?size=l`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      const type = res.headers.get('content-type') || '';

      if (!res.ok) {
        console.log(`失敗   ${code}（HTTP ${res.status}）`);
        failed += 1;
      } else if (!type.startsWith('image/')) {
        // 非公開・削除済みだとログインページの HTML が返ってくる
        console.log(`失敗   ${code}（画像ではなく ${type}。非公開か削除済みの可能性）`);
        failed += 1;
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        await writeFile(out, buf);
        console.log(`保存   ${out}（${(buf.length / 1024).toFixed(0)}KB）`);
        saved += 1;
      }
    } catch (e) {
      console.log(`失敗   ${code}（${e.message}）`);
      failed += 1;
    }

    // 連続アクセスを避ける
    await new Promise((r) => setTimeout(r, 1200));
  }

  console.log(`\n合計: 保存 ${saved}件 / 失敗 ${failed}件 / 対象 ${codes.length}件`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
