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

//!/usr/bin/chmod.ts
import { SystemAPI } from '../../../dev/types/SystemAPI';
import { IProcess } from '../../../dev/types/IProcess';
import { CommandParser } from '../lib/CommandParser';

export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const parser = new CommandParser(args, {
        name: 'chmod',
        usage: '<MODE> [FILE]...',
        desc: 'Change file mode bits.',
        options: []
    });

    if (parser.has(undefined, 'help')) {
        const writer = proc.stdout!.getStringWriter()
        await writer.write(parser.getHelp());
        writer.releaseLock();
        return 0;
    }

    const arrPositionals = parser.args;
    if (arrPositionals.length < 2) {
        const w = proc.stderr!.getStringWriter();
        await w.write('chmod: missing operand\n');
        w.releaseLock();
        return 1;
    }

    const strMode = arrPositionals[0]; // e.g., "+x", "755"
    const arrFiles = arrPositionals.slice(1);
    
    // Mode analysis (Simplified: only supports +x/-x, delegates octal to ZenFS)
    let fnUpdateMode: ((current: number) => number) | null = null;
    if (strMode === '+x') {
        fnUpdateMode = (m) => m | 0o111; // Grant execute permission to User, Group, Others
    } else if (strMode === '-x') {
        fnUpdateMode = (m) => m & ~0o111; // Revoke execute permission
    } else if (/^[0-7]+$/.test(strMode)) {
        // Octal specification (e.g., 755)
        const valOctal = parseInt(strMode, 8);
        fnUpdateMode = () => valOctal;
    } else {
        const w = proc.stderr!.getStringWriter();
        await w.write(`chmod: invalid mode: '${strMode}'\n`);
        w.releaseLock();
        return 1;
    }

    const writerErr = proc.stderr!.getStringWriter();
    let valExitCode = 0;

    try {
        for (const strFile of arrFiles) {
            try {
                const stat = await proc.fs.getStat(strFile);
                const valNewMode = fnUpdateMode(stat.mode);
                
                // Call ZenFS chmod
                // * If FileSystem.ts lacks chmod, it needs to be added, but
                // ZenFS (fs.promises) already has chmod.
                // Assuming it can be called via the IFileSystem interface.
                // If IFileSystem lacks chmod, expansion like calling proc.fs.fs.chmod (raw fs) is needed.
                // Writing here assuming IFileSystem has chmod, or escaping with an any cast.
                
                // [IMPORTANT] Highly recommended to add chmod to FileSystem.ts!
                // For now, written on the premise that proc.fs is extended.
                await proc.fs.chmod(strFile, valNewMode);

            } catch (e: any) {
                await writerErr.write(`chmod: cannot access '${strFile}': ${e.message}\n`);
                valExitCode = 1;
            }
        }
    } finally {
        writerErr.releaseLock();
    }

    return valExitCode;
}
