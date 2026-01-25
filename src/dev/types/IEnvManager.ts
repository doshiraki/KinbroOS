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

/**
 * [Interface: IEnvManager]
 * 環境変数の管理機能を提供するインターフェース。
 * 値の取得、設定、削除、および一覧取得の操作を規定する。
 */
// キーの型定義 (これ以外の任意の文字列キーも許容するが、基本はこれ)
export const EnvKey = {
    Path: 'PATH',      // コマンド探索パス
    User: 'USER',      // 現在のユーザー名
    Home: 'HOME',      // ホームディレクトリ
    Term: 'TERM',      // 端末の種類 (xterm-256color等)
    Prompt: 'PS1',     // プロンプト表示形式
    Lang: 'LANG',      // 言語設定
    CWD: 'PWD'         // カレントディレクトリ
} as const;
export type EnvKeyType = typeof EnvKey[keyof typeof EnvKey] | string;

export interface IEnvManager {
    /**
     * 環境変数の値を取得する
     * @param key 環境変数名 (例: 'PATH', 'USER')
     * @returns 設定値（存在しない場合は空文字を返す規約）
     */
    get(key: EnvKeyType): string;

    /**
     * 環境変数を設定する
     * @param key 環境変数名
     * @param value 設定する値
     */
    set(key: EnvKeyType, value: string): void;

    /**
     * 環境変数を削除する
     * @param key 環境変数名
     */
    unset(key: EnvKeyType): void;

    /**
     * 現在設定されている全ての環境変数をオブジェクトとして取得する
     * (プロセス生成時の環境コピーなどに使用)
     */
    listAll(): Record<EnvKeyType, string>;

    /**
     * [New] 現在の環境変数を複製し、独立した新しいインスタンスを作成する。
     * 子プロセス生成(fork/exec)時に環境を引き継ぐために使用する。
     */
    clone(): IEnvManager;
}