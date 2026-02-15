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

/**
 * [Command: uname]
 * システム情報を表示する。
 * スクリプトによるOS判定やアーキテクチャチェックで重要。
 */
export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const parser = new CommandParser(args, {
        name: 'uname',
        usage: '[OPTION]...',
        desc: 'Print certain system information.  With no OPTION, same as -s.',
        options: [
            { short: 'a', long: 'all', desc: 'print all information, in the following order' },
            { short: 's', long: 'kernel-name', desc: 'print the kernel name' },
            { short: 'n', long: 'nodename', desc: 'print the network node hostname' },
            { short: 'r', long: 'kernel-release', desc: 'print the kernel release' },
            { short: 'v', long: 'kernel-version', desc: 'print the kernel version' },
            { short: 'm', long: 'machine', desc: 'print the machine hardware name' },
            { short: 'p', long: 'processor', desc: 'print the processor type (non-portable)' },
            { short: 'i', long: 'hardware-platform', desc: 'print the hardware platform (non-portable)' },
            { short: 'o', long: 'operating-system', desc: 'print the operating system' },
            { long: 'help', desc: 'display this help and exit' },
            { long: 'version', desc: 'output version information and exit' }
        ]
    });

    if (parser.has(undefined, 'help')) {
        const writer = new BinaryWriter(proc.stdout!.getByteWriter());
        await writer.writeString(parser.getHelp());
        await writer.close(); // 🌟 Fix: releaseLock -> close
        return 0;
    }

    if (parser.has(undefined, 'version')) {
        const writer = new BinaryWriter(proc.stdout!.getByteWriter());
        await writer.writeString('uname (KinbroOS coreutils) 1.0\n');
        await writer.close(); // 🌟 Fix: releaseLock -> close
        return 0;
    }

    // --- System Info Definitions ---
    const info = {
        sysname: 'KinbroOS',                    // -s
        nodename: 'kinbro-node',                // -n
        release: '1.0.0-parasitic',             // -r
        version: `Web Standard ${new Date().toISOString()}`, // -v
        machine: 'x86_64',                      // -m
        processor: 'unknown',                   // -p
        platform: 'unknown',                    // -i
        os: 'GNU/Linux'                         // -o
    };

    // --- Flag Evaluation ---
    const isAll = parser.has('a', 'all');
    const hasAnyFlag = ['s', 'n', 'r', 'v', 'm', 'p', 'i', 'o'].some(f => parser.has(f) || parser.has(undefined, parser['objDef'].options?.find(o => o.short === f)?.long));
    
    const show = {
        sysname: isAll || (!hasAnyFlag && !isAll) || parser.has('s', 'kernel-name'),
        nodename: isAll || parser.has('n', 'nodename'),
        release: isAll || parser.has('r', 'kernel-release'),
        version: isAll || parser.has('v', 'kernel-version'),
        machine: isAll || parser.has('m', 'machine'),
        processor: isAll || parser.has('p', 'processor'),
        platform: isAll || parser.has('i', 'hardware-platform'),
        os: isAll || parser.has('o', 'operating-system')
    };

    // --- Output Construction ---
    const outputParts: string[] = [];

    if (show.sysname) outputParts.push(info.sysname);
    if (show.nodename) outputParts.push(info.nodename);
    if (show.release) outputParts.push(info.release);
    if (show.version) outputParts.push(info.version);
    if (show.machine) outputParts.push(info.machine);
    if (show.processor) outputParts.push(info.processor);
    if (show.platform) outputParts.push(info.platform);
    if (show.os) outputParts.push(info.os);

    const writer = new BinaryWriter(proc.stdout!.getByteWriter());
    await writer.writeString(outputParts.join(' ') + '\n');
    
    // 🌟 Fix: ここで確実に閉じて EOF を送る！
    await writer.close();

    return 0;
}