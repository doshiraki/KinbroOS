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

export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const def: CommandDef = {
        name: 'sort',
        desc: 'sort lines of text files with full pipeline support',
        usage: '[OPTION]... [FILE]...',
        options: [
            { short: 'n', long: 'numeric-sort', desc: 'compare numerical value' },
            { short: 'r', long: 'reverse', desc: 'reverse result' },
            { short: 'u', long: 'unique', desc: 'output only the first of an equal run' },
            { short: 'f', long: 'ignore-case', desc: 'fold lower case to upper case' },
            { short: 'o', long: 'output', desc: 'write to FILE', hasArg: true },
            { short: 'b', long: 'ignore-leading-blanks', desc: 'ignore leading blanks' },
            { short: 'h', long: 'human-numeric-sort', desc: 'compare human readable numbers' },
            { short: 'M', long: 'month-sort', desc: 'compare month names' },
            { short: 'V', long: 'version-sort', desc: 'natural sort of version numbers' },
            { short: 't', long: 'field-separator', desc: 'use SEP instead of blanks', hasArg: true },
            { short: 'k', long: 'key', desc: 'sort via a key', hasArg: true }
        ]
    };

    const parser = new CommandParser(args, def);
    if (parser.isHelpRequested) {
        const writer = new BinaryWriter(proc.stdout!.getByteWriter());
        await writer.writeString(parser.getHelp());
        writer.close();
        return 0;
    }

    const writer = new BinaryWriter(proc.stdout!.getByteWriter()); //
    const arrTargets = parser.args.length > 0 ? parser.args : ['-'];
    let allLines: string[] = [];

    try {
        for (const target of arrTargets) {
            if (target === '-') {
                if (!proc.stdin) continue;
                const reader = new BinaryReader(proc.stdin.getByteReader());
                try {
                    let stdinContent = '';
                    while (true) {
                        const { value, done } = await reader.readString();
                        if (done) break;
                        stdinContent += value;
                    }
                    allLines.push(...stdinContent.split('\n'));
                } finally {
                    reader.releaseLock(); //
                }
            } else {
                try {
                    const content = await proc.fs.readFile(target, 'utf8') as string;
                    allLines.push(...content.split('\n'));
                } catch (e) {}
            }
        }

        allLines = allLines.filter(l => l !== '');

        // --- ソート比較ロジック (不変) ---
        const months: Record<string, number> = { 'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6, 'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12 };
        const parseHuman = (s: string): number => {
            const match = s.match(/^(\d+(?:\.\d+)?)([KMGTP]?)/i);
            if (!match) return 0;
            const units: Record<string, number> = { 'K': 1e3, 'M': 1e6, 'G': 1e9, 'T': 1e12, 'P': 1e15 };
            return parseFloat(match[1]) * (units[match[2].toUpperCase()] || 1);
        };
        const sep = (parser.get('t') as string) || '';
        const keyDef = parser.get('k') as string;

        allLines.sort((a, b) => {
            let fA = a, fB = b;
            if (keyDef) {
                const k = parseInt(keyDef) - 1;
                const pA = sep ? a.split(sep) : a.trim().split(/\s+/);
                const pB = sep ? b.split(sep) : b.trim().split(/\s+/);
                fA = pA[k] || ''; fB = pB[k] || '';
            }
            if (parser.has('b')) { fA = fA.trimStart(); fB = fB.trimStart(); }
            if (parser.has('f')) { fA = fA.toLowerCase(); fB = fB.toLowerCase(); }
            if (parser.has('n')) return parseFloat(fA) - parseFloat(fB);
            if (parser.has('h')) return parseHuman(fA) - parseHuman(fB);
            if (parser.has('M')) return (months[fA.substring(0,3).toUpperCase()] || 0) - (months[fB.substring(0,3).toUpperCase()] || 0);
            if (parser.has('V')) return fA.localeCompare(fB, undefined, { numeric: true });
            return fA.localeCompare(fB);
        });

        if (parser.has('r')) allLines.reverse();
        if (parser.has('u')) allLines = Array.from(new Set(allLines));

        const result = allLines.join('\n') + (allLines.length > 0 ? '\n' : '');
        const outPath = parser.get('o') as string;

        if (outPath) {
            await proc.fs.writeFile(outPath, result);
        } else {
            await writer.writeString(result);
        }
    } finally {
        writer.close(); // ✨ ここが重要！次のコマンドにEOFを伝える
    }
    return 0;
}