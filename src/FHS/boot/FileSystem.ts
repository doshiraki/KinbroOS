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

import { IFileSystem } from '../../dev/types/IFileSystem';
import { FileStream } from './FileStream';
import { EnvKey, IEnvManager } from '../../dev/types/IEnvManager'
import { configure, fs as rawFs, promises as fsPromises, Stats } from '@zenfs/core';
import { WebAccess } from '@zenfs/dom';
import { IFileStream } from '@/dev/types/IFileStream';

/**
 * [Class: FileSystemManager]
 * 仮想ファイルシステム (ZenFS) の管理クラス。
 * OSの個性（具体的なOPFSパスなど）を持たず、
 * 外部から注入されたディレクトリハンドルをマウントする機構を提供する。
 */
export class FileSystemManager implements IFileSystem {
    private env: IEnvManager;

    constructor(env: IEnvManager) {
        this.env = env;
    }
    clone():IFileSystem {
        return new FileSystemManager(this.env.clone());
    }

    public async rmdir(pathTarget: string): Promise<void> {
        const pathResolved = this.resolvePath(pathTarget);
        await fsPromises.rmdir(pathResolved);
    }

    public async lstat(pathTarget: string): Promise<Stats> {
        const pathResolved = this.resolvePath(pathTarget);
        return await fsPromises.lstat(pathResolved);
    }

    public async rename(oldPath: string, newPath: string): Promise<void> {
        const p1 = this.resolvePath(oldPath);
        const p2 = this.resolvePath(newPath);
        await fsPromises.rename(p1, p2);
    }

    public async chmod(pathFile: string, mode: number): Promise<void> {
        const pathResolved = this.resolvePath(pathFile);
        await fsPromises.chmod(pathResolved, mode);
    }

    // 🌟 New: OSが使っている生のZenFSインスタンスを返すバックドア
    // これを git に渡すことで、同じファイルシステムを操作させる
    public getBackend(): any {
        return rawFs;
    }

    /**
     * [Boot: Mount]
     * 外部から提供されたハンドルを使ってファイルシステムを構成する。
     * @param handleRoot ルート(/)としてマウントするディレクトリハンドル
     * @param handleBoot (Optional) /boot としてマウントするディレクトリハンドル
     */
    public async mount(handleRoot: FileSystemDirectoryHandle, handleBoot?: FileSystemDirectoryHandle): Promise<void> {
        try {
            console.log('📂 [FileSystem] Mounting handles provided by Bootloader...');

            const mounts: Record<string, any> = {
                '/': {
                    backend: WebAccess,
                    handle: handleRoot
                }
            };

            if (handleBoot) {
                mounts['/boot'] = {
                    backend: WebAccess,
                    handle: handleBoot
                };
            }

            // ZenFS にマウント構成を適用
            await configure({ mounts });
            
            console.log(`📂 [FileSystem] Mounted. (Boot partition: ${handleBoot ? 'Yes' : 'No'})`);

            // 必須ディレクトリの確保
            await this.ensureDir('/home/geek');
            await this.ensureDir('/usr/bin');
            await this.ensureDir('/tmp');

        } catch (e: any) {
            console.error('📂 [FileSystem] Mount Error:', e);
            throw e;
        }
    }

    // --- 以下、パス操作ロジックは変更なし ---

    public resolvePath(pathInput: string, baseDir: string = this.env.get(EnvKey.CWD)): string {
        if (pathInput.startsWith('/')) return this.normalize(pathInput);
        const pathJoined = baseDir === '/' ? `/${pathInput}` : `${baseDir}/${pathInput}`;
        return this.normalize(pathJoined);
    }

    private normalize(pathRaw: string): string {
        const parts = pathRaw.split('/');
        const stack: string[] = [];
        for (const part of parts) {
            if (part === '' || part === '.') continue;
            if (part === '..') {
                if (stack.length > 0) stack.pop();
            } else {
                stack.push(part);
            }
        }
        return '/' + stack.join('/');
    }

    public getCWD(): string { return this.env.get(EnvKey.CWD); }

    public async changeDir(pathTarget: string): Promise<void> {
        const pathResolved = this.resolvePath(pathTarget);
        const stat = await this.getStat(pathResolved);
        console.log(`cd ${pathResolved}`);
        if (!stat.isDirectory()) throw new Error(`Not a directory: ${pathTarget}`);
        this.env.set(EnvKey.CWD, pathResolved);
    }

