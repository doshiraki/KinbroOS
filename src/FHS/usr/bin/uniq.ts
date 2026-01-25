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
        name: 'uniq',
        desc: 'omit repeated lines with full pipeline support',
        usage: '[OPTION]... [INPUT [OUTPUT]]',
        options: [
            { short: 'c', long: 'count', desc: 'prefix lines by number of occurrences' },
            { short: 'd', long: 'repeated', desc: 'only print duplicate lines' },
            { short: 'D', long: 'all-repeated', desc: 'print all duplicate lines' },
            { short: 'i', long: 'ignore-case', desc: 'ignore case differences' },
            { short: 'u', long: 'unique', desc: 'only print unique lines' },
            { short: 'f', long: 'skip-fields', desc: 'skip first N fields', hasArg: true },
            { short: 's', long: 'skip-chars', desc: 'skip first N chars', hasArg: true },
            { short: 'w', long: 'check-chars', desc: 'check no more than N chars', hasArg: true }
        ]
    };

    const parser = new CommandParser(args, def);
    if (parser.isHelpRequested) {
        const writer = new BinaryWriter(proc.stdout!.getByteWriter());
        await writer.writeString(parser.getHelp());
        writer.close();
        return 0;
    }

    const inputPath = parser.args[0] || '-';
    const outputPath = parser.args[1];
    const writer = new BinaryWriter(proc.stdout!.getByteWriter()); //

    try {
        let content = '';
        if (inputPath === '-') {
            if (proc.stdin) {
                const reader = new BinaryReader(proc.stdin.getByteReader());
                try {
                    while (true) {
                        const { value, done } = await reader.readString();
                        if (done) break;
                        content += value;
                    }
                } finally {
                    reader.releaseLock(); //
                }
            }
        } else {
            content = await proc.fs.readFile(inputPath, 'utf8') as string;
        }

        const lines = content.split('\n').filter(l => l !== '');
        
        // --- フィルタリングロジック (不変) ---
        const skipF = parseInt(parser.get('f') as string || '0');
        const skipC = parseInt(parser.get('s') as string || '0');
        const checkC = parseInt(parser.get('w') as string || '0');
        const ignoreC = parser.has('i');

        const getK = (l: string) => {
            let k = l;
            if (skipF > 0) k = k.trim().split(/\s+/).slice(skipF).join(' ');
            if (skipC > 0) k = k.slice(skipC);
            if (checkC > 0) k = k.slice(0, checkC);
            return ignoreC ? k.toLowerCase() : k;
        };

        const results: string[] = [];
        let i = 0;
        while (i < lines.length) {
            let j = i + 1;
            const curK = getK(lines[i]);
            while (j < lines.length && getK(lines[j]) === curK) j++;
            const count = j - i;
            const group = lines.slice(i, j);

            if (parser.has('D')) {
                if (count > 1) group.forEach(l => results.push(l));
            } else {
                const out = parser.has('c') ? `${count.toString().padStart(7)} ${group[0]}` : group[0];
                if (parser.has('d')) { if (count > 1) results.push(out); }
                else if (parser.has('u')) { if (count === 1) results.push(out); }
                else results.push(out);
            }
            i = j;
        }

        const final = results.join('\n') + (results.length > 0 ? '\n' : '');
        if (outputPath) await proc.fs.writeFile(outputPath, final);
        else await writer.writeString(final);

    } finally {
        writer.close(); // ✨ 終了を通知
    }
    return 0;
}