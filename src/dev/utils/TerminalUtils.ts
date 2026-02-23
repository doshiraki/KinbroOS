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

// Grapheme splitter (Multi-byte support)
let segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });


export const TerminalUtils = {
    /** 制御文字をキャレット表記(^C)に変換 */
    toCaret(char: string): string {
        const code = char.charCodeAt(0);
        return code < 32 ? '^' + String.fromCharCode(code + 64) : char;
    },
    
    /**
     * [Helper] Calculate string display width (Fullwidth support)
     */
    calcStrWidth(str: string): number {
        let width = 0;
        const segments = segmenter.segment(str);
        for (const segment of segments) {
            const char = segment.segment;
            const code = char.codePointAt(0)!;

            // 幅2 (Fullwidth / Wide) とする範囲を厳密に指定
            // ※ここに絵文字 (0x1F000〜) を含めないことで、絵文字を幅1として扱う
            if (
                (code >= 0x1100 && code <= 0x11FF) || // Hangul Jamo
                (code >= 0x2329 && code <= 0x232A) || // Angle Brackets
                (code >= 0x2E80 && code <= 0xA4CF) || // CJK Radicals ~ Yi Syllables (Kanji, Hiragana, Katakana, etc.)
                (code >= 0xAC00 && code <= 0xD7A3) || // Hangul Syllables
                (code >= 0xF900 && code <= 0xFAFF) || // CJK Compatibility Ideographs
                (code >= 0xFE10 && code <= 0xFE19) || // Vertical Forms
                (code >= 0xFE30 && code <= 0xFE6F) || // CJK Compatibility Forms
                (code >= 0xFF01 && code <= 0xFF60) || // Fullwidth Forms (Fullwidth Alphanumeric/Symbols)
                (code >= 0xFFE0 && code <= 0xFFE6)    // Fullwidth Symbol Variants
            ) {
                width += 2;
            } 
            else {
                // Includes ASCII, Half-width Kana, and Emojis -> width 1
                width += 1;
            }
        }
        return width;
    },

    /**
     * [Helper] Get info of the single character (Grapheme) before cursor
     */
    calcPrevGraphemeInfo(strInputBuffer: string, valCursorPos: number): { text: string, length: number, width: number } | null {
        if (valCursorPos === 0) return null;

        const strBefore = strInputBuffer.slice(0, valCursorPos);
        const segments = Array.from(segmenter.segment(strBefore));
        const lastSegment = segments[segments.length - 1];

        if (!lastSegment) return null;

        const text = lastSegment.segment;
        return {
            text: text,
            length: text.length, // 2 for Emojis
            width: this.calcStrWidth(text) // 1 for Emojis
        };
    },
    /**
     * [Helper] Get info of the single character (Grapheme) before cursor
     */
    calcNextGraphemeInfo(strInputBuffer: string, valCursorPos: number): { text: string, length: number, width: number } | null {
            if (valCursorPos >= strInputBuffer.length) return null;
    
            const strAfter = strInputBuffer.slice(valCursorPos);
            const segments = segmenter.segment(strAfter);
            const iterator = segments[Symbol.iterator]();
            const firstSegment = iterator.next().value;
    
            if (!firstSegment) return null;
    
            const text = firstSegment.segment;
            return {
                text: text,
                length: text.length, // 2 for Emojis
                width: this.calcStrWidth(text) // 1 for Emojis
            };
        }
};
