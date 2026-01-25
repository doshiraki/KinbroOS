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

import { IFileSystem } from '@/dev/types/IFileSystem';
export class LinkerDetective {
    private static routerUrl:string|null = null;
    private static mapping: Record<string, {
        "referenceCount": number,
        "blobURL": string,
    }>;
    public static init() {
        if (LinkerDetective.routerUrl != null)
            return;
        (window as any).loadKinbroModule = LinkerDetective.load;
        LinkerDetective.mapping = {};
        const blob = new Blob(
            ["export default await (async() => await window.loadKinbroModule(import.meta.url))()"],
            { type: 'application/javascript' }
        );
        LinkerDetective.routerUrl = URL.createObjectURL(blob);
        console.log(`[Kernel] Router ready at: ${this.routerUrl}`);
    }
    public static getBlobUrl(path: string): string|null {
        const rec = LinkerDetective.mapping[path];
        return rec?rec.blobURL:null;
    }
    public static async load(argUrl:string) {
        const url = new URL(argUrl);

        const path = decodeURIComponent(url.hash.replace('#path=', ''));
        
        const blobUrl = LinkerDetective.getBlobUrl(path);
        if (blobUrl == null) throw new Error("[Router] 404: " + argUrl);
        
        // 実体をロードして返す
        return await import(/* @vite-ignore */blobUrl);
    }
    public static async sourceTransform(fs:IFileSystem, pathEntry:string):Promise<Set<string>> {
        const setProcessed = new Set<string>();

        // 内部関数: 再帰的にファイルを読み込み、importを書き換える
        const processFile = async (pathCurrent: string) => {
            if (setProcessed.has(pathCurrent)) return;
            setProcessed.add(pathCurrent);
            console.log(pathCurrent);

            // ファイル読み込み (テキストとして取得)
            // ※ FileSystem.ts の readFile が string を返すと仮定
            //   もし Uint8Array なら TextDecoder で変換が必要だよ
            let srcContent = await fs.readFile(pathCurrent);
            if (typeof srcContent !== 'string') {
                console.log("array → string");
                srcContent = new TextDecoder().decode(srcContent);
            }

            const dirCurrent = pathCurrent.substring(0, pathCurrent.lastIndexOf('/'));
        
            // 🌟 1. Regexの改善
            // "from" の前は「' " ;」以外、パス部分は「' " ;」以外とすることで
            // バックトラックを減らし、かつセミコロン等の境界を厳密にする
            const regexImport = /import\s*(?:([^'";]*?)\s*from\s*)?['"]((?:\/|\.\.?\/)[^'";]+)['"]?/g;

            // 🌟 2. StringBuilderパターン (Array push -> join)
            const parts: string[] = [];
            let cursor = 0;
        
            // 依存関係を再帰的に解決するためのリスト
            const dependencies: string[] = [];

            for (const match of srcContent.matchAll(regexImport)) {
                const [fullMatch, importClause, relPath] = match;
                const matchIndex = match.index!;
            
                console.log("full:" + fullMatch);
                // マッチした箇所の「手前」にあるコードをそのままpush
                parts.push(srcContent.slice(cursor, matchIndex));
            
                // パス解決
                const absPath = fs.resolvePath(relPath, dirCurrent);
                dependencies.push(absPath); // 後で再帰処理するためにメモ

                // 書き換えコード生成
                const routerPath = `${LinkerDetective.routerUrl}#path=${encodeURIComponent(absPath)}`;
                const routerExpr = `(await import('${routerPath}')).default`;

                let newCode = '';
                if (importClause) {
                    // import { a } from ... -> const { a } = ...
                    newCode = `const ${importClause.replace(/\s+as\s+/g, ': ')} = ${routerExpr};`;
                } else {
                    // import ... -> await import(...)
                    newCode = `await import('${routerPath}');`;
                }

                parts.push(newCode);
            
                // カーソルを進める
                cursor = matchIndex + fullMatch.length;
            }

            // 最後のマッチ以降の残りコードをpush
            parts.push(srcContent.slice(cursor));

            // 結合！ (これが一番速い)
            const srcModified = parts.join('');

            // 依存ファイルの再帰読み込み (文字列操作が終わってからやる)
            // ※並列実行(Promise.all)もできるけど、順序依存がある場合は直列で。今回は直列で安全に。
            for (const depPath of dependencies) {
                if (await fs.exists(depPath)) {
                    await processFile(depPath);
                }
            }

            // Blob化
            const blob = new Blob([srcModified], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            let cnt = 0;
            if (LinkerDetective.mapping[pathCurrent]) {
                const {blobURL, referenceCount } = LinkerDetective.mapping[pathCurrent];
                URL.revokeObjectURL(blobURL);
                cnt = referenceCount;
            }

            LinkerDetective.mapping[pathCurrent] = { blobURL: blobUrl, referenceCount: cnt };
 
        }
        // 1. 依存関係ツリーの構築開始
        await processFile(fs.resolvePath(pathEntry));
        LinkerDetective.addReferences(setProcessed);
        return setProcessed;
    }
    private static changeRef(paths: Set<string>, incremant: number) {
        const mapping = LinkerDetective.mapping;
        for (let path of paths) {
            mapping[path].referenceCount += incremant;

            // ✨ 追加: 参照カウントが0以下になったら物理削除 (GC)
            if (mapping[path].referenceCount <= 0) {
                console.log(`[Linker] GC: Revoking ${path}`);
                
                // 1. ブラウザのメモリからBlobを解放
                URL.revokeObjectURL(mapping[path].blobURL);
                
                // 2. マップからエントリを削除
                delete mapping[path];
            }
        }
    }
    public static addReferences(paths: Set<string>) {
        LinkerDetective.changeRef(paths, 1);
    }
    public static removeReferences(paths: Set<string>) {
        LinkerDetective.changeRef(paths, -1);
    }
}

