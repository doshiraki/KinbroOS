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

import {IFileSystem} from '../../../dev/types/IFileSystem'
// 1. 意味の明確化 (Enum)
export enum TransferMode {
    Put = 'PUT', // Local(Host) -> Remote(ZenFS)
    Get = 'GET'  // Remote(ZenFS) -> Local(Host)
}

export class ZenTransfer {
    private objFs: IFileSystem;

    constructor(objFs: IFileSystem) {
        this.objFs = objFs;
    }

    /**
     * [zenput] Host -> ZenFS
     * ブラウザのファイルピッカーを開き、選択されたファイルをZenFSに保存する
     */
    public async put(): Promise<string> {
        return new Promise((resolve, reject) => {
            // DOM要素を動的生成 (HTMLには追加しない)
            const domInput = document.createElement('input');
            domInput.type = 'file';

            domInput.onchange = async () => {
                const srcFile = domInput.files?.[0];
                if (!srcFile) {
                    resolve('zenput: canceled');
                    return;
                }

                try {
                    // Application Hungarian: buf (Buffer)
                    const bufContent = await srcFile.arrayBuffer();
                    const uint8Data = new Uint8Array(bufContent);
                    
                    // 保存先はカレントディレクトリ + ファイル名
                    const dstPath = `${this.objFs.getCWD()}/${srcFile.name}`;
                    
                    await this.objFs.writeFile(dstPath, uint8Data);
                    resolve(`Saved to: ${dstPath} (${srcFile.size} bytes)`);
                } catch (e: any) {
                    reject(new Error(`zenput failed: ${e.message}`));
                }
            };

            // キャンセル検知は難しいけど、とりあえずクリック発火
            domInput.click();
        });
    }

    /**
     * [zenget] ZenFS -> Host
     * ZenFS上のファイルを読み込み、ブラウザのダウンロード機能を発火させる
     */
    public async get(srcPath: string): Promise<string> {
        if (!srcPath) {
            throw new Error('Usage: zenget <filename>');
        }

        try {
            if (!(await this.objFs.getStat(srcPath)).isFile())
                throw new Error();
        } catch(e) {
            throw new Error(`zenget: ${srcPath}: No such file`);
        }

        try {
            // バイナリとして読み込む
            const dataContent = await this.objFs.readFile(srcPath, 'binary');
            
            // [修正] TypeScriptの型不整合を回避 [cite: 700-701]
            // Uint8Array<ArrayBufferLike> は厳密には BlobPart と互換性がないと判定されるため、
            // any でキャストしてコンパイラを納得させる美学。
            const blobData = new Blob([dataContent as any]);
            
            const urlDownload = URL.createObjectURL(blobData);

            // ファイル名抽出 (簡易版)
            const strFileName = srcPath.split('/').pop() || 'download.bin';

            // ダウンロードリンクを生成してクリック
            const domLink = document.createElement('a');
            domLink.href = urlDownload;
            domLink.download = strFileName;
            document.body.appendChild(domLink); // Firefox対応のため一時的に追加
            domLink.click();
            document.body.removeChild(domLink);
            
            URL.revokeObjectURL(urlDownload); // メモリ解放

            return `Downloaded: ${strFileName}`;
        } catch (e: any) {
            throw new Error(`zenget failed: ${e.message}`);
        }
    }
}