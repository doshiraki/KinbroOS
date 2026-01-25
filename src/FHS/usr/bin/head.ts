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
import { CommandParser, CommandDef } from '../lib/CommandParser';
import { BinaryReader, BinaryWriter } from '../lib/StreamUtils'; //

/**
 * 🌟 [Pipeline Integrated] head.ts
 * BinaryReader の仕様に合わせ、チャンク収集方式で実装を修正しました。
 */
export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const def: CommandDef = {
        name: 'head',
        desc: 'output the first part of files',
        usage: '[OPTION]... [FILE]...',
        options: [
            { short: 'n', long: 'lines', desc: 'print the first NUM lines', hasArg: true },
            { short: 'c', long: 'bytes', desc: 'print the first NUM bytes', hasArg: true },
            { short: 'q', long: 'quiet', desc: 'never print headers' },
            { short: 'v', long: 'verbose', desc: 'always print headers' }
        ]
    };

    const parser = new CommandParser(args, def);
    const writer = new BinaryWriter(proc.stdout!.getByteWriter()); //
    const errWriter = new BinaryWriter(proc.stderr!.getByteWriter());

    if (parser.isHelpRequested) {
        await writer.writeString(parser.getHelp());
        writer.close();
        errWriter.close();
        return 0;
    }

    const arrTargets = parser.args.length > 0 ? parser.args : ['-'];
    const nArg = parser.get('n') as string;
    const cArg = parser.get('c') as string;
    const isQuiet = parser.has('q');
    const isVerbose = parser.has('v');

    const numLines = nArg ? parseInt(nArg) : (cArg ? undefined : 10);
    const numBytes = cArg ? parseInt(cArg) : undefined;

    try {
        for (let i = 0; i < arrTargets.length; i++) {
            const target = arrTargets[i];
            let content = '';
            let binContent: Uint8Array | null = null;

            if (!isQuiet && (arrTargets.length > 1 || isVerbose)) {
                if (i > 0) await writer.writeString('\n');
                await writer.writeString(`==> ${target === '-' ? 'standard input' : target} <==\n`);
            }

            // --- A. データ入力 (cat.ts の流儀を継承) ---
            if (target === '-') {
                if (!proc.stdin) continue;
                const reader = new BinaryReader(proc.stdin.getByteReader());
                try {
                    const chunks: Uint8Array[] = [];
                    let currentRead = 0;
                    while (true) {
                        const { value, done } = await reader.read(); // 引数なしで呼ぶ
                        if (done || !value) break;
                        
                        chunks.push(value);
                        currentRead += value.length;

                        // バイト数指定かつ正の値なら、必要分に達した時点で打ち切り
                        if (numBytes !== undefined && numBytes >= 0 && currentRead >= numBytes) break;
                    }

                    // 読み込んだチャンクを一つの Uint8Array に結合
                    const full = new Uint8Array(currentRead);
                    let offset = 0;
                    for (const chunk of chunks) {
                        const copyLen = Math.min(chunk.length, currentRead - offset);
                        full.set(chunk.subarray(0, copyLen), offset);
                        offset += copyLen;
                        if (offset >= currentRead) break;
                    }

                    if (numBytes !== undefined && numBytes >= 0) {
                        binContent = full;
                    } else {
                        content = new TextDecoder().decode(full);
                    }
                } finally {
                    reader.releaseLock(); //
                }
            } else {
                try {
                    if (numBytes !== undefined && numBytes >= 0) {
                        const full = await proc.fs.readFile(target, 'binary') as Uint8Array;
                        binContent = full.subarray(0, numBytes);
                    } else {
                        content = await proc.fs.readFile(target, 'utf8') as string;
                    }
                } catch (e: any) {
                    await errWriter.writeString(`head: ${target}: ${e.message}\n`);
                    continue;
                }
            }

            // --- B. 出力処理 (仕様への準拠) ---
            if (numBytes !== undefined) {
                if (binContent) {
                    await writer.write(binContent);
                } else {
                    const full = new TextEncoder().encode(content);
                    const end = Math.max(0, full.length + numBytes);
                    await writer.write(full.subarray(0, end));
                }
            } else if (numLines !== undefined) {
                const lines = content.split('\n');
                if (content.endsWith('\n')) lines.pop();

                let end = numLines;
                if (numLines < 0) {
                    end = Math.max(0, lines.length + numLines);
                }
                const result = lines.slice(0, end).join('\n');
                if (result || end > 0) await writer.writeString(result + '\n');
            }
        }
    } finally {
        writer.close(); // ストリームを閉じる
        errWriter.close();
    }
    return 0;
}