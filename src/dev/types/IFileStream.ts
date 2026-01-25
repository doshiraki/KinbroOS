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

// src/dev/types/IFileStream.ts
import type { Stats } from '@zenfs/core';


export interface IFileStreamResult {
    /** 実際に読み込まれたバイト数 */
    cntRead: number;
    /** * ユーザーバッファ上の、今回書き込まれた領域へのビュー (SubArray)。
     * メモリコピーではなく、attachされたバッファへの参照を返す。
     */
    data: Uint8Array;
}

/**
 * 読み込み時の挙動制御ポリシー
 */
export enum ReadPolicy {
    /**
     * Partial (Default):
     * 要求サイズに満たなくても、読み込めた分だけ返して正常終了とする。
     * (通常のファイル読み込み、テキスト処理など、ブロックを避けたい場合に適する)
     */
    Partial = 0,

    /**
     * Exact:
     * 要求サイズ分のデータが揃うまで読み込みを試みる。
     * EOF等で要求サイズを満たせなかった場合、例外(Error)を投げる。
     * (固定長ヘッダのパース、バイナリ構造体の読み込みなどに適する)
     */
    Exact = 1,
}

/**
 * ストリーム設定オプション
 */
export interface StreamConfig {
    /**
     * 読み込みポリシー (デフォルト: Partial)
     */
    readPolicy?: ReadPolicy;

    /**
     * 書き込み時の自動フラッシュ (デフォルト: false)
     * trueの場合、write() 呼び出しごとに即座にディスクへの書き出しを行う。
     * (パフォーマンスは低下するが、ログ出力などデータの即時性を優先する場合に使用する)
     */
    autoFlush?: boolean;
}

export interface IFileStream {
    /**
     * ストリームの挙動を設定する。
     * 実行中に変更することも可能。
     * @param options 設定オプション
     */
    config(options: StreamConfig): void;

    /**
     * [Read用] 読み込み先ユーザーバッファをセットする。
     * これを呼び出すと、内部のユーザーバッファカーソルは0にリセットされる。
     * バッファの一部を使いたい場合は、buffer.subarray() を渡すこと。
     * @param buffer ユーザー提供のバッファ
     */
    attach(buffer: Uint8Array): void;

    /**
     * [Read: Accumulate Mode]
     * セットされたバッファの「現在のカーソル位置」からデータを積み上げて読み込む。
     * * @param cntLength 読み込む長さ (省略時はバッファの残り領域すべて)
     * @returns 読み込み結果 { cntRead, data }
     * @throws Error バッファの残り容量が要求サイズ(または1バイト)に満たない場合 "BufferOverflow"
     */
    read(cntLength?: number): Promise<IFileStreamResult>;

    /**
     * [Write用] データを書き込む。
     * デフォルトでは内部バッファに蓄積され、溢れるか flush() 時にディスクへ書き出される。
     * autoFlush: true の場合は即座に書き出される。
     * @param data 書き込むデータ
     */
    write(data: Uint8Array): Promise<void>;

    /**
     * [Write用] バッファリングされている未書き込みデータを強制的にディスクへ書き出す。
     */
    flush(): Promise<void>;

    /**
     * ファイルの状態を取得
     */
    stat(): Promise<Stats>;

    /**
     * ストリームを閉じる。
     * 未書き込みデータがある場合は自動的に flush() が実行される。
     */
    close(): Promise<void>;
}