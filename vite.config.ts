import path from "path"
import { defineConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import legacy from "@vitejs/plugin-legacy"
import { dynamicBase } from "vite-plugin-dynamic-base"
import { viteStaticCopy } from "vite-plugin-static-copy"
import type { Plugin } from "vite"

// vite-plugin-dynamic-base converts data-src → src in its generateBundle hook,
// but @vitejs/plugin-legacy expects data-src on vite-legacy-polyfill so the
// legacy detection script can read it.  This plugin runs its generateBundle
// after dynamicBase (enforce:post, registered last) and restores data-src.
function fixLegacyPolyfillDataSrc(): Plugin {
  return {
    name: "fix-legacy-polyfill-data-src",
    enforce: "post",
    apply: "build",
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (
          chunk.type === "asset" &&
          chunk.fileName.endsWith(".html") &&
          typeof chunk.source === "string"
        ) {
          chunk.source = chunk.source.replace(
            /("id"\s*:\s*"vite-legacy-polyfill"[^}]*?)"src"\s*:/,
            (match) => match.replace(/"src"\s*:/, '"data-src":'),
          )
        }
      }
    },
  }
}

const DEV_BACKEND = process.env.DEV_PROXY_TARGET || "http://localhost:5248"

// 除 /api 外，raw 文件相关路由也必须代理到后端。
// 否则 vite 的 SPA fallback 会把这些请求当成前端路由，返回 200 + index.html，
// 于是 Markdown / 文本 / 图片预览拿到的「文件内容」其实是首页 HTML。
const RAW_FILE_ROUTES = [
  "/d/", // 直接下载
  "/p/", // 代理下载
  "/ad/", // 压缩包内直接下载
  "/ap/", // 压缩包内代理下载
  "/ae/", // 压缩包内文件抽取
  "/sd/", // 分享下载
  "/sad/", // 分享压缩包内文件抽取
  "/dav/", // WebDAV
  "/i/", // plist
  "/tc/", // 转码播放 m3u8 / 切片
]

export default defineConfig({
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "src"),
      // "@solidjs/router": path.resolve(__dirname, "solid-router/src"),
      "solid-icons": path.resolve(__dirname, "node_modules/solid-icons"),
    },
  },
  plugins: [
    solidPlugin(),
    legacy({
      targets: ["defaults"],
    }),
    dynamicBase({
      // dynamic public path var string, default window.__dynamic_base__
      publicPath: "window.__dynamic_base__",
      // dynamic load resources on index.html, default false. maybe change default true
      transformIndexHtml: true,
      transformIndexHtmlConfig: {
        insertBodyAfter: true,
      },
    }),
    process.env.VITE_LITE !== "true"
      ? viteStaticCopy({
          targets: [
            {
              src: "node_modules/monaco-editor/min/*",
              dest: "static/monaco-editor",
            },
            {
              src: "node_modules/katex/dist/katex.min.css",
              dest: "static/katex",
            },
            {
              src: "node_modules/katex/dist/fonts/*",
              dest: "static/katex/fonts",
            },
            {
              src: "node_modules/mermaid/dist/mermaid.min.js",
              dest: "static/mermaid",
            },
            {
              src: "node_modules/libheif-js/libheif-wasm/libheif.{js,wasm}",
              dest: "static/libheif",
            },
            {
              src: "node_modules/@jellyfin/libass-wasm/dist/js/subtitles-octopus-worker.{js,wasm}",
              dest: "static/libass-wasm",
            },
            {
              src: "src/components/artplayer-plugin-ass/fonts/*",
              dest: "static/fonts",
            },
          ],
        })
      : null,
    fixLegacyPolyfillDataSrc(),
  ],
  base: process.env.NODE_ENV === "production" ? "/__dynamic_base__/" : "/",
  // base: "/",
  build: {
    // target: "es2015", //next
    // polyfillDynamicImport: false,
  },
  // experimental: {
  //   renderBuiltUrl: (filename, { type, hostId, hostType }) => {
  //     if (type === "asset") {
  //       return { runtime: `window.OPENLIST_CONFIG.cdn/${filename}` };
  //     }
  //     return { relative: true };
  //   },
  // },
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": {
        // DEV_PROXY_TARGET 允许 dev 时对接不同后端：
        //   Go 版 OpenList 后端   -> 默认 http://localhost:5246
        //   OpenListNext(TS) 后端 -> DEV_PROXY_TARGET=http://localhost:8787
        target: DEV_BACKEND,
        changeOrigin: true,
        // rewrite: (path) => path.replace(/^\/api/, ""),
      },
      ...Object.fromEntries(
        RAW_FILE_ROUTES.map((route) => [
          route,
          { target: DEV_BACKEND, changeOrigin: true },
        ]),
      ),
      // 后端 --debug 时的调试接口（pprof 等），方便在 5173 上直接访问 /debug/pprof/
      "/debug/": { target: DEV_BACKEND, changeOrigin: true },
    },
  },
})
