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

// src/FHS/usr/bin/cp.ts

import { SystemAPI } from '../../../dev/types/SystemAPI';
import { IProcess } from '../../../dev/types/IProcess';
import { CommandParser } from '../lib/CommandParser';
import { BinaryReader, BinaryWriter } from '../lib/StreamUtils';
import { Stats } from '@zenfs/core';

/**
 * [Command: cp]
 * ファイルやディレクトリをコピーする。
 * GNU coreutils 準拠 (Recursive, Backup, Update, Attributes-only supported)
 * IFileStream の attach/read API を使用したメモリ効率の良い実装。
 */
export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const parser = new CommandParser(args, {
        name: 'cp',
        usage: '[OPTION]... [-T] SOURCE DEST\n  or:  cp [OPTION]... SOURCE... DIRECTORY\n  or:  cp [OPTION]... -t DIRECTORY SOURCE...',
        desc: 'Copy SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.',
        options: [
            { short: 'a', long: 'archive', desc: 'same as -dR --preserve=all' },
            { long: 'attributes-only', desc: 'don\'t copy the file data, just the attributes' },
            { long: 'backup', desc: 'make a backup of each existing destination file' },
            { short: 'b', desc: 'like --backup but does not accept an argument' },
            { short: 'd', desc: 'same as --no-dereference --preserve=links' },
            { short: 'f', long: 'force', desc: 'if an existing destination file cannot be opened, remove it and try again' },
            { short: 'i', long: 'interactive', desc: 'prompt before overwrite' },
            { short: 'H', desc: 'follow command-line symbolic links in SOURCE' },
            { short: 'l', long: 'link', desc: 'hard link files instead of copying' },
            { short: 'L', long: 'dereference', desc: 'always follow symbolic links in SOURCE' },
            { short: 'n', long: 'no-clobber', desc: 'do not overwrite an existing file' },
            { short: 'P', long: 'no-dereference', desc: 'never follow symbolic links in SOURCE' },
            { short: 'p', desc: 'same as --preserve=mode,ownership,timestamps' },
            { long: 'preserve', desc: 'preserve the specified attributes' },
            { long: 'parents', desc: 'use full source file name under DIRECTORY' },
            { short: 'R', desc: 'copy directories recursively' },
            { short: 'r', long: 'recursive', desc: 'copy directories recursively' },
            { long: 'remove-destination', desc: 'remove each existing destination file before attempting to open it' },
            { long: 'strip-trailing-slashes', desc: 'remove any trailing slashes from each SOURCE argument' },
            { short: 's', long: 'symbolic-link', desc: 'make symbolic links instead of copying' },
            { short: 'S', long: 'suffix', desc: 'override the usual backup suffix', hasArg: true },
            { short: 't', long: 'target-directory', desc: 'copy all SOURCE arguments into DIRECTORY', hasArg: true },
            { short: 'T', long: 'no-target-directory', desc: 'treat DEST as a normal file' },
            { short: 'u', long: 'update', desc: 'copy only when the SOURCE file is newer than the destination file' },
            { short: 'v', long: 'verbose', desc: 'explain what is being done' },
            { long: 'help', desc: 'display this help and exit' }
        ]
    });

    const writer = new BinaryWriter(proc.stdout!.getByteWriter());
    const errWriter = new BinaryWriter(proc.stderr!.getByteWriter());

    // ヘルプ表示
    if (parser.isHelpRequested) {
        await writer.writeString(parser.getHelp() + '\n');
        writer.releaseLock(); errWriter.releaseLock();
        return 0;
    }
    // 引数バリデーション
    if (parser.validate()) {
        await errWriter.writeString(parser.validate() + '\n');
        writer.releaseLock(); errWriter.releaseLock();
        return 1;
    }

    // --- 1. オプション解析と優先順位解決 ---

    // Archive Mode (-a): -dR --preserve=all 相当
    const isArchive = parser.has('a', 'archive');
    
    // Recursive
    const isRecursive = isArchive || parser.has('r', 'recursive') || parser.has('R');

    // Link Mode (Not supported in OPFS, but flag parsing logic kept)
    const makeSymlink = parser.has('s', 'symbolic-link');
    const makeHardlink = parser.has('l', 'link');

    // Overwrite Control (-n, -i, -f)
    // Last Wins Strategy
    let modeOverwrite = 'force'; // default
    
    // 引数を逆順走査して決定する
    for (let i = args.length - 1; i >= 0; i--) {
        const arg = args[i];
        if (arg === '-n' || arg === '--no-clobber') { modeOverwrite = 'no-clobber'; break; }
        if (arg === '-i' || arg === '--interactive') { modeOverwrite = 'interactive'; break; }
        if (arg === '-f' || arg === '--force') { modeOverwrite = 'force'; break; }
    }

    const isUpdate = parser.has('u', 'update');
    const isVerbose = parser.has('v', 'verbose');
    const isAttributesOnly = parser.has(undefined, 'attributes-only');
    const stripSlashes = parser.has(undefined, 'strip-trailing-slashes');
    const preserve = isArchive || parser.has('p') || parser.has(undefined, 'preserve');
    const removeDest = parser.has(undefined, 'remove-destination');

    // Backup Settings
    const isBackup = parser.has('b') || parser.has(undefined, 'backup'); 
    const backupSuffix = (parser.get('suffix') as string) || '~'; 

    // --- 2. ソースとターゲットの決定 ---
    let arrSources: string[] = [];
    let strDest: string | null = null;
    let isTargetDirectoryMode = false;

    if (parser.has('t', 'target-directory')) {
        strDest = parser.get('target-directory') as string;
        arrSources = parser.args;
        isTargetDirectoryMode = true;
    } else {
        if (parser.args.length < 2) {
            await errWriter.writeString("cp: missing file operand\n");
            writer.releaseLock(); errWriter.releaseLock();
            return 1;
        }
        strDest = parser.args[parser.args.length - 1];
        arrSources = parser.args.slice(0, -1);
    }

    const noTargetDir = parser.has('T', 'no-target-directory');

    if (stripSlashes) {
        arrSources = arrSources.map(s => s.endsWith('/') && s !== '/' ? s.slice(0, -1) : s);
    }

    // --- 3. コピー処理の実行 ---
    let exitCode = 0;

    try {
        // ターゲットがディレクトリかどうか
        let destIsDir = false;
        if (!noTargetDir && strDest) {
            try {
                const stat = await proc.fs.getStat(strDest);
                if (stat.isDirectory()) destIsDir = true;
            } catch {}
        }

        // 複数ソース -> ディレクトリ必須
        if (arrSources.length > 1 && !destIsDir && !isTargetDirectoryMode) {
            await errWriter.writeString(`cp: target '${strDest}' is not a directory\n`);
            writer.releaseLock(); errWriter.releaseLock();
            return 1;
        }

        // コピーロジック (再帰対応)
        const processCopyItem = async (srcPath: string, destPath: string) => {
            try {
                // ソースの確認
                const statSrc = await proc.fs.getStat(srcPath);

                if (statSrc.isDirectory()) {
                    // ディレクトリのコピー
                    if (!isRecursive) {
                        await errWriter.writeString(`cp: -r not specified; omitting directory '${srcPath}'\n`);
                        exitCode = 1;
                        return;
                    }
                    
                    // 宛先ディレクトリ作成
                    if (!await proc.fs.exists(destPath)) {
                        await proc.fs.makeDir(destPath);
                        if (isVerbose) await writer.writeString(`created directory '${destPath}'\n`);
                    }

                    // 中身を再帰的にコピー
                    const items = await proc.fs.readDir(srcPath);
                    for (const item of items) {
                        await processCopyItem(`${srcPath}/${item}`, `${destPath}/${item}`);
                    }

                    // ディレクトリ自体の属性保持 (-p/-a)
                    if (preserve) {
                         // IFileSystemにchmodがあれば実行 (IFileSystemにはchmodが存在する)
                         await proc.fs.chmod(destPath, statSrc.mode);
                    }
                } else {
                    // ファイルのコピー
                    await copyFile(srcPath, destPath, statSrc);
                }
            } catch (e: any) {
                await errWriter.writeString(`cp: cannot stat '${srcPath}': ${e.message}\n`);
                exitCode = 1;
            }
        };

        // ファイル単体のコピーロジック
        const copyFile = async (src: string, dest: string, statSrc: Stats) => {
            // [Link Mode] シンボリックリンク・ハードリンク
            // OPFSでは未サポートのため、エラーまたはスキップ
            if (makeSymlink || makeHardlink) {
                 await errWriter.writeString(`cp: links are not supported on this file system\n`);
                 exitCode = 1;
                 return;
            }

            // [Overwrite Logic] 宛先が存在する場合
            if (await proc.fs.exists(dest)) {
                // -n: No Clobber
                if (modeOverwrite === 'no-clobber') return;

                const statDest = await proc.fs.getStat(dest);

                // -u: Update (SourceがDestより新しい場合のみコピー)
                if (isUpdate && statSrc.mtimeMs <= statDest.mtimeMs) return;

                // -i: Interactive
                if (modeOverwrite === 'interactive') {
                    await errWriter.writeString(`cp: overwrite '${dest}'? (y/n) `);
                    if (!await readConfirmation(proc)) return;
                }

                // --remove-destination
                if (removeDest) {
                    try {
                        await proc.fs.unlink(dest);
                    } catch(e) {}
                }

                // Backup
                if (isBackup) {
                    const backupPath = dest + backupSuffix;
                    try {
                        // rename API (IFileSystemに追加された前提) を使用
                        // IFileSystem.rename は存在すると仮定(mvの実装と同様)
                        await proc.fs.rename(dest, backupPath);
                        if (isVerbose) await writer.writeString(`backed up '${dest}' to '${backupPath}'\n`);
                    } catch (e: any) {
                        await errWriter.writeString(`cp: cannot backup '${dest}': ${e.message}\n`);
                        return;
                    }
                }
            }

            // --attributes-only
            if (isAttributesOnly) {
                if (!await proc.fs.exists(dest)) {
                    await proc.fs.touchFile(dest);
                }
            } else {
                // [Data Copy using IFileStream]
                // 1. ソースを開く
                const fsIn = await proc.fs.open(src, 'r');
                
                // 2. ターゲットを開く
                // overwriteの場合は 'w' で開くことでtruncateされる
                const fsOut = await proc.fs.open(dest, 'w');

                try {
                    // 3. バッファをアタッチ (必須！)
                    // Web Streamsではないので、attach() してから read() ループする
                    const bufSize = 64 * 1024;
                    const buf = new Uint8Array(bufSize);
                    fsIn.attach(buf);

                    while (true) {
                        // 積み上げ読み込み
                        const { cntRead, data } = await fsIn.read(); // dataはbufへのビュー
                        if (cntRead === 0) break; // EOF
                        
                        // 書き込み (IFileStream.writeは内部バッファリング＆バックプレッシャー制御あり)
                        await fsOut.write(data);
                    }
                } catch (e: any) {
                     await errWriter.writeString(`cp: error writing to '${dest}': ${e.message}\n`);
                     exitCode = 1;
                } finally {
                    // クローズ (内部でflushされる)
                    await fsIn.close();
                    await fsOut.close();
                }
            }

            // [Preserve Attributes] -p, -a
            if (preserve) {
                try {
                    // IFileSystem.chmod は定義済み
                    await proc.fs.chmod(dest, statSrc.mode);
                    // mtime等の復元は IFileSystem に utimes がないためスキップ
                } catch {}
            }

            if (isVerbose) await writer.writeString(`'${src}' -> '${dest}'\n`);
        };


        // メインループ
        for (const src of arrSources) {
            let finalDest = strDest!;
            // ディレクトリへのコピーならファイル名を結合
            if (destIsDir) {
                const fileName = src.split('/').pop() || src;
                finalDest = `${strDest}/${fileName}`;
            }
            
            await processCopyItem(src, finalDest);
        }

    } finally {
        writer.releaseLock();
        errWriter.releaseLock();
    }

    return exitCode;
}

/**
 * [Helper] ユーザー確認
 */
async function readConfirmation(proc: IProcess): Promise<boolean> {
    if (!proc.stdin) return false;
    const reader = new BinaryReader(proc.stdin.getByteReader());
    try {
        const { value } = await reader.readString();
        const input = value.trim().toLowerCase();
        return input === 'y' || input === 'yes';
    } catch {
        return false;
    } finally {
        reader.releaseLock();
    }
}