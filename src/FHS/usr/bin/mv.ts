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

// src/FHS/usr/bin/mv.ts

import { SystemAPI } from '../../../dev/types/SystemAPI';
import { IProcess } from '../../../dev/types/IProcess';
import { CommandParser } from '../lib/CommandParser';
import { BinaryReader, BinaryWriter } from '../lib/StreamUtils';

/**
 * [Command: mv]
 * ファイルまたはディレクトリの移動・名前変更を行う。
 * GNU coreutils 準拠:
 * - 競合解決 (-f, -i, -n)
 * - バックアップ (--backup, -b, -S)
 * - ディレクトリ移動 (-t, -T)
 * - 更新移動 (-u)
 */
export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const parser = new CommandParser(args, {
        name: 'mv',
        usage: '[OPTION]... [-T] SOURCE DEST\n  or:  mv [OPTION]... SOURCE... DIRECTORY\n  or:  mv [OPTION]... -t DIRECTORY SOURCE...',
        desc: 'Rename SOURCE to DEST, or move SOURCE(s) to DIRECTORY.',
        options: [
            { short: 'f', long: 'force', desc: 'do not prompt before overwriting' },
            { short: 'i', long: 'interactive', desc: 'prompt before overwrite' },
            { short: 'n', long: 'no-clobber', desc: 'do not overwrite an existing file' },
            { short: 'v', long: 'verbose', desc: 'explain what is being done' },
            { short: 'u', long: 'update', desc: 'move only when the SOURCE file is newer than the destination file' },
            { short: 't', long: 'target-directory', desc: 'move all SOURCE arguments into DIRECTORY', hasArg: true },
            { short: 'T', long: 'no-target-directory', desc: 'treat DEST as a normal file' },
            { long: 'strip-trailing-slashes', desc: 'remove any trailing slashes from each SOURCE argument' },
            { short: 'b', desc: 'like --backup but does not accept an argument' },
            { long: 'backup', desc: 'make a backup of each existing destination file' },
            { short: 'S', long: 'suffix', desc: 'override the usual backup suffix', hasArg: true },
            { long: 'help', desc: 'display this help and exit' }
        ]
    });

    const writer = new BinaryWriter(proc.stdout!.getByteWriter());
    const errWriter = new BinaryWriter(proc.stderr!.getByteWriter());

    // ヘルプ表示
    if (parser.isHelpRequested) {
        await writer.writeString(parser.getHelp() + '\n');
        writer.releaseLock();
        errWriter.releaseLock();
        return 0;
    }

    // 引数検証
    const validateMsg = parser.validate();
    if (validateMsg) {
        await errWriter.writeString(validateMsg + '\n');
        writer.releaseLock();
        errWriter.releaseLock();
        return 1;
    }

    // --- 1. オプション競合の解決 (Last Wins Strategy) ---
    // -f, -i, -n は最後に指定されたものが優先される
    let modeOverwrite = 'force'; // default (UNIX mv is usually silent)
    
    // 引数を逆順走査して決定する (CommandParserの結果ではなく生引数を見るのが確実だが、
    // ここでは簡易的にParserのフラグ順序が保存されないため、厳密なLast Winsには生のargs走査が必要)
    for (let i = args.length - 1; i >= 0; i--) {
        const arg = args[i];
        if (arg === '-n' || arg === '--no-clobber') { modeOverwrite = 'no-clobber'; break; }
        if (arg === '-i' || arg === '--interactive') { modeOverwrite = 'interactive'; break; }
        if (arg === '-f' || arg === '--force') { modeOverwrite = 'force'; break; }
    }

    const isVerbose = parser.has('v', 'verbose');
    const isUpdate = parser.has('u', 'update');
    const stripSlashes = parser.has(undefined, 'strip-trailing-slashes');
    
    // バックアップ設定
    const isBackup = parser.has('b') || parser.has(undefined, 'backup');
    const backupSuffix = (parser.get('suffix') as string) || '~';

    // --- 2. ソースとターゲットの決定 ---
    let arrSources: string[] = [];
    let strDest: string | null = null;
    let isTargetDirectoryMode = false;

    // -t オプションがある場合: mv -t DIR SRC1 SRC2
    if (parser.has('t', 'target-directory')) {
        strDest = parser.get('target-directory') as string;
        arrSources = parser.args;
        isTargetDirectoryMode = true;
    } else {
        // 通常モード: 最後の引数が DEST
        if (parser.args.length < 2) {
            await errWriter.writeString("mv: missing file operand\n");
            writer.releaseLock(); errWriter.releaseLock();
            return 1;
        }
        strDest = parser.args[parser.args.length - 1];
        arrSources = parser.args.slice(0, -1);
    }

    // -T: DESTをディレクトリとして扱わない (明示的にファイル扱い)
    const noTargetDir = parser.has('T', 'no-target-directory');

    // ソースの末尾スラッシュ除去
    if (stripSlashes) {
        arrSources = arrSources.map(s => s.endsWith('/') && s !== '/' ? s.slice(0, -1) : s);
    }

    // --- 3. 実行ループ ---
    let exitCode = 0;

    try {
        // ターゲットがディレクトリかどうか確認
        let destIsDir = false;
        if (!noTargetDir && strDest) {
            try {
                // 移動先が存在し、かつディレクトリであるか
                const stat = await proc.fs.getStat(strDest);
                if (stat.isDirectory()) destIsDir = true;
            } catch {}
        }

        // 複数ソース指定なのにターゲットがディレクトリでない場合はエラー
        if (arrSources.length > 1 && !destIsDir && !isTargetDirectoryMode) {
            await errWriter.writeString(`mv: target '${strDest}' is not a directory\n`);
            writer.releaseLock(); errWriter.releaseLock();
            return 1;
        }

        for (const src of arrSources) {
            // 移動先のパスを決定
            let targetPath = strDest!;
            if (destIsDir) {
                // ディレクトリへ移動: dest/srcFilename
                const fileName = src.split('/').pop() || src;
                // パス結合 (末尾スラッシュケア)
                targetPath = strDest!.endsWith('/') ? `${strDest}${fileName}` : `${strDest}/${fileName}`;
            }

            // ソース存在チェック
            if (!await proc.fs.exists(src)) {
                await errWriter.writeString(`mv: cannot stat '${src}': No such file or directory\n`);
                exitCode = 1;
                continue;
            }

            // 移動先が自分自身かチェック (簡易比較)
            // ※ 本来は inode 番号比較などが正確
            if (proc.fs.resolvePath(src) === proc.fs.resolvePath(targetPath)) {
                await errWriter.writeString(`mv: '${src}' and '${targetPath}' are the same file\n`);
                exitCode = 1;
                continue;
            }

            // 上書きチェック (Destination Exists)
            if (await proc.fs.exists(targetPath)) {
                // -n: 上書きしない (No Clobber)
                if (modeOverwrite === 'no-clobber') {
                    continue; // 失敗ではなく静かにスキップ
                }

                // -u: 更新モード (SourceがDestより新しい場合のみ移動)
                if (isUpdate) {
                    try {
                        const statSrc = await proc.fs.getStat(src);
                        const statDest = await proc.fs.getStat(targetPath);
                        if (statSrc.mtimeMs <= statDest.mtimeMs) {
                            continue; // 移動しない
                        }
                    } catch {}
                }

                // -i: インタラクティブ (確認)
                if (modeOverwrite === 'interactive') {
                    await errWriter.writeString(`mv: overwrite '${targetPath}'? (y/n) `);
                    const ans = await readConfirmation(proc);
                    if (!ans) continue;
                }

                // --backup: バックアップ作成
                if (isBackup) {
                    const backupPath = targetPath + backupSuffix;
                    if (isVerbose) await writer.writeString(`backed up '${targetPath}' to '${backupPath}'\n`);
                    try {
                        await proc.fs.rename(targetPath, backupPath); // 既存ファイルを退避
                    } catch (e: any) {
                        await errWriter.writeString(`mv: cannot backup '${targetPath}': ${e.message}\n`);
                        exitCode = 1;
                        continue;
                    }
                }
            }

            // 移動実行 (Rename)
            try {
                await proc.fs.rename(src, targetPath);
                
                if (isVerbose) {
                    await writer.writeString(`renamed '${src}' -> '${targetPath}'\n`);
                }
            } catch (e: any) {
                await errWriter.writeString(`mv: cannot move '${src}' to '${targetPath}': ${e.message}\n`);
                exitCode = 1;
            }
        }
    } finally {
        writer.releaseLock();
        errWriter.releaseLock();
    }

    return exitCode;
}

/**
 * [Helper] ユーザーからの y/n 入力を待機する
 */
async function readConfirmation(proc: IProcess): Promise<boolean> {
    if (!proc.stdin) return false;
    
    // stdinから1行読むためのリーダー
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