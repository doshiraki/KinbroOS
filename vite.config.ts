/*
 * Copyright 2026 @doshiraki
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// src/vite.config.ts
import { defineConfig } from 'vite';
import { resolve, relative, join } from 'path';
import { readdirSync, statSync } from 'fs';
import * as tar from 'tar'; // ✨ 追加
// ... (getFhsEntries関数は前回と同じなので省略) ...
function getFhsEntries(dir: string, baseDir: string = dir): Record<string, string> {
  const entries: Record<string, string> = {};
  const files = readdirSync(dir);
  for (const file of files) {
    const fullPath = join(dir, file);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      Object.assign(entries, getFhsEntries(fullPath, baseDir));
    } else if (stat.isFile() && /\.(ts|css)$/.test(file)) {
      const relativePath = relative(baseDir, fullPath);
      const entryKey = relativePath.replace(/\.[^/.]+$/, "");
      entries[entryKey] = fullPath;
    }
  }
  return entries;
}

export default defineConfig(({ mode }) => {
  // ■ 1. Kernel Build
  if (mode === 'kernel') {
    return {
      define: { 'process.env': {}, 'process.platform': '"browser"', 'process': {} },
      build: {
        target: 'esnext',
        minify: false,
        outDir: 'dist/kernel',
        emptyOutDir: true,
        lib: {
          entry: resolve(__dirname, 'src/FHS/boot/vmKinbroOS.ts'),
          name: 'vmKinbroOS',
          fileName: () => 'vmKinbroOS.js',
          formats: ['es']
        },
        rollupOptions: {
          external: []
        }
      }
    };
  }

  // ■ 2. Userland Build
  let inputOptions = ['/usr']
    .map((p) => getFhsEntries(resolve(__dirname, 'src/FHS' + p), resolve(__dirname, 'src/FHS')))
    .reduce((pre, cur, n, arr) => ({ ...pre, ...cur }), {} as Record<string, string>);

  console.log('🏗️  Auto-detected Userland Entries:', Object.keys(inputOptions));

  return {
    define: { 'process.env': {}, 'process.platform': '"browser"', 'process': {} },
    // ✨ 追加: Nodeモジュールのポリフィル/モック設定
    resolve: {
      alias: {
        fs: 'memfs', // もしくは false にして無視させる
        path: 'path-browserify', // path操作が必要ならこれを入れると安全
      }
    },
    build: {
      target: 'esnext',
      minify: false,
      outDir: 'dist/userland',
      emptyOutDir: true,
      rollupOptions: {
        input: inputOptions,
        preserveEntrySignatures: 'strict',
        output: {
          format: 'es',
          entryFileNames: '[name].js',
          chunkFileNames: 'usr/lib/chunk/[name]-[hash].js',
          assetFileNames: '[name].[ext]',
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.endsWith('.css')) return 'usr/include/vendor';
              return 'vendor';
            }
          }
        },
        // ブラウザ互換のため fs, path を外部化せず、aliasで解決させる
        external: []
      },
      // もし minify するとしても、関数名だけは残す設定 (TerserOptions)
      terserOptions: {
        keep_classnames: true,
        keep_fnames: true,
      },
    },
    // ✨✨ ここが魔法のスパイス！ ✨✨
    plugins: [
      {
        name: 'make-rootfs-tarball',
        closeBundle: {
          sequential: true, // 順序を守る
          order: 'post',    // ビルド後に実行
          async handler() {
            console.log('📦 [Vite] Packing rootfs.tar.gz ...');
            
            try {
              // dist/userland の中身を rootfs.tar.gz に固める
              await tar.c(
                {
                  gzip: true,        // .gz圧縮有効
                  file: 'dist/rootfs.tar.gz', // 出力ファイル名 (プロジェクトルート)
                  cwd: 'dist/userland',  // ⚠️ ここが重要！ dist/userland をルートにする
                  portable: true,    // Windows等で作っても権限情報を標準化する
                },
                ['usr'] // カレントディレクトリ以下すべてを対象
              );
              console.log('✅ [Vite] rootfs.tar.gz created successfully!');
            } catch (e) {
              console.error('❌ [Vite] Failed to pack rootfs:', e);
            }
          }
        }
      }
    ]
  };
});
