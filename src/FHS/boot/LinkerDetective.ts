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
        
        // Load the entity and return it
        return await import(/* @vite-ignore */blobUrl);
    }
    public static async sourceTransform(fs:IFileSystem, pathEntry:string):Promise<Set<string>> {
        const setProcessed = new Set<string>();

        // Internal function: Recursively read files and rewrite imports
        const processFile = async (pathCurrent: string) => {
            if (setProcessed.has(pathCurrent)) return;
            setProcessed.add(pathCurrent);
            console.log(pathCurrent);

            // ファイル読み込み (テキストとして取得)
            // * Assumes FileSystem.ts readFile returns a string
            //   もし Uint8Array なら TextDecoder で変換が必要だよ
            let srcContent = await fs.readFile(pathCurrent);
            if (typeof srcContent !== 'string') {
                console.log("array → string");
                srcContent = new TextDecoder().decode(srcContent);
            }

            const dirCurrent = pathCurrent.substring(0, pathCurrent.lastIndexOf('/'));
        
            // [1] Regex improvement
            // By excluding quotes/semicolons before "from" and in path parts,
            // backtracking is reduced and boundaries like semicolons are strictly enforced.
            const regexImport = /import\s*(?:([^'";]*?)\s*from\s*)?['"]((?:\/|\.\.?\/)[^'";]+)['"]?/g;

            // [2] StringBuilder pattern (Array push -> join)
            const parts: string[] = [];
            let cursor = 0;
        
            // List for recursively resolving dependencies
            const dependencies: string[] = [];

            for (const match of srcContent.matchAll(regexImport)) {
                const [fullMatch, importClause, relPath] = match;
                const matchIndex = match.index!;
            
                console.log("full:" + fullMatch);
                // Push code "before" the match as is
                parts.push(srcContent.slice(cursor, matchIndex));
            
                // Path resolution
                const absPath = fs.resolvePath(relPath, dirCurrent);
                dependencies.push(absPath); // 後で再帰処理するためにメモ

                // Generate rewritten code
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
            
                // Advance cursor
                cursor = matchIndex + fullMatch.length;
            }

            // Push remaining code after the last match
            parts.push(srcContent.slice(cursor));

            // Join! (This is the fastest method)
            const srcModified = parts.join('');

            // Recursive loading of dependencies (after string operations)
            // * Parallel (Promise.all) is possible, but we use sequential execution for safety.
            for (const depPath of dependencies) {
                if (await fs.exists(depPath)) {
                    await processFile(depPath);
                }
            }

            // Convert to Blob URL
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
        // 1. Start building dependency tree
        await processFile(fs.resolvePath(pathEntry));
        LinkerDetective.addReferences(setProcessed);
        return setProcessed;
    }
    private static changeRef(paths: Set<string>, incremant: number) {
        const mapping = LinkerDetective.mapping;
        for (let path of paths) {
            mapping[path].referenceCount += incremant;

            // [Added]: Physical deletion (GC) when reference count reaches 0 or less
            if (mapping[path].referenceCount <= 0) {
                console.log(`[Linker] GC: Revoking ${path}`);
                
                // 1. Release Blob from browser memory
                URL.revokeObjectURL(mapping[path].blobURL);
                
                // 2. Remove entry from map
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

