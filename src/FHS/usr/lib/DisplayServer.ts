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

// src/FHS/usr/lib/DisplayServer.ts
import cssFrame from '../include/window-frame.css?inline'; // ✨ New!

/**
 * [Class: DisplayServer] (Role: Wayland Output)
 * 物理的な描画領域(Shadow DOM Host)を管理する。
 * アプリケーションやWindowManagerに対して、描画すべき「ルート」を提供する。
 */
export class DisplayServer {
    
    // 描画領域の実体
    private domHost: HTMLElement | null = null;
    private shadowRoot: ShadowRoot | null = null;
    
    private readonly ID_HOST = 'kinbro-desktop';

    private constructor() {
        // Private Constructor (Singleton Pattern)
    }

    /**
     * インスタンス取得 (Lazy Initialization)
     */
    public static getInstance(): DisplayServer {
        let instance: any;
        const win = window as any;
        for (let i = 0; i < 2; i++) {
            instance = win.KinbroDisplayServer;
            if (instance) {
                break;
            }
            win.KinbroDisplayServer = new DisplayServer();
        }
        return instance;    
    }

    /**
     * [Boot] ディスプレイ環境を初期化する
     * Shadow DOMを作成し、基本スタイル(CSS)を焼き付ける
     */
    public init(): void {
        if (this.shadowRoot) return; // 既に起動済み

        // 1. Host Element (モニター枠) の確保
        let host = document.getElementById(this.ID_HOST);
        if (!host) {
            host = document.createElement('div');
            host.id = this.ID_HOST;
            
            // 画面全体を覆う設定 (Pointer Eventsは透過)
            Object.assign(host.style, { 
                position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh', 
                zIndex: '2147483647', pointerEvents: 'none' 
            });
            document.body.appendChild(host);
        }
        this.domHost = host;

        // 2. Shadow Root (描画コンテキスト) の作成
        this.shadowRoot = host.attachShadow({ mode: 'open' });

        // 3. Global Styles (Compositor Level Styles) の注入
        // ここで注入するのは「OS全体の共通テーマ」など
        const style = document.createElement('style');
        style.textContent = `
            :host { all: initial; font-family: sans-serif; pointer-events: none; }
            .kinbro-window { pointer-events: auto; } /* ウィンドウのみ操作可能 */
            
            /* アプリケーション共通CSSもここで管理 */
            ${cssFrame}
        `;
        this.shadowRoot.appendChild(style);
        
        console.log('🖥️ [DisplayServer] Output initialized.');
    }

    /**
     * ウィンドウをマウントするためのルート要素を取得する
     */
    public getRoot(): ShadowRoot {
        if (!this.shadowRoot) {
            throw new Error('DisplayServer panic: Output not initialized.');
        }
        return this.shadowRoot;
    }

    /**
     * シャットダウン（デバッグ用・緊急停止用）
     */
    public shutdown(): void {
        if (this.domHost) {
            this.domHost.remove();
            this.domHost = null;
            this.shadowRoot = null;
        }
    }
}