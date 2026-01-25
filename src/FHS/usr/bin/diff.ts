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
import * as Diff from 'diff';

export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const parser = new CommandParser(args, {
        name: 'diff',
        usage: '[OPTION]... FILES',
        desc: 'compare files line by line',
        options: [
            // 🌟 User Feedback: -u is flag, -U is arg
            { short: 'u', long: 'unified', desc: 'output unified context (default 3 lines)' }, // hasArg: false
            { short: 'U', desc: 'output NUM lines of unified context', hasArg: true },
            // 🌟 New: 表示ラベルの上書きオプション (Git連携用)
            { long: 'label', hasArg: true, desc: 'use LABEL instead of file name (can be repeated)' },
            
            { short: 'q', long: 'brief', desc: 'report only when files differ' },
            { short: 's', long: 'report-identical-files', desc: 'report when two files are the same' },
            { short: 'i', long: 'ignore-case', desc: 'ignore case differences in file contents' },
            { short: 'w', long: 'ignore-all-space', desc: 'ignore all white space' },
            { short: 'b', long: 'ignore-space-change', desc: 'ignore changes in the amount of white space' },
            { long: 'color', desc: 'colorize the output' },
            { long: 'no-color', desc: 'disable colorization' },
            { long: 'normal', desc: 'output a normal diff (the default)' }
        ]
    });

    const writer = new BinaryWriter(proc.stdout!.getByteWriter());
    const errWriter = new BinaryWriter(proc.stderr!.getByteWriter());

    if (parser.isHelpRequested) {
        await writer.writeString(parser.getHelp());
        return 0;
    }

    if (parser.args.length < 2) {
        await errWriter.writeString("diff: missing operand\nTry 'diff --help' for more information.\n");
        return 2;
    }

    const file1Path = parser.args[0];
    const file2Path = parser.args[1];

    // 🌟 Labelの取得 (指定がなければファイルパスを使う)
    const labels = parser.get('label');
    let label1 = file1Path;
    let label2 = file2Path;

    if (Array.isArray(labels)) {
        if (labels.length > 0) label1 = labels[0];
        if (labels.length > 1) label2 = labels[1];
    } else if (typeof labels === 'string') {
        label1 = labels;
        // 2つ目はデフォルトのまま
    }


    try {
        let content1 = "";
        let content2 = "";
        
        try { content1 = await proc.fs.readFile(file1Path) as string; } catch { throw new Error(`${file1Path}: No such file or directory`); }
        try { content2 = await proc.fs.readFile(file2Path) as string; } catch { throw new Error(`${file2Path}: No such file or directory`); }

        const isBrief = parser.has('q', 'brief');
        const isReportIdentical = parser.has('s', 'report-identical-files');
        const ignoreCase = parser.has('i', 'ignore-case');
        const ignoreWhitespace = parser.has('w', 'ignore-all-space') || parser.has('b', 'ignore-space-change');
        const useColor = parser.has(undefined, 'color') && !parser.has(undefined, 'no-color');
        
        // 🌟 Fix: 型指定を削除 (ライブラリの型定義バージョン差異を吸収)
        const diffOpts = {
            ignoreCase: ignoreCase,
            ignoreWhitespace: ignoreWhitespace
        };

        // 1. Brief Check (-q)
        if (isBrief) {
            // 🌟 Fix: undefinedガードと型キャスト
            const changes = Diff.diffLines(content1, content2, diffOpts) || [];
            const hasDiff = changes.some((part: any) => part.added || part.removed);
            
            if (hasDiff) {
                await writer.writeString(`Files ${label1} and ${label2} differ\n`);
                return 1;
            } else if (isReportIdentical) {
                await writer.writeString(`Files ${label1} and ${label2} are identical\n`);
                return 0;
            }
            return 0;
        }

        let format = 'normal';
        let context = 3;

        // 🌟 Logic Update: -U num を優先チェック
        if (parser.has('U')) {
            format = 'unified';
            const val = parser.get('U');
            if (val && typeof val === 'string') context = parseInt(val) || 3;
        }
        // -u (flag) チェック ( -U が指定されていなければ context=3 のまま unified になる)
        else if (parser.has('u', 'unified')) {
            format = 'unified';
        }
        else if (parser.has('c', 'context')) {
            format = 'unified';
            const val = parser.get('context');
            if (val && typeof val === 'string') context = parseInt(val) || 3;
        }

        if (format === 'unified') {
            // 🌟 Fix: patchのundefinedガード
            const patch = Diff.createTwoFilesPatch(
                label1, label2, content1, content2, 
                '', '', 
                { context: context, ...diffOpts }
            ) || "";
            
            const lines = patch.split('\n');
            for (const line of lines) {
                if (useColor) {
                    if (line.startsWith('---') || line.startsWith('+++')) await writer.writeString(`\x1b[1m${line}\x1b[0m\n`);
                    else if (line.startsWith('@@')) await writer.writeString(`\x1b[36m${line}\x1b[0m\n`);
                    else if (line.startsWith('+')) await writer.writeString(`\x1b[32m${line}\x1b[0m\n`);
                    else if (line.startsWith('-')) await writer.writeString(`\x1b[31m${line}\x1b[0m\n`);
                    else await writer.writeString(`${line}\n`);
                } else {
                    await writer.writeString(`${line}\n`);
                }
            }
            // 🌟 Fix: changesガード
            const changes = Diff.diffLines(content1, content2, diffOpts) || [];
            return changes.some((p: any) => p.added || p.removed) ? 1 : 0;

        } else {
            // --- Normal Format (Default) ---
            const changes = Diff.diffLines(content1, content2, diffOpts) || [];
            
            if (!changes.some((p: any) => p.added || p.removed)) {
                if (isReportIdentical) await writer.writeString(`Files ${label1} and ${label2} are identical\n`);
                return 0;
            }

            let line1 = 1;
            let line2 = 1;

            for (let i = 0; i < changes.length; i++) {
                const change: any = changes[i]; // 🌟 Fix: anyキャスト
                const count = change.count || 0;

                if (!change.added && !change.removed) {
                    line1 += count;
                    line2 += count;
                } else {
                    const nextChange: any = changes[i + 1];
                    
                    if (change.removed && nextChange && nextChange.added) {
                        const delCount = count;
                        const addCount = nextChange.count || 0;
                        
                        const range1 = (delCount === 1) ? `${line1}` : `${line1},${line1 + delCount - 1}`;
                        const range2 = (addCount === 1) ? `${line2}` : `${line2},${line2 + addCount - 1}`;
                        await writer.writeString(`${range1}c${range2}\n`);

                        for (const l of change.value.split('\n')) {
                            if (l === '' && change.value.endsWith('\n')) continue;
                            if (useColor) await writer.writeString(`\x1b[31m< ${l}\x1b[0m\n`);
                            else await writer.writeString(`< ${l}\n`);
                        }
                        
                        await writer.writeString(`---\n`);

                        for (const l of nextChange.value.split('\n')) {
                            if (l === '' && nextChange.value.endsWith('\n')) continue;
                            if (useColor) await writer.writeString(`\x1b[32m> ${l}\x1b[0m\n`);
                            else await writer.writeString(`> ${l}\n`);
                        }

                        line1 += delCount;
                        line2 += addCount;
                        i++; 

                    } else if (change.removed) {
                        const delCount = count;
                        const range1 = (delCount === 1) ? `${line1}` : `${line1},${line1 + delCount - 1}`;
                        const range2 = (line2 > 1) ? `${line2 - 1}` : `${line2}`; 
                        
                        await writer.writeString(`${range1}d${range2}\n`);

                        for (const l of change.value.split('\n')) {
                            if (l === '' && change.value.endsWith('\n')) continue;
                            if (useColor) await writer.writeString(`\x1b[31m< ${l}\x1b[0m\n`);
                            else await writer.writeString(`< ${l}\n`);
                        }
                        line1 += delCount;

                    } else if (change.added) {
                        const addCount = count;
                        const range1 = (line1 > 1) ? `${line1 - 1}` : `${line1}`;
                        const range2 = (addCount === 1) ? `${line2}` : `${line2},${line2 + addCount - 1}`;

                        await writer.writeString(`${range1}a${range2}\n`);

                        for (const l of change.value.split('\n')) {
                            if (l === '' && change.value.endsWith('\n')) continue;
                            if (useColor) await writer.writeString(`\x1b[32m> ${l}\x1b[0m\n`);
                            else await writer.writeString(`> ${l}\n`);
                        }
                        line2 += addCount;
                    }
                }
            }
            return 1;
        }

    } catch (e: any) {
        await errWriter.writeString(`diff: ${e.message}\n`);
        return 2;
    } finally {
        await writer.close();
        await errWriter.close();
    }
}