    public async readDir(pathTarget: string): Promise<string[]> {
        const pathResolved = this.resolvePath(pathTarget);
        return await fsPromises.readdir(pathResolved);
    }

    public async makeDir(pathTarget: string, isRecursive: boolean = false): Promise<void> {
        const pathResolved = this.resolvePath(pathTarget);
        await fsPromises.mkdir(pathResolved, { recursive: isRecursive });
    }

    public async touchFile(pathFile: string): Promise<void> {
        const pathResolved = this.resolvePath(pathFile);
        await fsPromises.writeFile(pathResolved, '');
    }

    private async ensureDir(pathTarget: string): Promise<void> {
        if (!await this.exists(pathTarget)) {
            await this.makeDir(pathTarget, true);
        }
    }

    /**
     * [SysCall: Unlink]
     * 指定されたパスのファイルを削除する (git diff の後片付けなどで使用)
     */
    public async unlink(pathTarget: string): Promise<void> {
        const pathResolved = this.resolvePath(pathTarget);
        await fsPromises.unlink(pathResolved);
    }

    public async readFile(pathFile: string, type: 'utf8' | 'binary' = 'utf8'): Promise<string | Uint8Array> {
        const pathResolved = this.resolvePath(pathFile);
        const content = await fsPromises.readFile(pathResolved);
        if (type === 'binary') return content as Uint8Array;
        return content.toString();
    }

    public async writeFile(pathFile: string, data: string | Uint8Array): Promise<void> {
        const pathResolved = this.resolvePath(pathFile);
        try {
            if ((await this.getStat(pathResolved)).isFile()) {
                await this.unlink(pathResolved);
            }
        } catch (e) { }
        await fsPromises.writeFile(pathResolved, data);
    }

    public async getStat(pathTarget: string): Promise<Stats> {
        const pathResolved = this.resolvePath(pathTarget);
        return await fsPromises.stat(pathResolved);
    }

    public async exists(pathTarget: string): Promise<boolean> {
        try {
            await this.getStat(pathTarget);
            return true;
        } catch {
            return false;
        }
    }

    public async findRecursive(pathRoot: string): Promise<string[]> {
        const pathStart = this.resolvePath(pathRoot);
        const arrResults: string[] = [];
        const fnScan = async (pathCurrent: string) => {
            const arrItems = await fsPromises.readdir(pathCurrent);
            for (const strItem of arrItems) {
                const pathFull = `${pathCurrent === '/' ? '' : pathCurrent}/${strItem}`;
                arrResults.push(pathFull);
                try {
                    const stat = await fsPromises.stat(pathFull);
                    if (stat.isDirectory()) await fnScan(pathFull);
                } catch { /* ignore */ }
            }
        };
        await fnScan(pathStart);
        return arrResults;
    }

    /**
     * [SysCall: Open]
     * 指定されたパスを開き、FileStreamラッパーを返す。
     * @param pathTarget パス
     * @param flags フラグ
     * @param bufferSize (Optional) ストリームの内部バッファサイズ
     */
    public async open(pathTarget: string, flags: string, bufferSize?: number): Promise<IFileStream> {
        const pathResolved = this.resolvePath(pathTarget);
        try {
            if (flags.includes('w')) {
                try {
                    if ((await this.getStat(pathResolved)).isFile()) {
                        await this.unlink(pathResolved);
                    }
                    //this.touchFile(pathResolved);
                } catch (e) { }
            }
            // 生ハンドルを取得
            const rawHandle = await fsPromises.open(pathResolved, flags);
            let initialCursor = 0;
            if (flags.includes('a')) {
                try {
                    const stat = await rawHandle.stat();
                    initialCursor = stat.size;
                } catch (e) {
                    // 新規作成時などは0のままでOK
                }
            }

            // FileStreamを生成
            const stream = new FileStream(rawHandle, bufferSize);
            stream.setWriteCursor(initialCursor);

            // bufferSize が undefined なら、FileStream 側のデフォルト(64KB)が使われる
            return stream;
        } catch (e: any) {
            throw new Error(`FileSystem: Cannot open '${pathTarget}': ${e.message}`);
        }
    }

}
