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
 * [Tool: date]
 * 現在時刻を特定のフォーマットで表示、またはISO/RFC規格で出力する。
 */
export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const parser = new CommandParser(args, {
        name: 'date',
        usage: '[OPTION]... [+FORMAT]',
        desc: 'Display the current time in the given FORMAT.',
        options: [
            { short: 'u', long: 'utc', desc: 'print Coordinated Universal Time (UTC)' },
            { short: 'R', long: 'rfc-email', desc: 'output date and time in RFC 5322 format' },
            { short: 'I', long: 'iso-8601', desc: 'output date/time in ISO 8601 format' },
            { long: 'help', desc: 'display this help and exit' }
        ]
    });

    const errWriter = new BinaryWriter(proc.stderr!.getByteWriter());
    const writer = new BinaryWriter(proc.stdout!.getByteWriter());

    if (parser.has(undefined, 'help')) {
        await writer.writeString(parser.getHelp());
        writer.close();
        errWriter.close();
        return 0;
    }

    try {
        const isUtc = parser.has('u', 'utc');
        const isRfc = parser.has('R', 'rfc-email');
        const isoOption = parser.has('I', 'iso-8601');
        
        // +で始まる引数をカスタムフォーマットとして抽出
        const customFormat = parser.args.find(a => a.startsWith('+'))?.substring(1);

        const now = new Date();
        let output = "";

        if (isRfc) {
            // RFC 5322 形式: Mon, 14 Aug 2006 02:34:56 -0600
            output = isUtc ? now.toUTCString() : now.toString(); 
        } else if (isoOption) {
            // ISO 8601 形式: 2006-08-14
            output = isUtc ? now.toISOString().split('.')[0] + 'Z' : now.toISOString().split('.')[0];
        } else if (customFormat) {
            // %Y, %m, %d などの識別子を置換
            output = formatTime(now, customFormat, isUtc);
        } else {
            // デフォルト表示
            output = isUtc ? now.toUTCString() : now.toLocaleString();
        }

        await writer.writeString(output + '\n');
    } catch (e: any) {
        await errWriter.writeString(`date: ${e.message}\n`);
        return 1;
    } finally {
        // パイプラインを止めないために確実にクローズする
        writer.close();
        errWriter.close();
    }

    return 0;
}

function formatTime(date: Date, format: string, utc: boolean): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    
    const Y = utc ? date.getUTCFullYear() : date.getFullYear();
    const m = pad((utc ? date.getUTCMonth() : date.getMonth()) + 1);
    const d = pad(utc ? date.getUTCDate() : date.getDate());
    const H = pad(utc ? date.getUTCHours() : date.getHours());
    const M = pad(utc ? date.getUTCMinutes() : date.getMinutes());
    const S = pad(utc ? date.getUTCSeconds() : date.getSeconds());

    // date.txt に記載された主要な識別子をサポート
    return format
        .replace(/%%/g, '%')
        .replace(/%Y/g, String(Y))
        .replace(/%m/g, m)
        .replace(/%d/g, d)
        .replace(/%F/g, `${Y}-${m}-${d}`)
        .replace(/%H/g, H)
        .replace(/%M/g, M)
        .replace(/%S/g, S)
        .replace(/%T/g, `${H}:${M}:${S}`);
}
