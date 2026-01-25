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
 * 🌟 [Pipeline Ready] tail.ts
 * 標準入力のバッファリングとストリームクローズに対応した tail 実装です。
 */
export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const def: CommandDef = {
        name: 'tail',
        desc: 'output the last part of files',
        usage: '[OPTION]... [FILE]...',
        options: [
            { short: 'n', long: 'lines', desc: 'output the last NUM lines', hasArg: true },
            { short: 'c', long: 'bytes', desc: 'output the last NUM bytes', hasArg: true },
            { short: 'q', long: 'quiet', desc: 'never output headers' },
            { short: 'v', long: 'verbose', desc: 'always output headers' }
        ]
    };

    const parser = new CommandParser(args, def);
    const writer = new BinaryWriter(proc.stdout!.getByteWriter());
    const errWriter = new BinaryWriter(proc.stderr!.getByteWriter());

    if (parser.isHelpRequested) {
        await writer.writeString(parser.getHelp());
        writer.close();
        return 0;
    }

    const arrTargets = parser.args.length > 0 ? parser.args : ['-'];
    const nArg = parser.get('n') as string;
    const cArg = parser.get('c') as string;
    const isQuiet = parser.has('q');
    const isVerbose = parser.has('v');

    const numLines = nArg ? parseInt(nArg) : 10;
    const numBytes = cArg ? parseInt(cArg) : undefined;

    try {
        for (let i = 0; i < arrTargets.length; i++) {
            const target = arrTargets[i];
            let rawData: Uint8Array;

            if (!isQuiet && (arrTargets.length > 1 || isVerbose)) {
                if (i > 0) await writer.writeString('\n');
                await writer.writeString(`==> ${target === '-' ? 'standard input' : target} <==\n`);
            }

            // --- A. 全データのバッファリング (stdin対応) ---
            if (target === '-') {
                if (!proc.stdin) continue;
                const reader = new BinaryReader(proc.stdin.getByteReader());
                const chunks: Uint8Array[] = [];
                let totalLen = 0;
                try {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                        totalLen += value.length;
                    }
                    rawData = new Uint8Array(totalLen);
                    let offset = 0;
                    for (const chunk of chunks) {
                        rawData.set(chunk, offset);
                        offset += chunk.length;
                    }
                } finally {
                    reader.releaseLock();
                }
            } else {
                try {
                    rawData = await proc.fs.readFile(target, 'binary') as Uint8Array;
                } catch (e: any) {
                    await errWriter.writeString(`tail: cannot open '${target}' for reading: ${e.message}\n`);
                    continue;
                }
            }

            // --- B. 出力処理 (末尾の切り出し) ---
            if (numBytes !== undefined) {
                const start = Math.max(0, rawData.length - Math.abs(numBytes));
                await writer.write(rawData.subarray(start));
            } else {
                const text = new TextDecoder().decode(rawData);
                const lines = text.split('\n');
                if (text.endsWith('\n')) lines.pop();

                const start = Math.max(0, lines.length - Math.abs(numLines));
                const result = lines.slice(start).join('\n');
                if (result || start < lines.length) await writer.writeString(result + '\n');
            }
        }
    } finally {
        writer.close(); // ✨ 終了を通知
        errWriter.close();
    }
    return 0;
}