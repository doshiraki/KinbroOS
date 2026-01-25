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
 * [Utility: mkdir]
 * ディレクトリを作成する。ZenFS (OPFS) のディレクトリ作成機能をラップし、
 * 標準的な UNIX 互換オプションを提供する。
 */
export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const parser = new CommandParser(args, {
        name: 'mkdir',
        usage: '[OPTION]... DIRECTORY...',
        desc: 'Create the DIRECTORY(ies), if they do not already exist.',
        options: [
            { short: 'm', long: 'mode', desc: 'set file mode (as in chmod), not a=rwx - umask', hasArg: true },
            { short: 'p', long: 'parents', desc: 'no error if existing, make parent directories as needed' },
            { short: 'v', long: 'verbose', desc: 'print a message for each created directory' },
            { long: 'help', desc: 'display this help and exit' }
        ]
    });

    const outWriter = new BinaryWriter(proc.stdout!.getByteWriter());
    const errWriter = new BinaryWriter(proc.stderr!.getByteWriter());

    try {
        // 1. ヘルプとバリデーション
        if (parser.has(undefined, 'help')) {
            await outWriter.writeString(parser.getHelp());
            return 0;
        }

        const strValidationError = parser.validate();
        if (strValidationError) {
            await errWriter.writeString(`${strValidationError}\r\n`);
            return 1;
        }

        if (parser.args.length === 0) {
            await errWriter.writeString("mkdir: missing operand\r\nTry 'mkdir --help' for more information.\r\n");
            return 1;
        }

        // 2. オプションの解析
        const isRecursive = parser.has('p', 'parents');
        const isVerbose = parser.has('v', 'verbose');
        const strMode = parser.get('mode') as string | undefined;
        let valMode: number | null = null;

        if (strMode) {
            // 8進数文字列を数値に変換 (例: "755" -> 0o755)
            valMode = parseInt(strMode, 8);
            if (isNaN(valMode)) {
                await errWriter.writeString(`mkdir: invalid mode '${strMode}'\r\n`);
                return 1;
            }
        }

        // 3. ディレクトリ作成ループ (Application Hungarian: pathTarget)
        let valExitCode = 0;
        for (const pathTarget of parser.args) {
            try {
                // ZenFS (OPFS) の mkdir 呼び出し
                await proc.fs.makeDir(pathTarget, isRecursive);

                // 詳細表示モード (-v)
                if (isVerbose) {
                    await outWriter.writeString(`mkdir: created directory '${pathTarget}'\r\n`);
                }

                // モード設定 (-m)
                // 注意: -p が指定されている場合、-m は「最後に作成されたディレクトリ」にのみ適用されるのがUNIXの伝統だよ
                if (valMode !== null) {
                    await proc.fs.chmod(pathTarget, valMode);
                }

            } catch (e: any) {
                // すでに存在している場合のエラーを -p では無視する
                if (isRecursive && e.message.includes('already exists')) {
                    continue;
                }
                await errWriter.writeString(`mkdir: cannot create directory '${pathTarget}': ${e.message}\r\n`);
                valExitCode = 1;
            }
        }

        return valExitCode;

    } finally {
        // リソース解放（私たちの美学！）
        await outWriter.close();
        await errWriter.close();
    }
}