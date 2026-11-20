// Vite config for the static online demo (README.md "Build layout" and "Plugin demo-overrides").
// Run from web/:  npm run build:demo  |  npm run dev:demo  (port 5180, no /api proxy: nothing reaches a backend).
// It builds the real web/src UI with the mock transport from web/demo/main.ts. Product files are never edited:
// two modules are swapped at resolve time and a few product literals are rewritten at transform time.
// This file imports no node: modules. (typecheck:demo still needs the root install: web/src/lib/types.ts re-exports types
// from src/core, which import zod and node: modules.)
import { defineConfig, normalizePath, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Directory of this file with forward slashes and no trailing slash (Vite keeps the original import.meta.url). */
const demoRoot = decodeURIComponent(new URL('.', import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '').replace(/\/$/, '');
const webRoot = demoRoot.replace(/\/demo$/, '');

/** Comparable form of an absolute path: forward slashes, no query, lower case on Windows drive paths. */
function pathKey(id: string): string {
  const path = normalizePath(id.split('?')[0]);
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path;
}

/**
 * Exact string replacements in product modules, applied before any other transform. Every entry must match at least
 * once in its file, and every entry must have been applied by the end of a build; otherwise the build fails, so
 * product drift fails loudly instead of leaking text into the demo.
 */
const REPLACEMENTS: ReadonlyArray<{ file: string; from: string; to: string }> = [
  { file: 'src/pages/chat/Welcome.tsx', from: '演示一个完整项目 · 会议室预约工具 · 4 分钟 →', to: '播放完整演示 · 会议室预约工具 · 约 3 分钟 →' },
  { file: 'src/pages/chat/ChatPage.tsx', from: 'RoomDesk 会议室预约工具 · 交付成品', to: '交付成品' },
  { file: 'src/pages/chat/thread/FixedDemoBar.tsx', from: '会议室预约工具演示 · 预设流程 · 不调用模型', to: '项目演示 · 预设流程 · 不调用模型' },
  // Honesty (README.md "Hard rules"), added at integration: the composer's cost confirmation would otherwise say
  // that sending calls a model and spends quota, next to the pill that says no model is called. The checkbox and its
  // gating stay; only the wording says what happens in the installed product and what happens here.
  { file: 'src/pages/chat/composer/Composer.tsx', from: '我了解，发送会调用模型并消耗额度', to: '我了解：正式版发送会消耗模型额度，在线演示不会' },
  { file: 'src/pages/chat/composer/Composer.tsx', from: '已确认本会话会消耗模型额度', to: '已确认 · 在线演示不调用模型，不消耗额度' },
];

/** Product module (resolved path) → demo replacement. */
const SWAPS: ReadonlyArray<{ product: string; demo: string }> = [
  { product: `${webRoot}/src/lib/fixed-demo.ts`, demo: `${demoRoot}/overrides/fixed-demo.ts` },
  { product: `${webRoot}/src/pages/chat/FixedDemoProduct.tsx`, demo: `${demoRoot}/overrides/FixedDemoProduct.tsx` },
];

/** Only import specifiers whose last segment is one of the swapped module names are resolved twice. */
const SWAP_SPECIFIER = /(?:^|\/)(?:fixed-demo|FixedDemoProduct)(?:\.tsx?)?$/;

function demoOverrides(): Plugin {
  const swapByKey = new Map(SWAPS.map(swap => [pathKey(swap.product), swap.demo]));
  const replacementsByKey = new Map<string, Array<{ index: number; from: string; to: string }>>();
  REPLACEMENTS.forEach((item, index) => {
    const key = pathKey(`${webRoot}/${item.file}`);
    replacementsByKey.set(key, [...(replacementsByKey.get(key) ?? []), { index, from: item.from, to: item.to }]);
  });
  const swapped = new Set<string>();
  const replaced = new Set<number>();
  let building = false;
  return {
    name: 'demo-overrides',
    enforce: 'pre',
    configResolved(config) {
      building = config.command === 'build';
    },
    async resolveId(source, importer, options) {
      if (!importer || !SWAP_SPECIFIER.test(source)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.external) return null;
      const target = swapByKey.get(pathKey(resolved.id));
      if (!target) return null;
      swapped.add(target);
      return target;
    },
    transform(code, id) {
      const pairs = replacementsByKey.get(pathKey(id));
      if (!pairs) return null;
      let out = code;
      for (const pair of pairs) {
        if (!out.includes(pair.from)) {
          throw new Error(`[demo-overrides] replacement not found in ${id}: ${JSON.stringify(pair.from)}. The product text changed; update REPLACEMENTS in web/demo/vite.config.ts.`);
        }
        out = out.split(pair.from).join(pair.to);
        replaced.add(pair.index);
      }
      return { code: out, map: null };
    },
    generateBundle() {
      if (!building) return;
      const missingSwaps = SWAPS.filter(swap => !swapped.has(swap.demo)).map(swap => swap.product);
      if (missingSwaps.length) this.error(`[demo-overrides] module swap never applied: ${missingSwaps.join(', ')}`);
      const missingReplacements = REPLACEMENTS.filter((_, index) => !replaced.has(index)).map(item => `${item.file}: ${item.from}`);
      if (missingReplacements.length) this.error(`[demo-overrides] replacement never applied: ${missingReplacements.join(' | ')}`);
    },
  };
}

export default defineConfig({
  root: demoRoot,
  base: './',
  publicDir: `${demoRoot}/public`,
  // A cache separate from the product's node_modules/.vite, so the demo dev server never disturbs the product's.
  cacheDir: `${webRoot}/node_modules/.vite-demo`,
  plugins: [demoOverrides(), react()],
  define: { __DEMO__: 'true' },
  server: { port: 5180, strictPort: true, fs: { allow: ['..'] } },
  build: {
    outDir: '../dist-demo',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
    sourcemap: false,
  },
});
