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

import { SystemAPI } from '../../../dev/types/SystemAPI';
import { IProcess } from '../../../dev/types/IProcess';
import { CommandParser } from '../lib/CommandParser';
import { BinaryWriter } from '../lib/StreamUtils';
import { ITarEntry } from '@/dev/types/IArchiver';
import { createFileSinkStream } from '../lib/FileStreamAdapter';

/**
 * [Command: tar]
 * -c: 複数ファイル対応
 * -t: リスト表示対応
 * -x: 標準入力対応 (Reader -> Stream 変換追加)
 */
export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const parser = new CommandParser(args, {
        name: 'tar',
        usage: '[OPTION...] [FILE]...',
        desc: 'GNU tar archive utility',
        options: [
            { short: 'c', long: 'create', desc: 'create a new archive' },
            { short: 'x', long: 'extract', desc: 'extract files from an archive' },
            { short: 't', long: 'list', desc: 'list the contents of an archive' },
            { short: 'f', long: 'file', desc: 'use archive file or device ARCHIVE', hasArg: true },
            { short: 'v', long: 'verbose', desc: 'verbosely list files processed' },
            { short: 'z', long: 'gzip', desc: 'filter the archive through gzip' },
            { short: 'C', long: 'directory', desc: 'change to directory DIR', hasArg: true },
            { long: 'help', desc: 'display this help and exit' }
        ]
    });

    if (parser.has(undefined, 'help')) {
        const writer = new BinaryWriter(proc.stdout!.getByteWriter());
        await writer.writeString(parser.getHelp());
        await writer.close();
        return 0;
    }

    const isCreate = parser.has('c', 'create');
    const isExtract = parser.has('x', 'extract');
    const isList = parser.has('t', 'list');
    const isVerbose = parser.has('v', 'verbose'); // Verboseフラグ取得

    if (!isCreate && !isExtract && !isList) {
        const err = new BinaryWriter(proc.stderr!.getByteWriter());
        await err.writeString('tar: Must specify one of -c, -x, -t\n');
        await err.close();
        return 1;
    }

    const archiver = sys.createArchiver(proc);
    const strArchiveFile = parser.get('file') as string;
    const targets = parser.args; 

    try {
        if (isCreate) {
            // [Create]
            if (targets.length === 0) throw new Error('tar: Cowardly refusing to create an empty archive');
            
            let wsOutput: WritableStream<Uint8Array>;
            if (!strArchiveFile || strArchiveFile === '-') {
                if (!proc.stdout) throw new Error('tar: Stdout not available');
                wsOutput = proc.stdout.getByteWriter() as any; 
            } else {
                const handle = await proc.fs.open(strArchiveFile, 'w');
                wsOutput = createFileSinkStream(handle);
            }

            const rsArchive = archiver.archive(targets);
            await rsArchive.pipeTo(wsOutput);

        } else {
            // [Extract or List] Input is archive
            let rsInput: ReadableStream<Uint8Array>;
            if (!strArchiveFile || strArchiveFile === '-') {
                // Stdin
                if (!proc.stdin) throw new Error('tar: Stdin not available');
                
                // 🌟 Fix: Reader を Stream に変換する
                const reader = proc.stdin.getByteReader();
                rsInput = streamFromReader(reader);

            } else {
                // File
                //const handle = await proc.fs.open(strArchiveFile, 'r');
                //rsInput = createFileSourceStream(handle);
                rsInput = await proc.fs.readFile(strArchiveFile, 'binary') as any;
            }

            if (isList) {
                // [List]
                if (!proc.stdout) throw new Error('tar: Stdout not available');
                const writer = proc.stdout.getStringWriter();

                // 🌟 Callback方式に変更
                await archiver.list(rsInput, async (entry: ITarEntry) => {
                    if (isVerbose) {
                        // -tvf: 詳細表示
                        const strLine = formatLongList(entry);
                        await writer.write(strLine + '\n');
                    } else {
                        // -tf: ファイル名のみ
                        await writer.write(entry.name + '\n');
                    }
                });
            } else {
                // [Extract]
                const destDir = (parser.get('directory') as string) || proc.fs.getCWD();
                await archiver.extract(rsInput, destDir);
            }
        }

    } catch (e: any) {
        const errWriter = new BinaryWriter(proc.stderr!.getByteWriter());
        await errWriter.writeString(`tar: ${e.message}\n`);
        await errWriter.close();
        return 1;
    }

    return 0;
}

/**
 * 🌟 Helper: Reader -> Stream Adapter
 * DefaultReaderをラップして、ReadableStream<Uint8Array> として振る舞わせる
 */
function streamFromReader(reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
    return new ReadableStream({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    controller.close();
                    reader.releaseLock();
                } else {
                    controller.enqueue(value);
                }
            } catch (e) {
                controller.error(e);
                reader.releaseLock();
            }
        },
        cancel() {
            reader.cancel();
            reader.releaseLock();
        }
    });
}

/**
 * 🌟 Helper: ls -l スタイルのフォーマッタ
 * "drwxr-xr-x 0/0 0 1970-01-01 09:00 usr/" の形式を生成
 */
function formatLongList(entry: ITarEntry): string {
    const typeChar = entry.type === '5' || entry.name.endsWith('/') ? 'd' : '-';
    const strPerm = formatMode(entry.mode);
    
    // date-fns等が使えない環境を想定してシンプルに実装
    const date = new Date(entry.mtime * 1000);
    const strDate = date.getFullYear() + '-' +
        pad2(date.getMonth() + 1) + '-' +
        pad2(date.getDate()) + ' ' +
        pad2(date.getHours()) + ':' +
        pad2(date.getMinutes());

    // User/Group は tar 内では数値(ID)の場合と名前の場合があるが、
    // 今回のParser実装では数値(uid/gid)を取得している前提
    const strOwner = `${entry.uid}/${entry.gid}`;
    
    // サイズは右寄せしたいが、一旦シンプルに
    const strSize = entry.size.toString().padStart(8, ' ');

    return `${typeChar}${strPerm} ${strOwner} ${strSize} ${strDate} ${entry.name}`;
}

function pad2(n: number): string {
    return n.toString().padStart(2, '0');
}

/**
 * 0o755 -> "rwxr-xr-x" 変換
 */
function formatMode(mode: number): string {
    // 下位9ビットのみ使用
    const m = mode & 0o777;
    const chars = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
    
    const u = chars[(m >> 6) & 7];
    const g = chars[(m >> 3) & 7];
    const o = chars[m & 7];
    
    return u + g + o;
}