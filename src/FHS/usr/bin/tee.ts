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
import { BinaryReader, BinaryWriter } from '../lib/StreamUtils';
import { createFileSinkStream } from '../lib/FileStreamAdapter';

/**
 * [Command: tee]
 * 標準入力を読み込み、標準出力とファイルに複製して出力する。
 * パイプラインの中継地点として非常に重要。
 */
export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const parser = new CommandParser(args, {
        name: 'tee',
        usage: '[OPTION]... [FILE]...',
        desc: 'Copy standard input to each FILE, and to standard output.',
        options: [
            { short: 'a', long: 'append', desc: 'append to the given FILEs, do not overwrite' },
            { short: 'i', long: 'ignore-interrupts', desc: 'ignore interrupt signals' },
            { long: 'help', desc: 'display this help and exit' },
            { long: 'version', desc: 'output version information and exit' }
        ]
    });

    if (parser.has(undefined, 'help')) {
        const writer = new BinaryWriter(proc.stdout!.getByteWriter());
        await writer.writeString(parser.getHelp());
        writer.releaseLock();
        return 0;
    }

    if (parser.has(undefined, 'version')) {
        const writer = new BinaryWriter(proc.stdout!.getByteWriter());
        await writer.writeString('tee (KinbroOS coreutils) 1.0\n');
        writer.releaseLock();
        return 0;
    }

    const errWriter = proc.stderr ? new BinaryWriter(proc.stderr.getByteWriter()) : null;

    // 1. Setup Input (Stdin)
    if (!proc.stdin) {
        if (errWriter) {
            await errWriter.writeString('tee: standard input not available\n');
            errWriter.close();
        }
        return 1;
    }
    const reader = new BinaryReader(proc.stdin.getByteReader());

    // 2. Setup Outputs
    const writers: BinaryWriter[] = [];
    const files = parser.args;
    const isAppend = parser.has('a', 'append');
    const mode = isAppend ? 'a' : 'w';

    // 2a. Stdout (Always active unless redirected away externally, but tee writes to it)
    if (proc.stdout) {
        writers.push(new BinaryWriter(proc.stdout.getByteWriter()));
    }

    // 2b. Files
    for (const filePath of files) {
        try {
            // Open file using FileSystem (supports 'a' or 'w')
            const fsHandle = await proc.fs.open(filePath, mode);
            
            // Wrap IFileStream -> WritableStream -> BinaryWriter
            const ws = createFileSinkStream(fsHandle);
            writers.push(new BinaryWriter(ws.getWriter()));
        } catch (e: any) {
            // ファイルが開けなくても他への出力は継続する (UNIX準拠)
            if (errWriter) {
                await errWriter.writeString(`tee: ${filePath}: ${e.message}\n`);
            }
        }
    }

    // 3. Main Loop
    let exitCode = 0;
    try {
        while (true) {
            // Read from Stdin
            const { value, done } = await reader.read();
            if (done) break;
            
            // Write to All Outputs (Parallel)
            // どこかへの書き込みが失敗しても、他は止めない
            const promises = writers.map(async (w) => {
                try {
                    await w.write(value);
                } catch (e) {
                    // 個別の書き込みエラーは無視するか警告 (今回は握りつぶして続行)
                }
            });
            await Promise.all(promises);
        }
    } catch (e: any) {
        // -i (ignore-interrupts)
        // ※ 現状のKinbroOSではKernel側でProcessをkillするため、
        //   ここでCatchしてもプロセス自体が止まる可能性が高いが、
        //   Userland側の実装としてはここで握りつぶす意図を示しておく。
        if (parser.has('i', 'ignore-interrupts') && (e.message === 'Interrupted' || e.name === 'SignalError')) {
             // Ignore
        } else {
            // その他のエラー
            if (errWriter) {
                await errWriter.writeString(`tee: read error: ${e.message}\n`);
            }
            exitCode = 1;
        }
    } finally {
        // 4. Cleanup
        reader.releaseLock();
        
        // Close all writers
        await Promise.all(writers.map(w => w.close().catch(() => {})));
        if (errWriter) errWriter.close();
    }

    return exitCode;
}
